import type { Pool } from 'pg';
import { AtlasError } from '../../shared/errors.js';
import type { AtlasNode, NodeCapability, HostedWorkspace } from '../../nodes/model.js';
import type { NodeRepository } from '../../nodes/repository.js';
const row = (x: any): AtlasNode => ({ id: x.id, name: x.name, status: x.status, capabilities: x.capabilities,
    lastSeen: x.last_seen ? new Date(x.last_seen).toISOString() : null, metadata: Object.fromEntries(Object.entries(x.metadata ?? {}).filter(([key]) => key !== 'session')),
    platform: x.platform, version: x.version, credentialState: x.credential_state, credentialUpdatedAt: x.credential_updated_at ? new Date(x.credential_updated_at).toISOString() : null,
    createdAt: new Date(x.created_at).toISOString(), updatedAt: new Date(x.updated_at).toISOString(), hostedWorkspaceCount: Number(x.hosted_workspace_count ?? 0) });
const select = `SELECT n.*, (SELECT count(*) FROM workspaces w JOIN projects p ON p.id=w.project_id
    WHERE w.node_id=n.id AND w.archived_at IS NULL AND p.archived_at IS NULL) AS hosted_workspace_count FROM nodes n`;
export class PostgresNodeRepository implements NodeRepository {
    constructor(private readonly pool: Pool) {}
    async registerLocal(name: string, capabilities: NodeCapability[]) {
        // Migration establishes identity. Restarts update presence, never create another machine.
        const result = await this.pool.query(`UPDATE nodes SET name=CASE WHEN name='Local Node' THEN $1 ELSE name END,
            status='online',capabilities=$2,last_seen=now(),updated_at=now() WHERE local_key='local' RETURNING *`, [name, capabilities]);
        if (!result.rowCount) throw new AtlasError('Local Node is missing. Run database migrations.', 'NODE_UNAVAILABLE');
        return row(result.rows[0]);
    }
    async registerRemote(id: string, name: string, capabilities: NodeCapability[], sessionId: string, platform?: string, version?: string) {
        const result = await this.pool.query(`UPDATE nodes SET status='online',capabilities=$2,
            last_seen=now(),platform=COALESCE($4,platform),version=COALESCE($5,version),metadata=metadata || jsonb_build_object('runtime','remote','session',$3::text),updated_at=now() WHERE id=$1 AND credential_state='active' RETURNING *`, [id, capabilities, sessionId, platform ?? null, version ?? null]);
        if (!result.rowCount) throw new AtlasError('Node credential is not active.', 'NODE_AUTH_INVALID');
        return row(result.rows[0]);
    }
    async getDefault() {
        const result = await this.pool.query(`${select} WHERE n.local_key='local'`);
        if (!result.rowCount) throw new AtlasError('Default Node is missing.', 'NODE_UNAVAILABLE');
        return row(result.rows[0]);
    }
    async touch(id: string, sessionId: string) { await this.pool.query("UPDATE nodes SET last_seen=now() WHERE id=$1 AND metadata->>'session'=$2", [id, sessionId]); }
    async list() { return (await this.pool.query(`${select} ORDER BY n.created_at,n.id`)).rows.map(row); }
    async get(id: string) {
        const result = await this.pool.query(`${select} WHERE n.id=$1`, [id]);
        if (!result.rowCount) throw new AtlasError('Node not found.', 'NOT_FOUND');
        return row(result.rows[0]);
    }
    async hostedWorkspaces(id: string): Promise<HostedWorkspace[]> {
        return (await this.pool.query(`SELECT w.id,w.project_id AS "projectId",w.name,w.kind,w.status FROM workspaces w
            JOIN projects p ON p.id=w.project_id WHERE w.node_id=$1 AND w.archived_at IS NULL AND p.archived_at IS NULL ORDER BY w.created_at,w.id`, [id])).rows;
    }
    async offline(id: string, sessionId?: string) { await this.pool.query("UPDATE nodes SET status='offline',updated_at=now() WHERE id=$1 AND ($2::text IS NULL OR metadata->>'session'=$2)", [id, sessionId ?? null]); }
}
