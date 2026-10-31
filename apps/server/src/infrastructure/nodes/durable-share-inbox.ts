import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { AtlasError } from '../../shared/errors.js';
import type { NodeService } from '../../nodes/service.js';
import type { NodeShareApprovals } from '../../nodes/share-approvals.js';
import type { RemoteNodeRuntime } from './remote-runtime.js';

const MAX_PER_RECIPIENT = 20;
const MAX_ITEMS_PER_FETCH = 20;
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION = '7 days';
const RATE_WINDOW_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type QueuedStatus = 'queued' | 'copied' | 'declined' | 'expired';
type Envelope = { deliveryId: string; sourceNodeId: string; text: string; expiresAt: string };

/**
 * A separate opt-in path from synchronous device.share.submit. No plaintext
 * enters Postgres or diagnostics. Each queue pair needs BOTH the ordinary
 * directional sharing grant and a distinct ATLAS_DEVICE_SHARE_QUEUE_PAIRS grant.
 */
export class DurableDeviceShareInbox {
    private readonly key: Buffer | undefined;
    private readonly admission = new Map<string, { window: number; count: number; active: number }>();
    constructor(
        private readonly pool: Pool,
        private readonly nodes: NodeService,
        private readonly normalPairs: ReadonlySet<string>,
        private readonly queuePairs: ReadonlySet<string>,
        private readonly approvals: NodeShareApprovals,
        keyHex?: string,
    ) {
        if (keyHex && !/^[0-9a-f]{64}$/i.test(keyHex))
            throw new Error('ATLAS_DEVICE_SHARE_QUEUE_KEY must be exactly 64 hex characters.');
        this.key = keyHex ? Buffer.from(keyHex, 'hex') : undefined;
        if (queuePairs.size && !this.key)
            throw new Error('ATLAS_DEVICE_SHARE_QUEUE_KEY is required when queue pairs are configured.');
    }

    get enabled() { return !!this.key && this.queuePairs.size > 0; }

    /** Expired plaintext is inaccessible immediately via list(); this sweep
     * also erases its ciphertext without needing another incoming transfer.
     */
    async prune() {
        await this.pool.query(`UPDATE node_share_inbox
            SET status='expired',nonce=NULL,ciphertext=NULL,auth_tag=NULL,resolved_at=now()
            WHERE status='queued' AND expires_at <= now()`);
        await this.pool.query(`DELETE FROM node_share_inbox
            WHERE expires_at < now() - interval '7 days'`);
    }

