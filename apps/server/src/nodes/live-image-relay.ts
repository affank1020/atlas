import { createHash } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';
import type { NodeService } from './service.js';
import type { NodeShareApprovals } from './share-approvals.js';
import type { NodeRuntime } from '@atlas/protocol/runtime';
import type { DeviceImageDelivery } from '@atlas/protocol/device-protocol';
import { MAX_DEVICE_IMAGE_BYTES } from '@atlas/protocol/device-protocol';
import { imageDimensions } from '@atlas/protocol/image-format';

const LIMIT_CONCURRENT = 4;
const PREAUTH_CONCURRENT = 24;
const PREAUTH_RATE_PER_MINUTE = 60;
const PREAUTH_PEER_LIMIT = 128;
const AUTHENTICATED_RATE_LIMIT = 512;
const TTL_MS = 45_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type LiveImageOffer = {
    sourceId: string; targetId: string; deliveryId: string;
    mimeType: 'image/png' | 'image/jpeg'; sha256: string; bytes: Buffer;
};
/** Domain-facing interface: delivery is implemented by the live remote adapter,
 * but the domain must not import infrastructure/nodes. */
export type ImageDeliveryRuntime = NodeRuntime & {
    deliverDeviceImage(input: Omit<DeviceImageDelivery, 'type' | 'kind' | 'requestId'>):
        Promise<{ accepted: boolean }>;
};
function canDeliverImage(runtime: NodeRuntime | undefined): runtime is ImageDeliveryRuntime {
    if (!runtime || !runtime.getCapabilities().includes('device.image.receive')) return false;
    return typeof (runtime as Partial<ImageDeliveryRuntime>).deliverDeviceImage === 'function';
}
type Entry = LiveImageOffer & { expiresAt: number; claimed: boolean; targetRuntime: ImageDeliveryRuntime };

/** In-memory and ephemeral: no image is written to PostgreSQL, R2, logs,
 * Workspace storage, or WebSocket JSON. This is NOT the offline inbox.
 * At most four 8-MiB transfers may occupy the server's bounded relay.
 */
export class LiveImageRelay {
    private active = 0;
    private readonly sourceActive = new Set<string>();
    private readonly entries = new Map<string, Entry>();
    private readonly seenIds = new Map<string, number>();
    private readonly rate = new Map<string, { window: number; count: number }>();
    // Keyed by the actual socket peer (not client-supplied Node UUID or XFF).
    // Reverse-proxy deployments must also apply upstream edge rate limits;
    // this small, hard-bounded map protects DB authentication from floods.
    private readonly preAuthPeers = new Map<string, { window: number; count: number }>();
    private pendingAuthentications = 0;
    constructor(private readonly nodes: NodeService, private readonly approvals: NodeShareApprovals,
        private readonly imagePairs: ReadonlySet<string> = new Set()) {}
    private imageAllowed(source: string, target: string) {
        return this.imagePairs.has(source.toLowerCase() + ':' + target.toLowerCase());
    }

