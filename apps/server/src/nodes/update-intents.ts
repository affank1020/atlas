import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AtlasError } from '../shared/errors.js';
import type { NodeRelease } from './releases.js';

/**
 * Durable, expiring *intent only*. Nothing consumes this table to update a
 * Node. An intent is neither a privileged host approval nor execution proof.
 */
export type NodeUpdateIntent = {
    id: string; nodeId: string;
    installedVersion: string; targetVersion: string;
    targetCommit: string; targetSourceCommit: string; targetSha256: string;
    status: 'requested' | 'cancelled' | 'expired' | 'claimed';
    createdAt: string; expiresAt: string; resolvedAt: string | null;
    approved: false; executable: false;
};

type Row = {
    id: string; node_id: string; installed_version: string;
    target_version: string; target_commit: string; target_source_commit: string;
    target_sha256: string; status: 'requested' | 'cancelled' | 'expired' | 'claimed';
    created_at: Date; expires_at: Date; resolved_at: Date | null;
};

const present = (row: Row): NodeUpdateIntent => ({
    id: row.id, nodeId: row.node_id,
    installedVersion: row.installed_version, targetVersion: row.target_version,
    targetCommit: row.target_commit.trim(), targetSourceCommit: row.target_source_commit.trim(),
    targetSha256: row.target_sha256.trim(),
    status: row.status === 'requested' && new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : row.status,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    approved: false, executable: false,
});

export class NodeUpdateIntentLedger {
    constructor(private readonly db: Pool) {}

    private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            const result = await run(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    }

    private async audit(client: PoolClient, operation: string, details: Record<string, unknown>) {
        // Same central Monitoring stream as Node identity events. Actor is
        // explicitly the API transport, NOT an asserted human approval.
        await client.query(`INSERT INTO audit_events(id,client,operation,after_state,created_at)
            VALUES(gen_random_uuid(),'atlas-node-update-intent',$1,$2,now())`, [operation, details]);
    }

