import type { Pool, PoolClient } from 'pg';
import { AtlasError } from '../shared/errors.js';
import { toolAuditOrigin } from './audit-origin.js';

export type NodeShareApproval = { sourceNodeId: string; targetNodeId: string; origin: 'managed' | 'environment' };
/** Assigned by the transport, never parsed from a tool argument or request header. */
export type ShareAuditClient = 'atlas-http' | 'atlas-mcp' | 'atlas-server';

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

    /**
     * Offline shares require BOTH Node credentials to remain active, including
     * for environment-managed grants. Check credentials and directional policy
     * in the same SQL snapshot, with no nested pool checkout when a transaction
     * client is supplied by enqueue().
     *
     * A managed grant is locked by a transactional caller so revocation cannot
     * overtake admission between checking the policy and committing the item.
     * For nontransactional list/read the statement is a point-in-time check.
     */
    async allowedForInbox(source: string, target: string, client?: PoolClient): Promise<boolean> {
        const from = source.toLowerCase(), to = target.toLowerCase();
        if (from === to) return false;
        const db = client ?? this.pool;
        const environmentGranted = this.environmentPairs.has(this.key(from, to));
        // One statement snapshot for identity + grants on ordinary reads.
        const authorised = await db.query(`
            SELECT 1 FROM nodes sender CROSS JOIN nodes receiver
            WHERE sender.id=$1 AND receiver.id=$2
              AND sender.credential_state='active'
              AND receiver.credential_state='active'
              AND ($3::boolean OR EXISTS (
                  SELECT 1 FROM node_share_approvals
                  WHERE source_node_id=$1 AND target_node_id=$2
              ))
        `, [from, to, environmentGranted]);
        if (!authorised.rowCount) return false;
        if (environmentGranted || !client) return true;
        // In an enqueue transaction also hold the managed grant row through
        // COMMIT, preventing revocation between this check and storage.
        const grant = await client.query(`
            SELECT 1 FROM node_share_approvals
            WHERE source_node_id=$1 AND target_node_id=$2 FOR SHARE
        `, [from, to]);
        return (grant.rowCount ?? 0) > 0;
    }

    /** Used only after Node socket auth. Never enumerate all configured pairs to a device. */
    async targetsFor(sourceId: string): Promise<Set<string>> {
        const source = sourceId.toLowerCase();
        const result = await this.pool.query(
            'SELECT target_node_id FROM node_share_approvals WHERE source_node_id=$1 LIMIT 65', [source]);
        const targets = new Set<string>();
        for (const row of result.rows) targets.add(String(row.target_node_id).toLowerCase());
        for (const pair of this.environmentPairs) {
            const [from, target] = pair.split(':');
            if (from === source && target) targets.add(target);
        }
        if (targets.size > 64) throw new AtlasError('Recipient directory is unavailable.', 'SHARE_UNAVAILABLE');
        return targets;
    }

    async list(): Promise<NodeShareApproval[]> {
        const result = await this.pool.query(
            'SELECT source_node_id, target_node_id FROM node_share_approvals ORDER BY source_node_id,target_node_id');
        // A pair may have two independently effective permissions. Keep both
        // visible: an environment overlay must never conceal a managed grant.
        const entries: NodeShareApproval[] = result.rows.map(row => ({
            sourceNodeId: String(row.source_node_id), targetNodeId: String(row.target_node_id), origin: 'managed',
        }));
        for (const pair of this.environmentPairs) {
            const [sourceNodeId, targetNodeId] = pair.split(':');
            entries.push({ sourceNodeId: sourceNodeId!, targetNodeId: targetNodeId!, origin: 'environment' });
        }
        return entries.sort((a, b) =>
            this.key(a.sourceNodeId, a.targetNodeId).localeCompare(this.key(b.sourceNodeId, b.targetNodeId))
            || a.origin.localeCompare(b.origin));
    }

    async update(input: {sourceNodeId: string; targetNodeId: string; enabled: boolean}, caller: ShareAuditClient = 'atlas-server') {
        const sourceNodeId = input.sourceNodeId.toLowerCase(), targetNodeId = input.targetNodeId.toLowerCase();
        if (sourceNodeId === targetNodeId) throw new AtlasError('A Node cannot share with itself.', 'SHARE_DENIED');
        const environmentGranted = this.environmentPairs.has(this.key(sourceNodeId, targetNodeId));
        if (environmentGranted && input.enabled)
            throw new AtlasError('This pair is already approved by ATLAS_DEVICE_SHARE_PAIRS.', 'SHARE_ENV_MANAGED');
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
                const removed = await db.query(
                    'DELETE FROM node_share_approvals WHERE source_node_id=$1 AND target_node_id=$2 RETURNING source_node_id',
                    [sourceNodeId, targetNodeId]);
                if (environmentGranted && !removed.rowCount)
                    throw new AtlasError('Only the server environment grants this pair; remove that setting and restart the Server.', 'SHARE_ENV_MANAGED');
            }
            // Only UUIDs and trusted transport provenance, never shared
            // content or an unverified human operator identity.
            const origin = toolAuditOrigin(caller);
            await db.query(`INSERT INTO audit_events(id,client,operation,after_state,created_at)
                VALUES(gen_random_uuid(),$1,$2,$3,now())`, [
                origin.client,
                input.enabled ? 'node.share.approved' : 'node.share.revoked',
                { sourceNodeId, targetNodeId, transport: origin.transport, actorKind: origin.actorKind },
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