    private preAuthenticate(peerAddress: string): () => void {
        if (this.pendingAuthentications >= PREAUTH_CONCURRENT)
            throw new AtlasError('Image authentication is busy.', 'SHARE_BUSY');
        const now = Date.now();
        for (const [key, value] of this.preAuthPeers) {
            if (now - value.window >= 60_000) this.preAuthPeers.delete(key);
        }
        // A peer key is the socket's actual network address, not a request
        // header, and the map never grows beyond PREAUTH_PEER_LIMIT.
        const peer = peerAddress.slice(0, 100) || 'unknown';
        const previous = this.preAuthPeers.get(peer);
        if (previous?.count && previous.count >= PREAUTH_RATE_PER_MINUTE)
            throw new AtlasError('Image authentication rate limited.', 'SHARE_RATE_LIMIT');
        if (!previous && this.preAuthPeers.size >= PREAUTH_PEER_LIMIT)
            this.preAuthPeers.delete(this.preAuthPeers.keys().next().value!);
        this.preAuthPeers.set(peer, previous
            ? { window: previous.window, count: previous.count + 1 }
            : { window: now, count: 1 });
        this.pendingAuthentications++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.pendingAuthentications--;
        };
    }

    private chargeAuthenticatedSender(source: string) {
        const now = Date.now();
        for (const [id, item] of this.rate) {
            if (now - item.window >= 60_000) this.rate.delete(id);
        }
        const previous = this.rate.get(source);
        if (previous && previous.count >= 12)
            throw new AtlasError('Image transfer rate limited.', 'SHARE_RATE_LIMIT');
        if (!previous && this.rate.size >= AUTHENTICATED_RATE_LIMIT)
            this.rate.delete(this.rate.keys().next().value!);
        this.rate.set(source, previous
            ? { window: previous.window, count: previous.count + 1 }
            : { window: now, count: 1 });
    }

    get authenticatedRateEntries() { return this.rate.size; }
    get preAuthRateEntries() { return this.preAuthPeers.size; }
    get pendingAuthCount() { return this.pendingAuthentications; }


    async admit(sourceId: string, targetId: string, credential: string,
        peerAddress = 'unknown'): Promise<{
        target: ImageDeliveryRuntime; sourceRuntime: NodeRuntime; release: () => void;
    }> {
        const source = sourceId.toLowerCase(), target = targetId.toLowerCase();
        if (!UUID.test(source) || !UUID.test(target) || source === target)
            throw new AtlasError('Invalid image transfer identities.', 'SHARE_INVALID');

        // Invalid credentials must never change another Node's rate budget or
        // reserve its active-transfer slot. Only cheap, independently keyed,
        // bounded pre-auth checks run before credential authentication.
        const finishAuth = this.preAuthenticate(peerAddress);
        try { await this.nodes.identity!.authenticate(source, credential); }
        finally { finishAuth(); }

        if (this.active >= LIMIT_CONCURRENT || this.sourceActive.has(source))
            throw new AtlasError('Image transfer is unavailable or busy.', 'SHARE_BUSY');
        this.chargeAuthenticatedSender(source);

        // Synchronous reservation after the verified identity, before any
        // further awaits; concurrent requests from one Node cannot race it.
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
            const sender = await this.nodes.get(source);
            const receiver = await this.nodes.get(target);
            const senderRuntime = this.nodes.runtimes.get(source);
            const targetRuntime = this.nodes.runtimes.get(target);
            if (sender.platform !== 'android' || receiver.platform !== 'darwin' ||
                sender.credentialState !== 'active' || receiver.credentialState !== 'active' ||
                !sender.capabilities.includes('device.image.send') ||
                !senderRuntime?.getCapabilities().includes('device.image.send') ||
                !receiver.capabilities.includes('device.image.receive') ||
                !canDeliverImage(targetRuntime) ||
                !this.imageAllowed(source, target) ||
                !(await this.approvals.allowedForInbox(source, target)))
                throw new AtlasError('Image transfer to that Node is not authorised.', 'SHARE_DENIED');
            return { target: targetRuntime, sourceRuntime: senderRuntime, release };
        } catch (error) {
            release();
            throw error;
        }
    }

    async deliver(admitted: {target: ImageDeliveryRuntime; sourceRuntime: NodeRuntime}, offer: LiveImageOffer, credential: string): Promise<{accepted: boolean}> {
        const sourceId = offer.sourceId.toLowerCase(), targetId = offer.targetId.toLowerCase();
        const key = offer.deliveryId.toLowerCase();
        if (!UUID.test(key) || !UUID.test(sourceId) || !UUID.test(targetId) ||
            offer.bytes.length < 24 || offer.bytes.length > MAX_DEVICE_IMAGE_BYTES ||
            !/^[0-9a-f]{64}$/.test(offer.sha256) ||
            !isImage(offer.bytes, offer.mimeType) ||
            createHash('sha256').update(offer.bytes).digest('hex') !== offer.sha256)
            throw new AtlasError('Invalid or corrupt image bytes.', 'SHARE_INVALID');
        for (const [id, expiry] of this.seenIds) if (expiry <= Date.now()) this.seenIds.delete(id);
        if (this.entries.has(key) || this.seenIds.has(key))
            throw new AtlasError('Image delivery ID was reused.', 'SHARE_REPLAY');
        // Do not allow an older socket to forward after the admission read.
        if (this.nodes.runtimes.get(sourceId) !== admitted.sourceRuntime ||
            this.nodes.runtimes.get(targetId) !== admitted.target)
            throw new AtlasError('Image target disconnected.', 'NODE_DISCONNECTED');
        await this.nodes.identity!.authenticate(sourceId, credential);
        if (!this.imageAllowed(sourceId,targetId) ||
            !(await this.approvals.allowedForInbox(sourceId, targetId)))
            throw new AtlasError('Image permission was revoked.', 'SHARE_DENIED');
        if (this.entries.has(key) || this.seenIds.has(key) ||
            this.nodes.runtimes.get(sourceId) !== admitted.sourceRuntime ||
            this.nodes.runtimes.get(targetId) !== admitted.target)
            throw new AtlasError('Image session changed or delivery ID reused.', 'SHARE_REPLAY');
        const expiresAt = Date.now() + TTL_MS;
        if (this.seenIds.size >= 1024) this.seenIds.delete(this.seenIds.keys().next().value!);
        this.seenIds.set(key, Date.now() + 300_000);
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
        if (!this.imageAllowed(entry.sourceId,target) ||
            !(await this.approvals.allowedForInbox(entry.sourceId, target)) ||
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
    return imageDimensions(bytes,type)!==null;
}
