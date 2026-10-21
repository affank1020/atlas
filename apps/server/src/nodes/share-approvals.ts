import type { Pool } from 'pg';
import { AtlasError } from '../shared/errors.js';

export type NodeShareApproval = { sourceNodeId: string; targetNodeId: string; origin: 'managed' | 'environment' };

/** DB grants are checked per send; legacy environment grants are immutable in the UI. */
export class NodeShareApprovals {
    constructor(private readonly pool: Pool, private readonly environmentPairs: ReadonlySet<string> = new Set()) {}
    private key(source: string, target: string) { return source.toLowerCase() + ':' + target.toLowerCase(); }

    async allowed(source: string, target: string): Promise<boolean> {
        if (source.toLowerCase() === target.toLowerCase()) return false;
        if (this.environmentPairs.has(this.key(source, target))) return true;
        const result = await this.pool.query(
            'SELECT 1 FROM node_share_approvals WHERE source_node_id=$1 AND target_node_id=$2', [source, target]);
        return (result.rowCount ?? 0) > 0;
    }

    async list(): Promise<NodeShareApproval[]> {
        const result = await this.pool.query(
            'SELECT source_node_id, target_node_id FROM node_share_approvals ORDER BY source_node_id,target_node_id');
        const entries = new Map<string, NodeShareApproval>();
        for (const row of result.rows) {
            const sourceNodeId = String(row.source_node_id), targetNodeId = String(row.target_node_id);
            entries.set(this.key(sourceNodeId, targetNodeId), { sourceNodeId, targetNodeId, origin: 'managed' });
        }
        for (const pair of this.environmentPairs) {
            const [sourceNodeId, targetNodeId] = pair.split(':');
            entries.set(pair, { sourceNodeId: sourceNodeId!, targetNodeId: targetNodeId!, origin: 'environment' });
        }
        return [...entries.values()].sort((a, b) =>
            this.key(a.sourceNodeId, a.targetNodeId).localeCompare(this.key(b.sourceNodeId, b.targetNodeId)));
    }

    async update(input: {sourceNodeId: string; targetNodeId: string; enabled: boolean}) {
        const sourceNodeId = input.sourceNodeId.toLowerCase(), targetNodeId = input.targetNodeId.toLowerCase();
        if (sourceNodeId === targetNodeId) throw new AtlasError('A Node cannot share with itself.', 'SHARE_DENIED');
        if (this.environmentPairs.has(this.key(sourceNodeId, targetNodeId)))
            throw new AtlasError('This approval is managed through ATLAS_DEVICE_SHARE_PAIRS.', 'SHARE_ENV_MANAGED');
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            // Serialize grants to enforce the bounded global allowlist.
            await db.query('SELECT pg_advisory_xact_lock($1)', [325783]);
            if (input.enabled) {
                const peers = await db.query(
                    "SELECT id FROM nodes WHERE id IN ($1,$2) AND credential_state='active' FOR SHARE",
                    [sourceNodeId, targetNodeId]);
                if (peers.rowCount !== 2)
                    throw new AtlasError('Both Nodes must have active credentials.', 'SHARE_DENIED');
                const exists = await db.query(
                    'SELECT 1 FROM node_share_approvals WHERE source_node_id=$1 AND target_node_id=$2',
                    [sourceNodeId, targetNodeId]);
                if (!exists.rowCount) {
                    const count = await db.query('SELECT count(*)::int AS total FROM node_share_approvals');
                    if (Number(count.rows[0].total) + this.environmentPairs.size >= 64)
                        throw new AtlasError('Share approvals are limited to 64 directional pairs.', 'SHARE_LIMIT');
                    await db.query(
                        'INSERT INTO node_share_approvals(source_node_id,target_node_id) VALUES($1,$2)',
                        [sourceNodeId, targetNodeId]);
                }
            } else {
                await db.query('DELETE FROM node_share_approvals WHERE source_node_id=$1 AND target_node_id=$2',
                    [sourceNodeId, targetNodeId]);
            }
            // Only UUIDs in the audit trail, never shared content.
            await db.query(`INSERT INTO audit_events(id,client,operation,after_state,created_at)
                VALUES(gen_random_uuid(),'atlas-web',$1,$2,now())`, [
                input.enabled ? 'node.share.approved' : 'node.share.revoked',
                { sourceNodeId, targetNodeId },
            ]);
            await db.query('COMMIT');
            return { sourceNodeId, targetNodeId, enabled: input.enabled };
        } catch (error) {
            await db.query('ROLLBACK');
            throw error;
        } finally {
            db.release();
        }
    }
}
