import type { Pool } from 'pg';
import type { NodeShareApprovals } from './share-approvals.js';
import { AtlasError } from '../shared/errors.js';
import {
    DEVICE_INBOX_TTL_MS, digestInboxSubmission, openInboxText,
    sameDigest, sealInboxText, validateInboxText,
} from './offline-inbox-crypto.js';

type InboxState = 'queued' | 'user_copied' | 'declined' | 'expired';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PENDING_PER_TARGET = 50;
const MAX_PENDING_PER_SOURCE = 100;

/** An offline share is only queued; it is not a clipboard delivery receipt. */
export class DeviceOfflineInbox {
    constructor(
        private readonly pool: Pool,
        private readonly key: Buffer,
        /** One trusted policy owns both managed and environment grant semantics. */
        private readonly approvals: Pick<NodeShareApprovals,
            'allowedForInbox' | 'retireInaccessibleInboxRows'>,
    ) {
        if (key.length !== 32) throw new Error('Missing device inbox encryption key.');
    }

    /**
     * Intended for an authenticated source Node's separate offline-enqueue command.
     * Never use this as a fallback within the synchronous device.share.submit path.
     */
    async enqueue(input: { sourceId: string; targetId: string; deliveryId: string; text: string }) {
        const source = this.uuid(input.sourceId), target = this.uuid(input.targetId), id = this.uuid(input.deliveryId);
        if (source === target || !(await this.approvals.allowedForInbox(source,target)))
            throw new AtlasError('Offline share not authorised.', 'SHARE_DENIED');
        validateInboxText(input.text);
        const digest = digestInboxSubmission(this.key,target, input.text);
        const envelope = sealInboxText(this.key,source,target,id,input.text);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            // Remove expired encrypted payloads during authenticated admissions.
            // A separate scheduled maintenance worker is still required when
            // the inbox is idle for long periods.
            await client.query('DELETE FROM device_inbox WHERE expires_at<=now()');
            // Enforce per-source and per-target quotas across server replicas.
            // Sort lock keys to avoid deadlocks between opposite-direction sends.
            const lockKeys = ['inbox-source:' + source, 'inbox-target:' + target].sort();
            for (const lockKey of lockKeys)
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
            // Retire inaccessible items *under the admission locks* before
            // quota accounting and before checking an idempotent retry.
            // Old ciphertext is erased, but the delivery ID remains a
            // terminal tombstone until its original retention expiry.
            await this.approvals.retireInaccessibleInboxRows(client,source,target);
            const peers = await client.query(
                "SELECT id,credential_state,credential_updated_at,capabilities FROM nodes WHERE id IN ($1,$2) FOR SHARE",
                [source,target]);
            if (peers.rowCount !== 2 || peers.rows.some(p => p.credential_state !== 'active') ||
                !peers.rows.some(p => String(p.id).toLowerCase() === target &&
                    Array.isArray(p.capabilities) && p.capabilities.includes('device.share.receive')) ||
                !(await this.approvals.allowedForInbox(source,target,client)))
                throw new AtlasError('Offline share no longer authorised.', 'SHARE_DENIED');
            if (peers.rows.some(p => !p.credential_updated_at))
                throw new AtlasError('Node credential generation unavailable.', 'SHARE_DENIED');
            const previous = await client.query(
                'SELECT submission_hash,state,expires_at FROM device_inbox WHERE source_node_id=$1 AND id=$2',
                [source,id]);
            if (previous.rowCount) {
                if (!sameDigest(String(previous.rows[0].submission_hash),digest))
                    throw new AtlasError('Offline delivery ID reused with different content.', 'SHARE_REPLAY');
                await client.query('COMMIT');
                const previousState: InboxState = new Date(previous.rows[0].expires_at).getTime() <= Date.now()
                    ? 'expired' : previous.rows[0].state as InboxState;
                return { deliveryId:id, status:previousState, queued:false };
            }
            const limits = await client.query(`
                SELECT
                  (SELECT count(*)::int FROM device_inbox WHERE target_node_id=$1 AND state='queued' AND expires_at>now()) AS target_count,
                  (SELECT count(*)::int FROM device_inbox WHERE source_node_id=$2 AND state='queued' AND expires_at>now()) AS source_count
            `,[target,source]);
            if (Number(limits.rows[0].target_count)>=MAX_PENDING_PER_TARGET ||
                Number(limits.rows[0].source_count)>=MAX_PENDING_PER_SOURCE)
                throw new AtlasError('Offline inbox is full.', 'SHARE_BUSY');
            // Copy credential generations inside PostgreSQL: pg timestamps have
            // microsecond precision, which a round-trip through JS Date would
            // truncate and incorrectly hide every item on list/read.
            const inserted = await client.query(`
                INSERT INTO device_inbox
                  (id,source_node_id,target_node_id,source_credential_updated_at,target_credential_updated_at,
                   submission_hash,payload_ciphertext,payload_nonce,payload_tag,expires_at)
                SELECT $1::uuid,$2::uuid,$3::uuid,sender.credential_updated_at,receiver.credential_updated_at,
                       $4::text,$5::bytea,$6::bytea,$7::bytea,now()+($8::bigint*interval '1 millisecond')
                FROM nodes sender CROSS JOIN nodes receiver
                WHERE sender.id=$2 AND receiver.id=$3
                  AND sender.credential_state='active' AND receiver.credential_state='active'
                RETURNING id
            `,[id,source,target,digest,envelope.ciphertext,envelope.nonce,envelope.tag,DEVICE_INBOX_TTL_MS]);
            if (!inserted.rowCount)
                throw new AtlasError('Node credential no longer active.', 'SHARE_DENIED');
            await client.query('COMMIT');
            return { deliveryId:id, status:'queued' as const, queued:true };
        } catch (error) {
            await client.query('ROLLBACK').catch(()=>undefined);
            throw error;
        } finally { client.release(); }
    }

    /** Target identity must come from authenticated Node session, not request body. */
    async list(targetId: string) {
        const target = this.uuid(targetId);
        const result = await this.pool.query(`
            SELECT inbox.id,inbox.source_node_id,inbox.created_at,inbox.expires_at
            FROM device_inbox inbox
            JOIN nodes sender ON sender.id=inbox.source_node_id
            JOIN nodes receiver ON receiver.id=inbox.target_node_id
            WHERE inbox.target_node_id=$1 AND inbox.state='queued' AND inbox.expires_at>now()
              AND sender.credential_state='active' AND receiver.credential_state='active'
              AND sender.credential_updated_at=inbox.source_credential_updated_at
              AND receiver.credential_updated_at=inbox.target_credential_updated_at
            ORDER BY inbox.created_at,inbox.id LIMIT 50
        `,[target]);
        // Do not expose metadata for sources whose directional permission
        // was revoked after they queued their item.
        const allowed = await Promise.all(result.rows.map(r =>
            this.approvals.allowedForInbox(String(r.source_node_id),target)));
        return result.rows.filter((_,i) => allowed[i]).map(r => ({
            deliveryId:String(r.id),sourceNodeId:String(r.source_node_id),
            createdAt:new Date(r.created_at).toISOString(),
            expiresAt:new Date(r.expires_at).toISOString(),
        }));
    }

    async read(targetId: string, deliveryId: string) {
        const target = this.uuid(targetId), id = this.uuid(deliveryId);
        const row = await this.pool.query(`
            SELECT inbox.source_node_id,inbox.payload_ciphertext,inbox.payload_nonce,inbox.payload_tag
            FROM device_inbox inbox
            JOIN nodes sender ON sender.id=inbox.source_node_id
            JOIN nodes receiver ON receiver.id=inbox.target_node_id
            WHERE inbox.target_node_id=$1 AND inbox.id=$2 AND inbox.state='queued'
              AND inbox.expires_at>now()
              AND sender.credential_state='active' AND receiver.credential_state='active'
              AND sender.credential_updated_at=inbox.source_credential_updated_at
              AND receiver.credential_updated_at=inbox.target_credential_updated_at
        `,[target,id]);
        if (!row.rowCount) throw new AtlasError('Device inbox item unavailable.', 'NOT_FOUND');
        const item = row.rows[0];
        const source = String(item.source_node_id);
        if (!(await this.approvals.allowedForInbox(source,target)))
            throw new AtlasError('Offline share permission revoked.', 'SHARE_DENIED');
        const text = openInboxText(this.key,source,target,id,{
            ciphertext:item.payload_ciphertext,nonce:item.payload_nonce,tag:item.payload_tag,
        });
        return {deliveryId:id,sourceNodeId:source,text};
    }

    /** Never mark copied without the target's explicit, authenticated action. */
    async decide(targetId: string, deliveryId: string, decision: 'user_copied'|'declined') {
        const target = this.uuid(targetId), id = this.uuid(deliveryId);
        const result = await this.pool.query(`
            UPDATE device_inbox
            SET state=$3, decided_at=now(),
                payload_ciphertext=NULL,
                payload_nonce=NULL,
                payload_tag=NULL
            WHERE target_node_id=$1 AND id=$2 AND state='queued' AND expires_at>now()
              AND EXISTS (
                SELECT 1 FROM nodes sender JOIN nodes receiver ON receiver.id=device_inbox.target_node_id
                WHERE sender.id=device_inbox.source_node_id
                  AND sender.credential_state='active' AND receiver.credential_state='active'
                  AND sender.credential_updated_at=device_inbox.source_credential_updated_at
                  AND receiver.credential_updated_at=device_inbox.target_credential_updated_at
              )
            RETURNING id
        `,[target,id,decision]);
        if (!result.rowCount) throw new AtlasError('Inbox item expired or already decided.', 'SHARE_EXPIRED');
        return { deliveryId:id, status:decision };
    }

    async purgeExpired() {
        return (await this.pool.query(`
            DELETE FROM device_inbox WHERE expires_at<=now() RETURNING id
        `)).rowCount ?? 0;
    }

    private uuid(value:string) {
        if (!UUID.test(value)) throw new AtlasError('Invalid inbox identifier.', 'INVALID_REQUEST');
        return value.toLowerCase();
    }
}
