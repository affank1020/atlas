import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AtlasError } from '../shared/errors.js';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
/** Secrets enter only this boundary; public Node records and audit snapshots never contain them. */
export class NodeIdentity {
    disconnect: (id: string) => void = () => {};
    constructor(readonly pool: Pool) {}
    private async transaction<T>(fn: (db: PoolClient) => Promise<T>) {
        const db = await this.pool.connect();
        try { await db.query('BEGIN'); const value = await fn(db); await db.query('COMMIT'); return value; }
        catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    }
    async audit(db: Pool | PoolClient, operation: string, state: object) {
        await db.query(`INSERT INTO audit_events(id,client,operation,after_state,created_at) VALUES(gen_random_uuid(),'atlas-node',$1,$2,now())`, [operation, state]);
    }
    async ticket(nodeId?: string, rotate = false) {
        const token = secret();
        const result = await this.transaction(async db => {
            if (nodeId) {
                const node = await db.query('SELECT * FROM nodes WHERE id=$1 FOR UPDATE', [nodeId]);
                if (!node.rowCount) throw new AtlasError('Node not found.', 'NOT_FOUND');
                if (!rotate && node.rows[0].credential_state !== 'unenrolled') throw new AtlasError('Use explicit credential rotation for enrolled Nodes.', 'CONFLICT');
                await db.query("UPDATE nodes SET credential_hash=NULL,credential_state='pending',credential_updated_at=now(),updated_at=now() WHERE id=$1", [nodeId]);
                await db.query('UPDATE node_enrolments SET used_at=now() WHERE node_id=$1 AND used_at IS NULL', [nodeId]);
            }
            const ticket = await db.query("INSERT INTO node_enrolments(token_hash,node_id,expires_at) VALUES($1,$2,now()+interval '10 minutes') RETURNING expires_at", [hash(token), nodeId ?? null]);
            await this.audit(db, rotate ? 'node.credential_rotated' : 'node.enrolment_created', { nodeId: nodeId ?? null });
            return { enrolmentToken: token, expiresAt: ticket.rows[0].expires_at, nodeId: nodeId ?? null };
        });
        if (nodeId) this.disconnect(nodeId);
        return result;
    }
    async enrol(input: { token: string; name: string; platform: string; version?: string }) {
        return this.transaction(async db => {
            const found = await db.query('SELECT * FROM node_enrolments WHERE token_hash=$1 FOR UPDATE', [hash(input.token)]);
            const ticket = found.rows[0];
            if (!ticket) throw new AtlasError('Invalid enrolment token.', 'ENROLMENT_INVALID');
            if (ticket.used_at) throw new AtlasError('Enrolment token already used.', 'ENROLMENT_USED');
            if (new Date(ticket.expires_at).getTime() <= Date.now()) throw new AtlasError('Enrolment token expired.', 'ENROLMENT_EXPIRED');
            const id = ticket.node_id ?? randomUUID(), credential = secret();
            if (!ticket.node_id) await db.query("INSERT INTO nodes(id,name,status) VALUES($1,$2,'offline')", [id, input.name]);
            await db.query(`UPDATE nodes SET platform=$2,version=$3,credential_hash=$4,credential_state='active',credential_updated_at=now(),updated_at=now(),metadata=metadata || '{"runtime":"remote"}'::jsonb WHERE id=$1`, [id, input.platform, input.version ?? null, hash(credential)]);
            await db.query('UPDATE node_enrolments SET used_at=now() WHERE id=$1', [ticket.id]);
            await this.audit(db, 'node.enrolled', { nodeId: id });
            return { nodeId: id, credential };
        });
    }
    async authenticate(id: string, token: string) {
        const result = await this.pool.query('SELECT credential_state,credential_hash FROM nodes WHERE id=$1', [id]);
        const node = result.rows[0];
        if (node?.credential_state === 'revoked') throw new AtlasError('Node credential revoked.', 'NODE_REVOKED');
        if (!node || node.credential_state !== 'active' || node.credential_hash !== hash(token)) throw new AtlasError('Invalid Node identity or credential.', 'NODE_AUTH_INVALID');
    }
    async revoke(id: string) {
        await this.transaction(async db => {
            const result = await db.query("UPDATE nodes SET credential_hash=NULL,credential_state='revoked',credential_updated_at=now(),updated_at=now() WHERE id=$1 RETURNING id", [id]);
            if (!result.rowCount) throw new AtlasError('Node not found.', 'NOT_FOUND');
            await db.query('UPDATE node_enrolments SET used_at=now() WHERE node_id=$1 AND used_at IS NULL', [id]);
            await this.audit(db, 'node.credential_revoked', { nodeId: id });
        });
        this.disconnect(id);
        return { nodeId: id, credentialState: 'revoked' };
    }
    async update(id: string, name: string) {
        return this.transaction(async db => {
            const result = await db.query('UPDATE nodes SET name=$2,updated_at=now() WHERE id=$1 RETURNING id', [id, name]);
            if (!result.rowCount) throw new AtlasError('Node not found.', 'NOT_FOUND');
            await this.audit(db, 'node.updated', { nodeId: id, name });
            return { nodeId: id, name };
        });
    }
    async assign(input: {nodeId: string; workspaceId: string; projectId: string; expectedNodeId: string}) {
        return this.transaction(async db => {
            const node = await db.query("SELECT id FROM nodes WHERE id=$1 AND credential_state='active' FOR SHARE", [input.nodeId]);
            if (!node.rowCount) throw new AtlasError('Target Node does not exist or has no active credential.', 'NODE_UNAVAILABLE');
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.workspaceId]);
            const result = await db.query(`UPDATE workspaces w SET node_id=$1,updated_at=now() WHERE w.id=$2 AND w.project_id=$3 AND w.node_id=$4 AND w.archived_at IS NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.id=w.project_id AND p.archived_at IS NULL) RETURNING w.id`, [input.nodeId,input.workspaceId,input.projectId,input.expectedNodeId]);
            if (!result.rowCount) throw new AtlasError('Workspace missing or placement changed. Refresh and retry.', 'CONFLICT');
            await this.audit(db, 'workspace.node_assigned', { ...input, previousNodeId: input.expectedNodeId });
            return { workspaceId: input.workspaceId, nodeId: input.nodeId };
        });
    }
    async activity(id: string) { return (await this.pool.query("SELECT operation,created_at AS \"createdAt\",after_state AS details FROM audit_events WHERE after_state->>'nodeId'=$1 OR after_state->>'previousNodeId'=$1 ORDER BY created_at DESC LIMIT 20", [id])).rows; }
}
