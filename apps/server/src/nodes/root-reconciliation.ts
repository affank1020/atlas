import type { Pool, PoolClient } from 'pg';
import { AtlasError } from '../shared/errors.js';
import { verifyRootUpdateAttestation, type RootUpdateAttestation } from './root-evidence.js';

/**
 * Manually authorised close-out only. There is NO Node, MCP, web or HTTP
 * route to this class. The only invoker is the separately gated operator
 * terminal CLI. An operator must inspect host state out-of-band before
 * claiming that a previously claimed update can be closed.
 *
 * Cryptographic proof is a signed recent snapshot, not an automated health
 * attestation. The operator's external health and recovery checks are
 * recorded as an ASSERTION, and never advertised as measured by Atlas.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^[0-9]+[.]\d+[.]\d+[+][0-9a-f]{12}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{7,99}$/;

export type ReconciliationAssertion = {
    nodeId: string;
    intentId: string;
    independentlyCheckedVersion: string;
    independentlyCheckedPid: number;
    operatorCheckReference: string;
};
export type ReconciliationRecord = ReconciliationAssertion & {
    evidenceChallengeId: string;
    rootKeyFingerprint: string;
    recordedAt: string;
    status: 'reconciled';
    operatorAcknowledged: true;
    healthIndependentlyMeasuredByAtlas: false;
};

export class NodeUpdateReconciliationLedger {
    constructor(private readonly pool: Pool) {}

    private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    }

    async reconcile(assertion: ReconciliationAssertion): Promise<ReconciliationRecord> {
        const { nodeId, intentId, independentlyCheckedVersion: checkedVersion,
            independentlyCheckedPid: checkedPid, operatorCheckReference: reference } = assertion;
        if (!UUID.test(nodeId) || !UUID.test(intentId) ||
            typeof checkedVersion !== 'string' || !VERSION.test(checkedVersion) ||
            !Number.isSafeInteger(checkedPid) || checkedPid < 2 || checkedPid > 0x7fffffff ||
            typeof reference !== 'string' || !REFERENCE.test(reference))
            throw new AtlasError('Invalid independent operator reconciliation inputs.', 'INVALID_INPUT');
        return this.transaction(async db => {
            // Serialise against Node revocation/rotation, prepare, claim and
            // another operator attempting to close the same claim.
            const owners = await db.query<{
                platform: string; metadata: Record<string, unknown>; credential_state: string;
                credential_updated_at: Date; status: string; version: string; last_seen: Date|null;
            }>(`SELECT platform,metadata,credential_state,credential_updated_at,
                status,version,last_seen FROM nodes WHERE id=$1 FOR UPDATE`,[nodeId]);
            if (!owners.rowCount) throw new AtlasError('Node not found.', 'NOT_FOUND');
            const node = owners.rows[0]!;
            if (node.platform !== 'linux' || node.metadata?.runtime !== 'remote' ||
                node.credential_state !== 'active' || node.status !== 'online' ||
                !node.last_seen || !node.credential_updated_at)
                throw new AtlasError('Remote Linux Node is not active and online.', 'CONFLICT');
            // A connected Node can self-report status and version. This gate
            // is corroboration ONLY; the operator must check the real host
            // independently. Freshness is judged against DB clock.
            const heartbeat = await db.query(`SELECT 1 WHERE $1::timestamptz
                BETWEEN clock_timestamp()-interval '60 seconds'
                AND clock_timestamp()+interval '5 seconds'`,[node.last_seen]);
            if (!heartbeat.rowCount)
                throw new AtlasError('Node heartbeat is not fresh.', 'CONFLICT');
            const intents = await db.query<{
                status: string; created_at: Date; target_version: string;
                target_commit: string; target_sha256: string;
            }>(`SELECT status,created_at,target_version,target_commit,target_sha256
                FROM node_update_intents WHERE id=$1 AND node_id=$2 FOR UPDATE`,[intentId,nodeId]);
            if (!intents.rowCount) throw new AtlasError('Update request not found.', 'NOT_FOUND');
            const intent = intents.rows[0]!;
            const targetVersion = intent.target_version + '+' + intent.target_commit.trim();
            if (intent.status !== 'claimed' || node.version !== targetVersion ||
                checkedVersion !== targetVersion ||
                node.credential_updated_at.getTime() > intent.created_at.getTime())
                throw new AtlasError('Claim, active Node version or credential generation changed.', 'CONFLICT');

            // Lock the consumed challenge for this exact intent; never accept
            // a stale or retired signature, even if it remains cryptographically
            // valid under an administrator-pinned public key.
            const proofs = await db.query<{
                challenge_id: string; key_fingerprint: string; active_version: string;
                target_sha256: string; observed_pid: number; signature: string;
                verified_at: Date; nonce: string; consumed_at: Date; invalidated_at: Date|null;
                public_key_pem: string; current_fingerprint: string;
            }>(`SELECT e.challenge_id,e.key_fingerprint,e.active_version,
                e.target_sha256,e.observed_pid,e.signature,e.verified_at,
                c.nonce,c.consumed_at,c.invalidated_at,
                k.public_key_pem,k.fingerprint AS current_fingerprint
                FROM node_update_root_evidence e
                JOIN node_update_root_challenges c ON c.id=e.challenge_id
                    AND c.intent_id=e.intent_id AND c.node_id=e.node_id
                JOIN node_update_root_keys k ON k.node_id=e.node_id
                WHERE e.intent_id=$1 AND e.node_id=$2 FOR UPDATE OF e,c,k`,
                [intentId,nodeId]);
            if (proofs.rowCount !== 1)
                throw new AtlasError('No independently pinned root evidence for this claim.', 'CONFLICT');
            const proof = proofs.rows[0]!;
            const currentFingerprint = proof.current_fingerprint.trim();
            const archiveSha = intent.target_sha256.trim();
            if (!proof.consumed_at || proof.invalidated_at ||
                proof.key_fingerprint.trim() !== currentFingerprint ||
                proof.active_version !== targetVersion ||
                proof.target_sha256.trim() !== archiveSha ||
                proof.observed_pid !== checkedPid)
                throw new AtlasError('Host-root evidence differs from independently checked host state.', 'CONFLICT');
            const stillFresh = await db.query(`SELECT 1 WHERE $1::timestamptz
                BETWEEN clock_timestamp()-interval '5 minutes'
                AND clock_timestamp()+interval '5 seconds'`,[proof.verified_at]);
            if (!stillFresh.rowCount)
                throw new AtlasError('Root evidence is no longer recent enough for manual reconciliation.', 'CONFLICT');
            const signed: RootUpdateAttestation = {
                schema:1,nodeId,intentId,challenge:proof.nonce.trim(),
                activeVersion:proof.active_version,targetSha256:proof.target_sha256.trim(),
                observedPid:proof.observed_pid,signature:proof.signature.trim(),
            };
            if (!verifyRootUpdateAttestation(signed,proof.public_key_pem,{
                nodeId,intentId,challenge:signed.challenge,activeVersion:targetVersion,
                targetSha256:archiveSha,
            }))
                throw new AtlasError('Stored root evidence no longer verifies.', 'CONFLICT');

            const receipt = await db.query<{recorded_at:Date}>(`INSERT INTO node_update_reconciliations
                (intent_id,node_id,evidence_challenge_id,root_key_fingerprint,
                    independently_checked_version,independently_checked_pid,operator_check_reference)
                VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING recorded_at`,
                [intentId,nodeId,proof.challenge_id,currentFingerprint,checkedVersion,checkedPid,reference]);
            const updated = await db.query(`UPDATE node_update_intents
                SET status='reconciled',resolved_at=clock_timestamp()
                WHERE id=$1 AND node_id=$2 AND status='claimed' RETURNING id`,[intentId,nodeId]);
            if (updated.rowCount !== 1)
                throw new AtlasError('Update claim changed during manual reconciliation.', 'CONFLICT');
            await db.query(`INSERT INTO audit_events(id,client,operation,after_state,created_at)
                VALUES(gen_random_uuid(),'atlas-node-root-operator','node.update_operator_reconciled',$1,clock_timestamp())`,
                [{nodeId,intentId,evidenceChallengeId:proof.challenge_id,
                    fingerprint:currentFingerprint,operatorCheckReference:reference,
                    status:'reconciled',operatorAcknowledged:true,
                    healthIndependentlyMeasuredByAtlas:false,executable:false}]);
            return {
                nodeId,intentId,independentlyCheckedVersion:checkedVersion,
                independentlyCheckedPid:checkedPid,operatorCheckReference:reference,
                evidenceChallengeId:proof.challenge_id,rootKeyFingerprint:currentFingerprint,
                recordedAt:receipt.rows[0]!.recorded_at.toISOString(),status:'reconciled',
                operatorAcknowledged:true,healthIndependentlyMeasuredByAtlas:false,
            };
        });
    }
}
