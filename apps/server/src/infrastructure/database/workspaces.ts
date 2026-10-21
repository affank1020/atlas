import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AtlasError } from '../../shared/errors.js';
import type { Workspace } from '../../workspaces/model.js';
import type { LogicalWorkspace } from '@atlas/protocol/workspace';
import type { WorkspaceRepository, WorkspaceTransaction } from '../../workspaces/repository.js';

const row = (x: any): Workspace => ({ id: x.id, logicalWorkspaceId: x.logical_workspace_id, nodeId: x.node_id, projectId: x.project_id ?? null, name: x.name, rootPath: x.root_path, kind: x.kind, adapter: x.adapter, status: x.status, devTasks: x.dev_tasks ?? {}, createdAt: new Date(x.created_at).toISOString(), updatedAt: new Date(x.updated_at).toISOString(), ...(x.archived_at && { archivedAt: new Date(x.archived_at).toISOString() }) });
class WorkspaceReader {
    constructor(protected readonly db: Pool | PoolClient) {}
    async get(projectId: string, id: string, includeArchived = false) {
        const result = await this.db.query(
            'SELECT w.* FROM workspaces w JOIN logical_workspace_project_links l ON l.logical_workspace_id=w.logical_workspace_id WHERE l.project_id=$1 AND w.id=$2 AND ($3 OR w.archived_at IS NULL)',
            [projectId, id, includeArchived]);
        if (!result.rowCount) throw new AtlasError('Workspace not found in this project.', 'NOT_FOUND');
        return row(result.rows[0]);
    }
    async getById(id: string, includeArchived = false) {
        const result = await this.db.query(
            'SELECT * FROM workspaces WHERE id=$1 AND ($2 OR archived_at IS NULL)', [id, includeArchived]);
        if (!result.rowCount) throw new AtlasError('Workspace not found.', 'NOT_FOUND');
        return row(result.rows[0]);
    }
    async audit(workspace: Workspace, operation: string, client: string | undefined, metadata: unknown) {
        await this.db.query('INSERT INTO audit_events(id,client,operation,project_id,workspace_id,after_state,created_at) VALUES($1,$2,$3,$4,$5,$6,now())',
            [randomUUID(), client || 'unknown-client', operation, workspace.projectId, workspace.id, { workspaceName: workspace.name, ...(metadata as Record<string, unknown>) }]);
    }
}
class PostgresWorkspaceTransaction extends WorkspaceReader implements WorkspaceTransaction {
    constructor(private readonly connection: PoolClient) { super(connection); }
    async begin() { await this.connection.query('BEGIN'); }
    async commit() { await this.connection.query('COMMIT'); }
    async rollback() { await this.connection.query('ROLLBACK'); }
    release() { this.connection.release(); }
    async requireActiveProject(projectId: string, lock = false) {
        const result = await this.connection.query(`SELECT id FROM projects WHERE id=$1 AND archived_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [projectId]);
        if (!result.rowCount) throw new AtlasError('Project is archived.', 'NOT_FOUND');
    }
    async lockWorkspace(id: string) { await this.connection.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE', [id]); }
    async lockExecution(binding: string) { await this.connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [binding]); }
    async managedWorktreeBranch(workspaceId: string, sourceWorkspaceId: string, rootPath: string): Promise<string | null> {
        // Only a successful Atlas-managed worktree creation can authorise deletion.
        // Read under the same DB transaction/Workspace lock used for the removal.
        const result = await this.connection.query(
            `SELECT after_state->>'branch' AS branch FROM audit_events
             WHERE workspace_id=$1 AND operation='workspace.created'
               AND after_state->>'managedKind'='git_worktree'
               AND after_state->>'sourceWorkspaceId'=$2
               AND after_state->>'rootPath'=$3
             LIMIT 1`,
            [workspaceId, sourceWorkspaceId, rootPath],
        );
        return result.rows[0]?.branch ?? null;
    }
    /** Repository identity is derived from a verified Git origin, never a
     * user-supplied name or a matching path. Scoped by the unique repo index. */
    private async repositoryIdentity(repository: string, displayName: string) {
        const candidate = randomUUID();
        await this.connection.query(
            `INSERT INTO logical_workspaces(id,name,repository,kind)
             VALUES($1,$2,$3,'git') ON CONFLICT DO NOTHING`,
            [candidate, displayName, repository.toLowerCase()]);
        const found = await this.connection.query(
            'SELECT id FROM logical_workspaces WHERE lower(repository)=$1',
            [repository.toLowerCase()]);
        if (!found.rowCount) throw new AtlasError('Unable to resolve repository identity.', 'CONFLICT');
        return found.rows[0].id as string;
    }
    async attachRepository(workspaceId: string, repository: string): Promise<Workspace> {
        const source = await this.getById(workspaceId);
        // Caller has verified the bound Node's Git origin. A provisional local
        // group can contain only Atlas-managed worktree descendants of its
        // original checkout: those checkouts share one Git common directory.
        // Migrate the WHOLE local group, including archived siblings, so that
        // recognising the parent never strands already-created feature trees.
        const previous = await this.connection.query(
            'SELECT kind FROM logical_workspaces WHERE id=$1 FOR UPDATE', [source.logicalWorkspaceId]);
        if (!previous.rowCount)
            throw new AtlasError('Logical Workspace was not found.', 'CONFLICT');
        // Existing repository identity cannot be silently changed: its Project
        // associations may cover several independent clones and must not leak
        // into a different repository following an origin rewrite.
        if (previous.rows[0].kind === 'git') {
            const existing = await this.connection.query(
                'SELECT repository FROM logical_workspaces WHERE id=$1',
                [source.logicalWorkspaceId]);
            if (existing.rows[0]?.repository?.toLowerCase() !== repository.toLowerCase())
                throw new AtlasError('Git origin changed; register a new checkout identity before associating Projects.', 'CONFLICT');
        }
        const logicalId = await this.repositoryIdentity(repository, source.name);
        // Preserve every Project association before the provisional group is
        // removed. The destination takes the union (e.g. Mac + Linux Projects).
        await this.connection.query(
            `INSERT INTO logical_workspace_project_links(logical_workspace_id,project_id)
             SELECT $2,project_id FROM logical_workspace_project_links
             WHERE logical_workspace_id=$1 ON CONFLICT DO NOTHING`,
            [source.logicalWorkspaceId, logicalId]);
        if (previous.rows[0].kind === 'local') {
            await this.connection.query(
                'UPDATE workspaces SET logical_workspace_id=$2,updated_at=now() WHERE logical_workspace_id=$1',
                [source.logicalWorkspaceId, logicalId]);
        } else {
            // A Git-backed group can contain other independent clones. Never
            // reassign those based solely on this one checkout's origin.
            await this.connection.query(
                'UPDATE workspaces SET logical_workspace_id=$2,updated_at=now() WHERE id=$1',
                [workspaceId, logicalId]);
        }
        await this.syncLogicalProjects(logicalId);
        // Remove a provisional identity only after its last checkout moves.
        await this.connection.query(
            `DELETE FROM logical_workspaces WHERE id=$1 AND kind='local'
             AND NOT EXISTS (SELECT 1 FROM workspaces WHERE logical_workspace_id=$1)`,
            [source.logicalWorkspaceId]);
        return this.getById(workspaceId);
    }
    async insert(input: { nodeId: string; projectId?: string | null; name: string; rootPath: string; kind: 'generic' | 'unity'; logicalWorkspaceId?: string; repository?: string }) {
        try {
            let logicalId = input.logicalWorkspaceId;
            if (!logicalId && input.repository)
                logicalId = await this.repositoryIdentity(input.repository, input.name);
            if (!logicalId) {
                logicalId = randomUUID();
                await this.connection.query('INSERT INTO logical_workspaces(id,name) VALUES($1,$2)', [logicalId, input.name]);
            }
            const result = await this.connection.query(
                'INSERT INTO workspaces(id,project_id,name,root_path,kind,adapter,node_id,logical_workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
                [randomUUID(), input.projectId ?? null, input.name, input.rootPath, input.kind,
                    input.kind === 'unity' ? 'unity' : null, input.nodeId, logicalId]);
            const workspace = row(result.rows[0]);
            if (input.projectId) await this.linkLogical(logicalId, input.projectId);
            else await this.syncLogicalProjects(logicalId);
            return this.getById(workspace.id);
        } catch (error: any) {
            if (error.code === '23505') throw new AtlasError('This Node directory is already registered as an active Workspace.', 'CONFLICT');
            throw error;
        }
    }
    /** Keep the checkout-era join table and primary Project column in sync
     * during the rolling API migration. Logical links are authoritative. */
    private async syncLogicalProjects(logicalWorkspaceId: string) {
        await this.connection.query(
            `INSERT INTO workspace_project_links(workspace_id,project_id)
             SELECT w.id,lp.project_id
             FROM workspaces w JOIN logical_workspace_project_links lp
               ON lp.logical_workspace_id=w.logical_workspace_id
             WHERE w.logical_workspace_id=$1 ON CONFLICT DO NOTHING`,
            [logicalWorkspaceId]);
        await this.connection.query(
            `DELETE FROM workspace_project_links p USING workspaces w
             WHERE p.workspace_id=w.id AND w.logical_workspace_id=$1
               AND NOT EXISTS (SELECT 1 FROM logical_workspace_project_links lp
                               WHERE lp.logical_workspace_id=$1 AND lp.project_id=p.project_id)`,
            [logicalWorkspaceId]);
        await this.connection.query(
            `UPDATE workspaces w SET project_id=(
                 SELECT lp.project_id FROM logical_workspace_project_links lp
                 WHERE lp.logical_workspace_id=$1
                 ORDER BY (lp.project_id=w.project_id) DESC,lp.created_at,lp.project_id LIMIT 1
             ),updated_at=now()
             WHERE w.logical_workspace_id=$1 AND w.project_id IS DISTINCT FROM (
                 SELECT lp.project_id FROM logical_workspace_project_links lp
                 WHERE lp.logical_workspace_id=$1
                 ORDER BY (lp.project_id=w.project_id) DESC,lp.created_at,lp.project_id LIMIT 1
             )`,
            [logicalWorkspaceId]);
    }
    async linkLogical(logicalWorkspaceId: string, projectId: string) {
        await this.connection.query(
            `INSERT INTO logical_workspace_project_links(logical_workspace_id,project_id)
             VALUES($1,$2) ON CONFLICT DO NOTHING`,
            [logicalWorkspaceId,projectId]);
        await this.syncLogicalProjects(logicalWorkspaceId);
    }
    async unlinkLogical(logicalWorkspaceId: string, projectId: string) {
        await this.connection.query(
            'DELETE FROM logical_workspace_project_links WHERE logical_workspace_id=$1 AND project_id=$2',
            [logicalWorkspaceId,projectId]);
        await this.syncLogicalProjects(logicalWorkspaceId);
    }
    // Compatibility endpoints now modify the logical Workspace that owns the
    // selected checkout, rather than a particular Node's directory.
    async link(workspaceId: string, projectId: string) {
        const checkout = await this.getById(workspaceId);
        await this.linkLogical(checkout.logicalWorkspaceId!, projectId);
    }
    async unlink(workspaceId: string, projectId: string) {
        const checkout = await this.getById(workspaceId);
        await this.unlinkLogical(checkout.logicalWorkspaceId!, projectId);
    }
    async update(id: string, name: string | undefined, archive: boolean) {
        const result = archive
            ? await this.connection.query("UPDATE workspaces SET status='archived',archived_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [id])
            : await this.connection.query('UPDATE workspaces SET name=COALESCE($2,name),updated_at=now() WHERE id=$1 RETURNING *', [id, name]);
        const changed = row(result.rows[0]);
        if (!archive && name !== undefined) {
            // The browser hides archived checkouts by default. A local
            // Workspace with exactly one ACTIVE checkout must keep its
            // logical display name in sync, even with archived history.
            // A multi-active-checkout group or Git repository needs a
            // separate logical rename action.
            await this.connection.query(
                `UPDATE logical_workspaces l SET name=$2,updated_at=now()
                 WHERE l.id=$1 AND l.kind='local'
                   AND (SELECT count(*) FROM workspaces w
                        WHERE w.logical_workspace_id=l.id
                          AND w.archived_at IS NULL)=1`,
                [changed.logicalWorkspaceId, name]);
        }
        return changed;
    }
}
export class PostgresWorkspaceRepository extends WorkspaceReader implements WorkspaceRepository {
    constructor(private readonly pool: Pool) { super(pool); }
    async list(projectId: string, includeArchived = false) {
        return (await this.pool.query(
            'SELECT w.* FROM workspaces w JOIN logical_workspace_project_links l ON l.logical_workspace_id=w.logical_workspace_id WHERE l.project_id=$1 AND ($2 OR w.archived_at IS NULL) ORDER BY w.created_at,w.id',
            [projectId, includeArchived])).rows.map(row);
    }
    async listAll(includeArchived = false, nodeId?: string) {
        return (await this.pool.query(
            'SELECT * FROM workspaces WHERE ($1 OR archived_at IS NULL) AND ($2::uuid IS NULL OR node_id=$2::uuid) ORDER BY created_at,id',
            [includeArchived, nodeId ?? null])).rows.map(row);
    }
    async listLogical(includeArchived = false): Promise<LogicalWorkspace[]> {
        const result = await this.pool.query(
            `SELECT l.id AS logical_id, l.name AS logical_name,
                    l.repository AS logical_repository, l.kind AS logical_kind,
                    l.created_at AS logical_created_at, l.updated_at AS logical_updated_at,
                    ARRAY(SELECT project_id FROM logical_workspace_project_links lp
                          WHERE lp.logical_workspace_id=l.id ORDER BY lp.project_id) AS logical_project_ids,
                    w.*
             FROM logical_workspaces l
             JOIN workspaces w ON w.logical_workspace_id=l.id
             WHERE ($1 OR w.archived_at IS NULL)
             ORDER BY l.created_at, l.id, w.created_at, w.id`, [includeArchived]);
        const groups = new Map<string, LogicalWorkspace>();
        for (const record of result.rows) {
            let entry = groups.get(record.logical_id);
            if (!entry) {
                entry = {
                    id: record.logical_id, name: record.logical_name,
                    repository: record.logical_repository, kind: record.logical_kind,
                    projectIds: record.logical_project_ids,
                    createdAt: new Date(record.logical_created_at).toISOString(),
                    updatedAt: new Date(record.logical_updated_at).toISOString(),
                    checkouts: [],
                };
                groups.set(entry.id, entry);
            }
            entry.checkouts.push(row(record));
        }
        return [...groups.values()];
    }
    async connect(): Promise<WorkspaceTransaction> { return new PostgresWorkspaceTransaction(await this.pool.connect()); }
}
