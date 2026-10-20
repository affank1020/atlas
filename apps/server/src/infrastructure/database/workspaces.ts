import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AtlasError } from '../../shared/errors.js';
import type { Workspace } from '../../workspaces/model.js';
import type { WorkspaceRepository, WorkspaceTransaction } from '../../workspaces/repository.js';

const row = (x: any): Workspace => ({ id: x.id, nodeId: x.node_id, projectId: x.project_id ?? null, name: x.name, rootPath: x.root_path, kind: x.kind, adapter: x.adapter, status: x.status, devTasks: x.dev_tasks ?? {}, createdAt: new Date(x.created_at).toISOString(), updatedAt: new Date(x.updated_at).toISOString(), ...(x.archived_at && { archivedAt: new Date(x.archived_at).toISOString() }) });
class WorkspaceReader {
    constructor(protected readonly db: Pool | PoolClient) {}
    async get(projectId: string, id: string, includeArchived = false) {
        const result = await this.db.query(
            'SELECT w.* FROM workspaces w JOIN workspace_project_links l ON l.workspace_id=w.id WHERE l.project_id=$1 AND w.id=$2 AND ($3 OR w.archived_at IS NULL)',
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
    async insert(input: { nodeId: string; projectId?: string | null; name: string; rootPath: string; kind: 'generic' | 'unity' }) {
        try {
            const result = await this.connection.query(
                'INSERT INTO workspaces(id,project_id,name,root_path,kind,adapter,node_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
                [randomUUID(), input.projectId ?? null, input.name, input.rootPath, input.kind, input.kind === 'unity' ? 'unity' : null, input.nodeId]);
            const workspace = row(result.rows[0]);
            if (input.projectId) await this.link(workspace.id, input.projectId);
            return workspace;
        } catch (error: any) {
            if (error.code === '23505') throw new AtlasError('This Node directory is already registered as an active Workspace.', 'CONFLICT');
            throw error;
        }
    }
    async link(workspaceId: string, projectId: string) {
        await this.connection.query(
            'INSERT INTO workspace_project_links(workspace_id,project_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [workspaceId, projectId]);
        await this.connection.query(
            'UPDATE workspaces SET project_id=COALESCE(project_id,$2),updated_at=now() WHERE id=$1', [workspaceId, projectId]);
    }
    async unlink(workspaceId: string, projectId: string) {
        await this.connection.query(
            'DELETE FROM workspace_project_links WHERE workspace_id=$1 AND project_id=$2', [workspaceId, projectId]);
        await this.connection.query(
            'UPDATE workspaces w SET project_id=(SELECT project_id FROM workspace_project_links WHERE workspace_id=$1 ORDER BY created_at LIMIT 1),updated_at=now() WHERE w.id=$1 AND w.project_id=$2',
            [workspaceId, projectId]);
    }
    async update(id: string, name: string | undefined, archive: boolean) {
        const result = archive
            ? await this.connection.query("UPDATE workspaces SET status='archived',archived_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [id])
            : await this.connection.query('UPDATE workspaces SET name=COALESCE($2,name),updated_at=now() WHERE id=$1 RETURNING *', [id, name]);
        return row(result.rows[0]);
    }
}
export class PostgresWorkspaceRepository extends WorkspaceReader implements WorkspaceRepository {
    constructor(private readonly pool: Pool) { super(pool); }
    async list(projectId: string, includeArchived = false) {
        return (await this.pool.query(
            'SELECT w.* FROM workspaces w JOIN workspace_project_links l ON l.workspace_id=w.id WHERE l.project_id=$1 AND ($2 OR w.archived_at IS NULL) ORDER BY w.created_at,w.id',
            [projectId, includeArchived])).rows.map(row);
    }
    async listAll(includeArchived = false, nodeId?: string) {
        return (await this.pool.query(
            'SELECT * FROM workspaces WHERE ($1 OR archived_at IS NULL) AND ($2::uuid IS NULL OR node_id=$2::uuid) ORDER BY created_at,id',
            [includeArchived, nodeId ?? null])).rows.map(row);
    }
    async connect(): Promise<WorkspaceTransaction> { return new PostgresWorkspaceTransaction(await this.pool.connect()); }
}