    allowsQueue(source: string, target: string) {
        return !!this.key && this.queuePairs.has(source.toLowerCase() + ':' + target.toLowerCase());
    }
    private async authorized(source: string, target: string) {
        return this.allowsQueue(source, target) &&
            (this.normalPairs.has(source + ':' + target) || await this.approvals.allowed(source, target));
    }
    private encrypt(source: string, target: string, id: string, text: string) {
        if (!this.key) throw new AtlasError('Queued device sharing is disabled.', 'SHARE_QUEUE_DISABLED');
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
        cipher.setAAD(Buffer.from(source + ':' + target + ':' + id));
        return { nonce, ciphertext: Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]),
            authTag: cipher.getAuthTag() };
    }
    private decrypt(row: any): string {
        if (!this.key) throw new AtlasError('Queued device sharing is disabled.', 'SHARE_QUEUE_DISABLED');
        const source = String(row.source_node_id), target = String(row.target_node_id), id = String(row.delivery_id);
        const decipher = createDecipheriv('aes-256-gcm', this.key, row.nonce);
        decipher.setAAD(Buffer.from(source + ':' + target + ':' + id));
        decipher.setAuthTag(row.auth_tag);
        return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    }
    private async verifySession(id: string, runtime: RemoteNodeRuntime | undefined,
        credential: string, required: 'device.share.send' | 'device.share.receive') {
        if (!runtime || this.nodes.runtimes.get(id) !== runtime ||
            !runtime.getCapabilities().includes(required))
            throw new AtlasError('Node session does not have this capability.', 'SHARE_DENIED');
        await this.nodes.identity!.authenticate(id, credential);
        if (this.nodes.runtimes.get(id) !== runtime)
            throw new AtlasError('Node session changed.', 'NODE_DISCONNECTED');
    }
    private admit(source: string) {
        const now = Date.now();
        const old = this.admission.get(source);
        const next = old && now - old.window < RATE_WINDOW_MS ? old
            : { window: now, count: 0, active: old?.active ?? 0 };
        this.admission.set(source, next);
        if (next.count >= 12 || next.active >= 2)
            throw new AtlasError('Too many queued shares.', 'SHARE_RATE_LIMIT');
        next.count++; next.active++;
        if (this.admission.size > 512)
            for (const [key, value] of this.admission)
                if (value.active === 0 && now - value.window > RATE_WINDOW_MS)
                    this.admission.delete(key);
        return () => { next.active--; };
    }
    async queue(input: {
        sourceId: string; runtime?: RemoteNodeRuntime; credential: string;
        submission: { deliveryId: string; targetNodeId: string; text: string };
    }): Promise<{ state: QueuedStatus; expiresAt: string }> {
        const source = input.sourceId.toLowerCase(), target = input.submission.targetNodeId.toLowerCase();
        const deliveryId = input.submission.deliveryId.toLowerCase();
        if (!this.key || !UUID.test(source) || !UUID.test(target) || !UUID.test(deliveryId) ||
            source === target || !this.allowsQueue(source, target))
            throw new AtlasError('Queued delivery is not authorised for these Nodes.', 'SHARE_DENIED');
        const release = this.admit(source);
        try {
            await this.verifySession(input.sourceId, input.runtime, input.credential, 'device.share.send');
            if (!(await this.authorized(source, target)))
                throw new AtlasError('The directional grant was revoked.', 'SHARE_DENIED');
            const targetNode = await this.nodes.get(target);
            if (targetNode.platform !== 'android' || targetNode.credentialState !== 'active' ||
                !targetNode.capabilities.includes('device.share.receive'))
                throw new AtlasError('The Android recipient cannot receive queued shares.', 'SHARE_TARGET_UNAVAILABLE');
            const text = input.submission.text;
            if (!text.trim() || text.length > 16_384)
                throw new AtlasError('Invalid queued text.', 'SHARE_INVALID');
            const digest = createHash('sha256').update(target).update('\0').update(text).digest('hex');
            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                // Serialize only queue admissions for honest bounded storage and
                // durable (source,deliveryId) idempotency across server replicas.
                await client.query('SELECT pg_advisory_xact_lock($1)', [7301582]);
                await client.query(`UPDATE node_share_inbox SET status='expired',nonce=NULL,ciphertext=NULL,
                    auth_tag=NULL,resolved_at=now() WHERE status='queued' AND expires_at<=now()`);
                await client.query(`DELETE FROM node_share_inbox
                    WHERE expires_at < now() - interval '${RECEIPT_RETENTION}'`);
                const existing = await client.query(
                    'SELECT target_node_id,digest,status,expires_at FROM node_share_inbox WHERE source_node_id=$1 AND delivery_id=$2',
                    [source, deliveryId]);
                if (existing.rowCount) {
                    const row = existing.rows[0];
                    if (String(row.target_node_id) !== target || row.digest !== digest)
                        throw new AtlasError('Delivery ID reused with different content.', 'SHARE_REPLAY');
                    await client.query('COMMIT');
                    return { state: row.status as QueuedStatus, expiresAt: new Date(row.expires_at).toISOString() };
                }
                // Avoid unbounded storage even with a valid configured pair.
                const count = await client.query(`SELECT count(*)::int AS count FROM node_share_inbox
                    WHERE target_node_id=$1 AND status='queued'`, [target]);
                if (Number(count.rows[0].count) >= MAX_PER_RECIPIENT)
                    throw new AtlasError('Recipient queue is full.', 'SHARE_QUEUE_FULL');
                const expiry = new Date(Date.now() + EXPIRY_MS);
                const box = this.encrypt(source, target, deliveryId, text);
                await client.query(`INSERT INTO node_share_inbox
                    (source_node_id,delivery_id,target_node_id,digest,nonce,ciphertext,auth_tag,expires_at)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [source, deliveryId, target, digest, box.nonce, box.ciphertext, box.authTag, expiry]);
                await client.query('COMMIT');
                return { state: 'queued', expiresAt: expiry.toISOString() };
            } catch (error) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw error;
            } finally { client.release(); }
        } finally { release(); }
    }
    async list(input: { targetId: string; runtime?: RemoteNodeRuntime; credential: string }): Promise<{ items: Envelope[] }> {
        const target = input.targetId.toLowerCase();
        if (!this.key) throw new AtlasError('Queued delivery is disabled.', 'SHARE_QUEUE_DISABLED');
        await this.verifySession(input.targetId, input.runtime, input.credential, 'device.share.receive');
        const result = await this.pool.query(`SELECT i.* FROM node_share_inbox i
            JOIN nodes n ON n.id=i.source_node_id AND n.credential_state='active'
            WHERE i.target_node_id=$1 AND i.status='queued' AND i.expires_at>now()
            ORDER BY i.created_at,i.delivery_id LIMIT $2`, [target, MAX_ITEMS_PER_FETCH]);
        const items: Envelope[] = [];
        for (const row of result.rows) {
            const source = String(row.source_node_id);
            // Revocation is checked on every read, never only at queue time.
            if (!(await this.authorized(source, target))) continue;
            const text = this.decrypt(row);
            if (!text.trim() || text.length > 16_384) continue;
            items.push({ deliveryId: String(row.delivery_id), sourceNodeId: source,
                text, expiresAt: new Date(row.expires_at).toISOString() });
        }
        return { items };
    }
    async resolve(input: { targetId: string; runtime?: RemoteNodeRuntime; credential: string;
        deliveryId: string; sourceNodeId: string; accepted: boolean }): Promise<{ state: QueuedStatus }> {
        const target = input.targetId.toLowerCase(), id = input.deliveryId.toLowerCase(),
            source = input.sourceNodeId.toLowerCase();
        if (!this.key) throw new AtlasError('Queued delivery is disabled.', 'SHARE_QUEUE_DISABLED');
        await this.verifySession(input.targetId, input.runtime, input.credential, 'device.share.receive');
        const result = await this.pool.query(`SELECT source_node_id,status,expires_at FROM node_share_inbox
            WHERE target_node_id=$1 AND delivery_id=$2 AND source_node_id=$3 LIMIT 1`, [target, id, source]);
        if (!result.rowCount) throw new AtlasError('Queued share not found.', 'NOT_FOUND');
        const row = result.rows[0];
        if (!(await this.authorized(String(row.source_node_id), target)))
            throw new AtlasError('Sharing grant revoked.', 'SHARE_DENIED');
        if (row.status !== 'queued') return { state: row.status as QueuedStatus };
        const requested: QueuedStatus = input.accepted ? 'copied' : 'declined';
        // The expiry check belongs in the UPDATE itself. A decision arriving
        // between a preceding SELECT and expiry cannot be recorded as copied.
        const updated = await this.pool.query(`UPDATE node_share_inbox
            SET status=CASE WHEN expires_at > now() THEN $3 ELSE 'expired' END,
            nonce=NULL,ciphertext=NULL,auth_tag=NULL,resolved_at=now()
            WHERE target_node_id=$1 AND delivery_id=$2 AND source_node_id=$4 AND status='queued'
            RETURNING status`, [target, id, requested, source]);
        if (updated.rowCount) return { state: updated.rows[0].status as QueuedStatus };
        const latest = await this.pool.query(
            'SELECT status FROM node_share_inbox WHERE target_node_id=$1 AND delivery_id=$2 AND source_node_id=$3', [target,id,source]);
        return { state: (latest.rows[0]?.status ?? 'expired') as QueuedStatus };
    }
}
