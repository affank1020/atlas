import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AtlasError } from '../shared/errors.js';
import { verifyRootUpdateAttestation, type RootUpdateAttestation } from './root-evidence.js';

/**
 * Explicit trusted-operator ONLY root trust ledger.
 *
 * Deliberately NOT wired to HTTP, MCP, NodeService, Node credentials or
 * automatic background execution. Every mutator is invoked solely from the
 * separately run operator CLI, using that operator's PostgreSQL access.
 *
 * A verified signature means "key possession and matching bound bytes",
 * NOT proof of healthy execution or authority to clear a claimed intent.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

export type RootKeyPin = { nodeId: string; fingerprint: string; pinnedAt: string };
export type RootChallenge = {
    id: string; nodeId: string; intentId: string; challenge: string;
    issuedAt: string; expiresAt: string;
};
export type VerifiedRootEvidence = {
    nodeId: string; intentId: string; challengeId: string;
    fingerprint: string; activeVersion: string; observedPid: number;
    verifiedAt: string; clearsClaim: false;
};

function canonicalPublicKey(pem: string): { pem: string; fingerprint: string } {
    if (typeof pem !== 'string' || pem.length > 512 || pem.length < 80)
        throw new AtlasError('Invalid host-root public key.', 'INVALID_INPUT');
    try {
        const key = createPublicKey(pem);
        if (key.asymmetricKeyType !== 'ed25519')
            throw new Error('Wrong key algorithm.');
        const canonical = key.export({ format: 'pem', type: 'spki' }).toString();
        if (canonical !== pem) throw new Error('Noncanonical public key encoding.');
        const der = key.export({ format: 'der', type: 'spki' });
        return { pem: canonical, fingerprint: createHash('sha256').update(der).digest('hex') };
    } catch {
        throw new AtlasError('Only canonical Ed25519 SPKI PEM public keys can be pinned.', 'INVALID_INPUT');
    }
}

export function fingerprintHostRootKey(pem: string): string {
    return canonicalPublicKey(pem).fingerprint;
}

export class NodeRootTrustLedger {
    constructor(private readonly pool: Pool) {}

    private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    }

    private async audit(client: PoolClient, operation: string, details: Record<string, unknown>) {
        // Attributed to an explicit operator DB session, not a Node identity
        // or an alleged root attestation. Never include PEM, nonce, signature
        // or local filesystem paths in the monitoring stream.
        await client.query(`INSERT INTO audit_events(id,client,operation,after_state,created_at)
            VALUES(gen_random_uuid(),'atlas-node-root-operator',$1,$2,clock_timestamp())`,
        [operation, { ...details, clearsClaim: false }]);
    }

    private async lockNode(client: PoolClient, nodeId: string) {
        const found = await client.query(`SELECT id,platform,metadata,credential_state
            FROM nodes WHERE id=$1 FOR UPDATE`, [nodeId]);
        const node = found.rows[0];
        if (!node) throw new AtlasError('Node not found.', 'NOT_FOUND');
        if (node.platform !== 'linux' || node.metadata?.runtime !== 'remote' ||
            node.credential_state !== 'active')
            throw new AtlasError('Only an active remote Linux Node can hold root trust.', 'CONFLICT');
    }

    /** First key wins. No key rotation, replacement or Node enrolment path. */
    async pin(nodeId: string, publicKeyPem: string): Promise<RootKeyPin> {
        if (!UUID.test(nodeId)) throw new AtlasError('Invalid Node ID.', 'INVALID_INPUT');
        const key = canonicalPublicKey(publicKeyPem);
        return this.transaction(async client => {
            await this.lockNode(client, nodeId);
            const exists = await client.query('SELECT node_id FROM node_update_root_keys WHERE node_id=$1', [nodeId]);
            if (exists.rowCount)
                throw new AtlasError('A host-root key is already pinned. No automatic replacement.', 'CONFLICT');
            const inserted = await client.query<{ pinned_at: Date }>(`INSERT INTO node_update_root_keys
                (node_id,public_key_pem,fingerprint) VALUES($1,$2,$3) RETURNING pinned_at`,
                [nodeId,key.pem,key.fingerprint]);
            await this.audit(client, 'node.root_key_pinned', { nodeId, fingerprint:key.fingerprint });
            return { nodeId, fingerprint:key.fingerprint,
                pinnedAt: inserted.rows[0]!.pinned_at.toISOString() };
        });
    }

    /**
     * One unpredictable, 5-minute challenge per claimed intent. Expired
     * challenges are NOT replaced automatically. Reissuance needs a future
     * independently reviewed operator recovery path.
     */
    async issue(nodeId: string, intentId: string): Promise<RootChallenge> {
        if (!UUID.test(nodeId) || !UUID.test(intentId))
            throw new AtlasError('Invalid challenge identity.', 'INVALID_INPUT');
        return this.transaction(async client => {
            await this.lockNode(client, nodeId);
            const intent = await client.query(`SELECT id,status FROM node_update_intents
                WHERE id=$1 AND node_id=$2 FOR UPDATE`, [intentId,nodeId]);
            if (!intent.rowCount) throw new AtlasError('Update request not found for Node.', 'NOT_FOUND');
            if (intent.rows[0].status !== 'claimed')
                throw new AtlasError('Only claimed update requests may receive root challenges.', 'CONFLICT');
            const pinned = await client.query('SELECT fingerprint FROM node_update_root_keys WHERE node_id=$1',
                [nodeId]);
            if (!pinned.rowCount)
                throw new AtlasError('Host has no separately pinned root key.', 'CONFLICT');
            const prior = await client.query('SELECT id FROM node_update_root_challenges WHERE intent_id=$1',
                [intentId]);
            if (prior.rowCount)
                throw new AtlasError('A root challenge already exists for this intent.', 'CONFLICT');
            const nonce = randomBytes(32).toString('hex');
            // One DB timestamp for issuance and expiry, *after* obtaining locks.
            const created = await client.query<{ created: Date }>('SELECT clock_timestamp() AS created');
            const issuedAt = created.rows[0]!.created;
            const result = await client.query<{ id:string; expires_at:Date }>(`INSERT INTO node_update_root_challenges
                (intent_id,node_id,nonce,issued_at,expires_at)
                VALUES($1,$2,$3,$4::timestamptz,$4::timestamptz+interval '5 minutes')
                RETURNING id,expires_at`, [intentId,nodeId,nonce,issuedAt]);
            await this.audit(client,'node.root_challenge_issued',
                { nodeId,intentId,challengeId:result.rows[0]!.id });
            return { id:result.rows[0]!.id,nodeId,intentId,challenge:nonce,
                issuedAt:issuedAt.toISOString(),expiresAt:result.rows[0]!.expires_at.toISOString() };
        });
    }

    /**
     * Consume a matching, live challenge once after verifying the signed
     * evidence against an independently pinned root public key.
     *
     * Does NOT update node_update_intents, release pointers or Node versions.
     */
    async verify(nodeId: string, intentId: string, attestation: unknown): Promise<VerifiedRootEvidence> {
        if (!UUID.test(nodeId) || !UUID.test(intentId))
            throw new AtlasError('Invalid evidence identity.', 'INVALID_INPUT');
        return this.transaction(async client => {
            await this.lockNode(client, nodeId);
            const selected = await client.query<{status:string;target_version:string;
                target_commit:string;target_sha256:string}>(`SELECT status,target_version,target_commit,target_sha256
                FROM node_update_intents WHERE id=$1 AND node_id=$2 FOR UPDATE`,[intentId,nodeId]);
            if (!selected.rowCount) throw new AtlasError('Update request not found.', 'NOT_FOUND');
            const intent = selected.rows[0]!;
            if (intent.status !== 'claimed')
                throw new AtlasError('An unclaimed update cannot accept root evidence.', 'CONFLICT');
            const challenge = await client.query<{id:string;nonce:string;consumed_at:Date|null}>(`SELECT
                id,nonce,consumed_at FROM node_update_root_challenges
                WHERE intent_id=$1 AND node_id=$2 FOR UPDATE`, [intentId,nodeId]);
            if (!challenge.rowCount) throw new AtlasError('No root evidence challenge was issued.', 'CONFLICT');
            const nonce = challenge.rows[0]!;
            if (nonce.consumed_at)
                throw new AtlasError('Root evidence challenge already consumed.', 'CONFLICT');
            // Expiry must be checked with live wall time AFTER all lock waits.
            const valid = await client.query(`SELECT id FROM node_update_root_challenges
                WHERE id=$1 AND consumed_at IS NULL AND expires_at > clock_timestamp()`,[nonce.id]);
            if (!valid.rowCount) throw new AtlasError('Root evidence challenge expired.', 'CONFLICT');
            const key = await client.query<{public_key_pem:string;fingerprint:string}>(`SELECT
                public_key_pem,fingerprint FROM node_update_root_keys WHERE node_id=$1`,[nodeId]);
            if (!key.rowCount) throw new AtlasError('Root public key is not pinned.', 'CONFLICT');
            const expected = { nodeId,intentId,challenge:nonce.nonce.trim(),
                activeVersion:intent.target_version + '+' + intent.target_commit.trim(),
                targetSha256:intent.target_sha256.trim() };
            if (!verifyRootUpdateAttestation(attestation,key.rows[0]!.public_key_pem,expected))
                throw new AtlasError('Host-root evidence signature or target does not match.', 'CONFLICT');
            const evidence = attestation as RootUpdateAttestation;
            const consumed = await client.query(`UPDATE node_update_root_challenges
                SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL
                AND expires_at>clock_timestamp() RETURNING id`,[nonce.id]);
            if (!consumed.rowCount) throw new AtlasError('Root evidence challenge expired or consumed.', 'CONFLICT');
            const inserted = await client.query<{verified_at:Date}>(`INSERT INTO node_update_root_evidence
                (intent_id,challenge_id,node_id,key_fingerprint,active_version,target_sha256,observed_pid,signature)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING verified_at`,
                [intentId,nonce.id,nodeId,key.rows[0]!.fingerprint.trim(),expected.activeVersion,
                    expected.targetSha256,evidence.observedPid,evidence.signature]);
            await this.audit(client,'node.root_evidence_verified',{
                nodeId,intentId,challengeId:nonce.id,observedPid:evidence.observedPid,
                fingerprint:key.rows[0]!.fingerprint.trim(),
                verifiedEvidence:true,updateVerified:false,
            });
            return { nodeId,intentId,challengeId:nonce.id,
                fingerprint:key.rows[0]!.fingerprint.trim(),
                activeVersion:expected.activeVersion,observedPid:evidence.observedPid,
                verifiedAt:inserted.rows[0]!.verified_at.toISOString(),clearsClaim:false };
        });
    }

    /** Operator-only status; never return PEM, nonce or signature. */
    async status(nodeId: string, intentId: string) {
        if (!UUID.test(nodeId) || !UUID.test(intentId))
            throw new AtlasError('Invalid status identity.', 'INVALID_INPUT');
        const result = await this.pool.query(`SELECT
            k.fingerprint,k.pinned_at,c.id AS challenge_id,c.issued_at,c.expires_at,c.consumed_at,
            e.verified_at,e.active_version,i.status AS intent_status
            FROM node_update_intents i
            LEFT JOIN node_update_root_keys k ON k.node_id=i.node_id
            LEFT JOIN node_update_root_challenges c ON c.intent_id=i.id
            LEFT JOIN node_update_root_evidence e ON e.intent_id=i.id
            WHERE i.id=$1 AND i.node_id=$2`,[intentId,nodeId]);
        if (!result.rowCount) throw new AtlasError('Update request not found.', 'NOT_FOUND');
        const x = result.rows[0];
        return { nodeId,intentId,intentStatus:x.intent_status,
            pinnedFingerprint:x.fingerprint?.trim() ?? null,
            pinnedAt:x.pinned_at?.toISOString() ?? null,
            challengeId:x.challenge_id ?? null, issuedAt:x.issued_at?.toISOString() ?? null,
            expiresAt:x.expires_at?.toISOString() ?? null,
            consumedAt:x.consumed_at?.toISOString() ?? null,
            verifiedAt:x.verified_at?.toISOString() ?? null,
            activeVersion:x.active_version ?? null,
            clearsClaim:false as const };
    }
}