    async prepare(nodeId: string, expectedVersion: string, expectedCredentialUpdatedAt: string | null,
        candidate: NodeRelease): Promise<NodeUpdateIntent> {
        if (candidate.platform !== 'linux' || candidate.channel !== 'stable' ||
            candidate.provenance !== 'unverified' || candidate.protocol !== 2 ||
            !/^[0-9a-f]{40}$/.test(candidate.sourceCommit) ||
            !/^[0-9a-f]{64}$/.test(candidate.sha256) ||
            candidate.sourceCommit.slice(0, 12) !== candidate.commit)
            throw new AtlasError('Update candidate metadata is invalid.', 'INVALID_INPUT');

        return this.transaction(async client => {
            // Serialise requests with credential rotation/revocation and other
            // requests on this Node. Do not authorise execution.
            const result = await client.query(`SELECT id,platform,status,version,metadata,credential_state,credential_updated_at
                FROM nodes WHERE id=$1 FOR UPDATE`, [nodeId]);
            const node = result.rows[0];
            if (!node) throw new AtlasError('Node not found.', 'NOT_FOUND');
            const credentialAt = node.credential_updated_at ? new Date(node.credential_updated_at).toISOString() : null;
            if (node.platform !== 'linux' || node.metadata?.runtime !== 'remote' ||
                node.status !== 'online' || node.credential_state !== 'active' ||
                node.version !== expectedVersion || credentialAt !== expectedCredentialUpdatedAt)
                throw new AtlasError('Node state changed; refresh eligibility before preparing an update.', 'CONFLICT');

            await client.query(`UPDATE node_update_intents
                SET status='expired',resolved_at=now()
                WHERE node_id=$1 AND status='requested' AND expires_at<=now()`, [nodeId]);
            const duplicate = await client.query(`SELECT id FROM node_update_intents
                WHERE node_id=$1 AND status IN ('requested','claimed')`, [nodeId]);
            if (duplicate.rowCount) throw new AtlasError('An active update request already exists for this Node.', 'CONFLICT');
            const inserted = await client.query<Row>(`INSERT INTO node_update_intents
                (node_id,installed_version,target_version,target_commit,target_source_commit,target_sha256)
                VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
                [nodeId,expectedVersion,candidate.version,candidate.commit,candidate.sourceCommit,candidate.sha256]);
            const intent = present(inserted.rows[0]!);
            await this.audit(client, 'node.update_intent_prepared', {
                nodeId, intentId: intent.id, status: intent.status,
                installedVersion: expectedVersion, targetVersion: candidate.version,
                targetCommit: candidate.commit, approved: false, executable: false,
            });
            return intent;
        });
    }

    async list(nodeId: string, limit = 20): Promise<NodeUpdateIntent[]> {
        const node = await this.db.query('SELECT id FROM nodes WHERE id=$1', [nodeId]);
        if (!node.rowCount) throw new AtlasError('Node not found.', 'NOT_FOUND');
        const records = await this.db.query<Row>(`SELECT * FROM node_update_intents
            WHERE node_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`, [nodeId, Math.max(1, Math.min(limit, 50))]);
        return records.rows.map(present);
    }

    /**
     * Atomically reserve an active Node update request exactly once, using its
     * own Node credential. This is a control-plane reservation, NOT an approval
     * or permission to install/execute Node software. A separate host-root
     * approval and signed-artifact verification are still mandatory.
     *
     * Claimed requests deliberately block new prepares until a future trusted
     * reconciliation path is introduced. We fail closed after network loss:
     * clients must never replay a possibly committed claim.
     */
    async claim(nodeId: string, intentId: string, credential: string,
        expectedInstalledVersion: string, expectedSha256: string): Promise<NodeUpdateIntent> {
        if (!/^[0-9a-f]{64}$/.test(expectedSha256) ||
            !/^[0-9]+[.][0-9]+[.][0-9]+(?:[+][0-9a-f]{12})?$/.test(expectedInstalledVersion) ||
            typeof credential !== 'string' || credential.length < 32)
            throw new AtlasError('Invalid Node update claim.', 'INVALID_INPUT');
        const credentialHash = createHash('sha256').update(credential).digest('hex');
        return this.transaction(async client => {
            // Lock the credential row first: concurrent revoke/rotate and
            // claim cannot interleave. The exact same lock order is used by
            // prepare, preventing stale claims after credential rotation.
            const owner = await client.query(`SELECT id,platform,status,version,metadata,
                credential_hash,credential_state,credential_updated_at
                FROM nodes WHERE id=$1 FOR UPDATE`, [nodeId]);
            const node = owner.rows[0];
            if (!node || node.credential_state !== 'active' || node.credential_hash !== credentialHash)
                throw new AtlasError('Invalid Node identity or credential.', 'NODE_AUTH_INVALID');
            if (node.platform !== 'linux' || node.metadata?.runtime !== 'remote' ||
                node.status !== 'online' || node.version !== expectedInstalledVersion)
                throw new AtlasError('Node state changed since preparing the update.', 'CONFLICT');

            const selected = await client.query<Row>(`SELECT * FROM node_update_intents
                WHERE id=$1 AND node_id=$2 FOR UPDATE`, [intentId, nodeId]);
            const item = selected.rows[0];
            if (!item) throw new AtlasError('Node update request not found.', 'NOT_FOUND');
            // now() is frozen at BEGIN, including time spent waiting for
            // the Node/intent row locks. Test expiry with a live DB clock in
            // the *conditional UPDATE*, after both locks have been acquired.
            // An expired request can never become claimed after a lock wait.
            const result = await client.query<Row>(`UPDATE node_update_intents
                SET status='claimed',resolved_at=clock_timestamp()
                WHERE id=$1 AND node_id=$2 AND status='requested'
                  AND expires_at>clock_timestamp()
                  AND installed_version=$3 AND target_sha256=$4
                  AND created_at >= $5::timestamptz
                RETURNING *`,
                [intentId,nodeId,expectedInstalledVersion,expectedSha256,node.credential_updated_at]);
            if (!result.rowCount || item.status !== 'requested')
                throw new AtlasError('Update intent is stale, cancelled, expired or already claimed.', 'CONFLICT');
            await this.audit(client, 'node.update_intent_claimed', {
                nodeId, intentId, status: 'claimed', installedVersion: expectedInstalledVersion,
                targetCommit: item.target_commit.trim(), approved: false, executable: false,
            });
            return present(result.rows[0]!);
        });
    }

    async cancel(nodeId: string, intentId: string): Promise<NodeUpdateIntent> {
        return this.transaction(async client => {
            const result = await client.query<Row>(`SELECT * FROM node_update_intents
                WHERE id=$1 AND node_id=$2 FOR UPDATE`, [intentId, nodeId]);
            if (!result.rowCount) throw new AtlasError('Node update request not found.', 'NOT_FOUND');
            const item = result.rows[0]!;
            if (item.status !== 'requested' || new Date(item.expires_at).getTime() <= Date.now())
                throw new AtlasError('Update request is no longer active.', 'CONFLICT');
            const updated = await client.query<Row>(`UPDATE node_update_intents
                SET status='cancelled',resolved_at=now() WHERE id=$1 RETURNING *`, [intentId]);
            await this.audit(client, 'node.update_intent_cancelled', {
                nodeId, intentId, status: 'cancelled', approved: false, executable: false,
            });
            return present(updated.rows[0]!);
        });
    }
}
