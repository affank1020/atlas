import type { Pool } from 'pg';
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
        /** Trusted ACL — caller must authenticate node credentials separately. */
        private readonly allowed: (source: string, target: string) => Promise<boolean>,
    ) {
        if (key.length !== 32) throw new Error('Missing device inbox encryption key.');
    }

    /**
     * Intended for an authenticated source Node's separate offline-enqueue command.
     * Never use this as a fallback within the synchronous device.share.submit path.
     */
    async enqueue(input: { sourceId: string; targetId: string; deliveryId: string; text: string }) {
        const source = this.uuid(input.sourceId), target = this.uuid(input.targetId), id = this.uuid(input.deliveryId);
        if (source === target || !(await this.allowed(source,target)))
            throw new AtlasError('Offline share not authorised.', 'SHARE_DENIED');
        validateInboxText(input.text);
        const digest = digestInboxSubmission(this.key,target, input.text);
        const envelope = sealInboxText(this.key,source,target,id,input.text);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            // Serialize admissions to this target and delivery key across server replicas.
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [target]);
            const peers = await client.query(
                "SELECT id,credential_state FROM nodes WHERE id IN ($1,$2) FOR SHARE",
                [source,target]);
            if (peers.rowCount !== 2 || peers.rows.some(p => p.credential_state !== 'active') ||
                !(await this.allowed(source,target)))
                throw new AtlasError('Offline share no longer authorised.', 'SHARE_DENIED');
            const previous = await client.query(
                'SELECT submission_hash,state,expires_at FROM device_inbox WHERE source_node_id=$1 AND id=$2',
                [source,id]);
            if (previous.rowCount) {
                if (!sameDigest(String(previous.rows[0].submission_hash),digest))
                    throw new AtlasError('Offline delivery ID reused with different content.', 'SHARE_REPLAY');
                await client.query('COMMIT');
                return { deliveryId:id, status:previous.rows[0].state as InboxState, queued:false };
            }
            const limits = await client.query(`
                SELECT
                  (SELECT count(*)::int FROM device_inbox WHERE target_node_id=$1 AND state='queued' AND expires_at>now()) AS target_count,
                  (SELECT count(*)::int FROM device_inbox WHERE source_node_id=$2 AND state='queued' AND expires_at>now()) AS source_count
            `,[target,source]);
            if (Number(limits.rows[0].target_count)>=MAX_PENDING_PER_TARGET ||
                Number(limits.rows[0].source_count)>=MAX_PENDING_PER_SOURCE)
                throw new AtlasError('Offline inbox is full.', 'SHARE_BUSY');
            await client.query(`
                INSERT INTO device_inbox
                  (id,source_node_id,target_node_id,submission_hash,payload_ciphertext,payload_nonce,payload_tag,expires_at)
                VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::bigint*interval '1 millisecond'))
            `,[id,source,target,digest,envelope.ciphertext,envelope.nonce,envelope.tag,DEVICE_INBOX_TTL_MS]);
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
            SELECT id,source_node_id,created_at,expires_at
            FROM device_inbox
            WHERE target_node_id=$1 AND state='queued' AND expires_at>now()
            ORDER BY created_at,id LIMIT 50
        `,[target]);
        return result.rows.map(r => ({
            deliveryId:String(r.id),sourceNodeId:String(r.source_node_id),
            createdAt:new Date(r.created_at).toISOString(),
            expiresAt:new Date(r.expires_at).toISOString(),
        }));
    }

    async read(targetId: string, deliveryId: string) {
        const target = this.uuid(targetId), id = this.uuid(deliveryId);
        const row = await this.pool.query(`
            SELECT source_node_id,payload_ciphertext,payload_nonce,payload_tag
            FROM device_inbox
            WHERE target_node_id=$1 AND id=$2 AND state='queued' AND expires_at>now()
        `,[target,id]);
        if (!row.rowCount) throw new AtlasError('Device inbox item unavailable.', 'NOT_FOUND');
        const item = row.rows[0];
        const source = String(item.source_node_id);
        if (!(await this.allowed(source,target)))
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
