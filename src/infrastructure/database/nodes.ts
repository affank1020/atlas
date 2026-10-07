import type { Pool } from 'pg';
import { AtlasError } from '../../shared/errors.js';
import type { AtlasNode, NodeCapability, HostedWorkspace } from '../../nodes/model.js';
import type { NodeRepository } from '../../nodes/repository.js';
const row = (x: any): AtlasNode => ({ id: x.id, name: x.name, status: x.status, capabilities: x.capabilities,
    lastSeen: x.last_seen ? new Date(x.last_seen).toISOString() : null, metadata: x.metadata,
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
    async offline(id: string) { await this.pool.query("UPDATE nodes SET status='offline',updated_at=now() WHERE id=$1", [id]); }
}
