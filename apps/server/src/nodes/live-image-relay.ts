import { createHash, randomUUID } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';
import type { NodeService } from './service.js';
import type { NodeShareApprovals } from './share-approvals.js';
import { RemoteNodeRuntime } from '../infrastructure/nodes/remote-runtime.js';
import { MAX_DEVICE_IMAGE_BYTES, type DeviceImageDelivery } from '@atlas/protocol/device-protocol';

const LIMIT_CONCURRENT = 4;
const TTL_MS = 45_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type LiveImageOffer = {
    sourceId: string; targetId: string; deliveryId: string;
    mimeType: 'image/png' | 'image/jpeg'; sha256: string; bytes: Buffer;
};
type Entry = LiveImageOffer & { expiresAt: number; claimed: boolean; targetRuntime: RemoteNodeRuntime };

/** In-memory and ephemeral: no image is written to PostgreSQL, R2, logs,
 * Workspace storage, or WebSocket JSON. This is NOT the offline inbox.
 * At most four 8-MiB transfers may occupy the server's bounded relay.
 */
export class LiveImageRelay {
    private active = 0;
    private readonly sourceActive = new Set<string>();
    private readonly entries = new Map<string, Entry>();
    constructor(private readonly nodes: NodeService, private readonly approvals: NodeShareApprovals) {}

    async admit(sourceId: string, targetId: string, credential: string): Promise<{
        target: RemoteNodeRuntime; release: () => void;
    }> {
        const source = sourceId.toLowerCase(), target = targetId.toLowerCase();
        if (!UUID.test(source) || !UUID.test(target) || source === target ||
            this.active >= LIMIT_CONCURRENT || this.sourceActive.has(source))
            throw new AtlasError('Image transfer is unavailable or busy.', 'SHARE_BUSY');
        // Reserve before async DB authentication and before reading any bytes.
        this.active++;
        this.sourceActive.add(source);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this.active--;
            this.sourceActive.delete(source);
        };
        try {
            await this.nodes.identity!.authenticate(source, credential);
            const sender = await this.nodes.get(source);
            const receiver = await this.nodes.get(target);
            const senderRuntime = this.nodes.runtimes.get(source);
            const targetRuntime = this.nodes.runtimes.get(target);
            if (sender.platform !== 'android' || receiver.platform !== 'darwin' ||
                sender.credentialState !== 'active' || receiver.credentialState !== 'active' ||
                !sender.capabilities.includes('device.image.send') ||
                !senderRuntime?.getCapabilities().includes('device.image.send') ||
                !receiver.capabilities.includes('device.image.receive') ||
                !(targetRuntime instanceof RemoteNodeRuntime) ||
                !targetRuntime.getCapabilities().includes('device.image.receive') ||
                !(await this.approvals.allowedForInbox(source, target)))
                throw new AtlasError('Image transfer to that Node is not authorised.', 'SHARE_DENIED');
            return { target: targetRuntime, release };
        } catch (error) {
            release();
            throw error;
        }
    }

    async deliver(admitted: {target: RemoteNodeRuntime}, offer: LiveImageOffer): Promise<{accepted: boolean}> {
        const sourceId = offer.sourceId.toLowerCase(), targetId = offer.targetId.toLowerCase();
        const key = offer.deliveryId.toLowerCase();
        if (!UUID.test(key) || !UUID.test(sourceId) || !UUID.test(targetId) ||
            offer.bytes.length < 24 || offer.bytes.length > MAX_DEVICE_IMAGE_BYTES ||
            !/^[0-9a-f]{64}$/.test(offer.sha256) ||
            !isImage(offer.bytes, offer.mimeType) ||
            createHash('sha256').update(offer.bytes).digest('hex') !== offer.sha256)
            throw new AtlasError('Invalid or corrupt image bytes.', 'SHARE_INVALID');
        if (this.entries.has(key))
            throw new AtlasError('Image delivery ID was reused.', 'SHARE_REPLAY');
        // Do not allow an older socket to forward after the admission read.
        if (this.nodes.runtimes.get(targetId) !== admitted.target)
            throw new AtlasError('Image target disconnected.', 'NODE_DISCONNECTED');
        if (!(await this.approvals.allowedForInbox(sourceId, targetId)))
            throw new AtlasError('Image permission was revoked.', 'SHARE_DENIED');
        const expiresAt = Date.now() + TTL_MS;
        const entry: Entry = { ...offer, sourceId, targetId, deliveryId: key,
            expiresAt, claimed: false, targetRuntime: admitted.target };
        this.entries.set(key, entry);
        try {
            return await admitted.target.deliverDeviceImage({
                deliveryId: key, sourceNodeId: sourceId, mimeType: offer.mimeType,
                byteLength: offer.bytes.length, sha256: offer.sha256,
                expiresAt: new Date(expiresAt).toISOString(),
            });
        } finally {
            this.entries.delete(key);
        }
    }

    /** Only the specifically addressed, authenticated target may consume once. */
    async consume(deliveryId: string, targetId: string, credential: string): Promise<{
        mimeType: 'image/png' | 'image/jpeg'; sha256: string; bytes: Buffer;
    }> {
        const entry = this.entries.get(deliveryId.toLowerCase());
        const target = targetId.toLowerCase();
        if (!entry || entry.targetId !== target || entry.claimed ||
            entry.expiresAt <= Date.now() ||
            this.nodes.runtimes.get(target) !== entry.targetRuntime)
            throw new AtlasError('Image is unavailable or expired.', 'NOT_FOUND');
        await this.nodes.identity!.authenticate(target, credential);
        if (!(await this.approvals.allowedForInbox(entry.sourceId, target)) ||
            this.nodes.runtimes.get(target) !== entry.targetRuntime)
            throw new AtlasError('Image access was revoked.', 'SHARE_DENIED');
        if (entry.claimed || entry.expiresAt <= Date.now())
            throw new AtlasError('Image is unavailable or expired.', 'NOT_FOUND');
        entry.claimed = true; // exact-once, no partial-retry or leaked URLs
        return { mimeType: entry.mimeType, sha256: entry.sha256, bytes: entry.bytes };
    }

    get pendingCount() { return this.entries.size; }
}

/** Minimal bounded format checks; the receiver independently validates the
 * SHA-256, length and signature before touching NSPasteboard.
 */
export function isImage(bytes: Buffer, type: string): boolean {
    if (type === 'image/png')
        return bytes.length >= 24 &&
            bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
            bytes.toString('ascii',12,16) === 'IHDR' &&
            bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
            bytes.readUInt32BE(16) <= 16384 && bytes.readUInt32BE(20) <= 16384;
    if (type === 'image/jpeg')
        return bytes.length >= 24 && bytes[0] === 255 && bytes[1] === 216 &&
            bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
    return false;
}
