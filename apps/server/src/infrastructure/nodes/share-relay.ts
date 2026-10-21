import { createHash } from 'node:crypto';
import { AtlasError } from '../../shared/errors.js';
import type { NodeService } from '../../nodes/service.js';
import type { RemoteNodeRuntime } from './remote-runtime.js';
import type { DeviceShareSubmission } from '@atlas/protocol/device-protocol';

/** No content is persisted or audited. Deny-by-default directed pair policy. */
export class DeviceShareRelay {
    private readonly seen = new Map<string, { digest: string; expiresAt: number; result: Promise<{accepted: boolean}> }>();
    private readonly rate = new Map<string, { window: number; count: number }>();
    private readonly admissions = new Map<string, { window: number; count: number; active: number }>();
    constructor(
        private readonly nodes: NodeService,
        private readonly approvedPairs: ReadonlySet<string>,
    ) {}

    async forward(input: {
        sourceId: string;
        sourceRuntime?: RemoteNodeRuntime;
        credential: string;
        submission: DeviceShareSubmission;
    }): Promise<{ accepted: boolean }> {
        const { sourceId, sourceRuntime, credential, submission } = input;
        // UUIDs are case-insensitive. Use canonical identifiers for policy, cache,
        // digest and target runtime lookup, not just for the allowlist.
        const sourceKey = sourceId.toLowerCase();
        const targetNodeId = submission.targetNodeId.toLowerCase();
        const deliveryId = submission.deliveryId.toLowerCase();
        const { text } = submission;
        if (!this.approvedPairs.has(sourceKey + ':' + targetNodeId) ||
            sourceKey === targetNodeId)
            throw new AtlasError('Sharing to that device is not authorised.', 'SHARE_DENIED');
        if (!sourceRuntime || this.nodes.runtimes.get(sourceId) !== sourceRuntime ||
            !sourceRuntime.getCapabilities().includes('device.share.send'))
            throw new AtlasError('Source Node does not have sharing permission.', 'SHARE_DENIED');

        // Admission is synchronous and BEFORE the first DB query. Each valid
        // attempt (including repeated IDs) consumes the flood budget, so a burst
        // cannot produce unbounded authentication queries or in-flight tasks.
        const startedAt = Date.now();
        if (this.admissions.size > 2048) {
            for (const [id, entry] of this.admissions) {
                if (entry.active === 0 && startedAt - entry.window > 60_000) this.admissions.delete(id);
            }
        }
        const old = this.admissions.get(sourceKey);
        const admission = old && startedAt - old.window < 60_000
            ? old : { window: startedAt, count: 0, active: old?.active ?? 0 };
        this.admissions.set(sourceKey, admission);
        if (admission.count >= 24)
            throw new AtlasError('Too many share attempts.', 'SHARE_RATE_LIMIT');
        admission.count++;
        if (admission.active >= 4)
            throw new AtlasError('Too many concurrent shares.', 'SHARE_BUSY');
        admission.active++;
        try {
            // Still re-check live credential *after* admission, before any delivery.
            await this.nodes.identity!.authenticate(sourceId, credential);
            if (this.nodes.runtimes.get(sourceId) !== sourceRuntime)
                throw new AtlasError('Source Node connection changed.', 'NODE_DISCONNECTED');
            return await this.route(sourceId, sourceKey, targetNodeId, deliveryId, text, sourceRuntime);
        } finally {
            admission.active--;
        }
    }

    private async route(
        sourceId: string, sourceKey: string, targetNodeId: string, deliveryId: string,
        text: string, sourceRuntime: RemoteNodeRuntime,
    ): Promise<{ accepted: boolean }> {
        const now = Date.now();
        for (const [key, entry] of this.seen) if (entry.expiresAt < now) this.seen.delete(key);
        const key = sourceKey + ':' + deliveryId;
        const digest = createHash('sha256').update(targetNodeId).update('\0').update(text).digest('hex');
        const duplicate = this.seen.get(key);
        if (duplicate) {
            if (duplicate.digest !== digest) throw new AtlasError('Delivery ID reused with different content.', 'SHARE_REPLAY');
            return duplicate.result;
        }
        if (this.seen.size >= 2048) throw new AtlasError('Share relay is at capacity.', 'SHARE_BUSY');
        const previous = this.rate.get(sourceKey);
        const slot = previous && previous.window > now - 60_000 ? previous : { window: now, count: 0 };
        if (++slot.count > 12) throw new AtlasError('Too many share attempts.', 'SHARE_RATE_LIMIT');
        this.rate.set(sourceKey, slot);
        const expiry = new Date(now + 45_000).toISOString();
        // Store the promise before awaiting it, so parallel duplicate sends
        // share exactly one target-side action. Intentionally memory-only MVP.
        const pending = this.deliver(sourceId, targetNodeId, { deliveryId, sourceNodeId: sourceKey, text, expiresAt: expiry }, sourceRuntime);
        this.seen.set(key, { digest, expiresAt: now + 5 * 60_000, result: pending });
        return pending;
    }

    private async deliver(sourceId: string, targetId: string, delivery: {
        deliveryId: string; sourceNodeId: string; text: string; expiresAt: string;
    }, sourceRuntime: RemoteNodeRuntime): Promise<{ accepted: boolean }> {
        const target = await this.nodes.get(targetId);
        const runtime = this.nodes.runtimes.get(targetId);
        if (target.credentialState !== 'active' || target.status !== 'online' || !runtime ||
            !target.capabilities.includes('device.share.receive') ||
            !runtime.getCapabilities().includes('device.share.receive') ||
            typeof (runtime as RemoteNodeRuntime).deliverDeviceShare !== 'function')
            throw new AtlasError('Receiving device is offline or unavailable.', 'SHARE_TARGET_UNAVAILABLE');
        if (this.nodes.runtimes.get(sourceId) !== sourceRuntime)
            throw new AtlasError('Source Node disconnected.', 'NODE_DISCONNECTED');
        return (runtime as RemoteNodeRuntime).deliverDeviceShare(delivery);
    }
}
