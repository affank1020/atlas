import type { AtlasNode } from './Nodes';
import type { NodeRelease, NodeUpdateIntent } from './NodeSoftware';

/**
 * Explicit UI capability policy. Never infer install/approval permission from
 * a Node's advertised capabilities, online state or the presence of a release.
 * Future platform-specific update engines can add supported states here.
 */
export type SoftwareCapability = {
    platformLabel: string;
    distribution: 'published-archive' | 'not-available';
    preparation: 'request-only' | 'manual' | 'not-supported';
    execution: 'external-operator' | 'manual' | 'not-supported';
    description: string;
};

export function nodeSoftwareCapability(node: Pick<AtlasNode, 'platform' | 'deviceType'>): SoftwareCapability {
    switch (node.platform) {
        case 'linux':
            return { platformLabel:'Linux', distribution:'published-archive',
                preparation:'request-only',execution:'external-operator',
                description:'Atlas can prepare a request. Installation, root approval and reconciliation remain separate operator procedures.' };
        case 'darwin':
            return { platformLabel:'macOS',distribution:'published-archive',
                preparation:'manual',execution:'manual',
                description:'Verified archive inspection and installation remain manual. No managed macOS update execution is available.' };
        case 'android':
            return { platformLabel:node.deviceType ? 'Android '+node.deviceType : 'Android',
                distribution:'not-available',preparation:'not-supported',execution:'not-supported',
                description:'Stable signed APK distribution and managed update controls are not available yet.' };
        default:
            return { platformLabel:node.platform || 'Unknown platform',distribution:'not-available',
                preparation:'not-supported',execution:'not-supported',
                description:'This Node platform does not have a supported software distribution or management workflow.' };
    }
}

export function releaseForPlatform(releases: NodeRelease[], platform?: string) {
    return releases.find(item => item.platform === platform);
}

/** Unknown same-version builds must not be declared older merely by SHA mismatch. */
export function releaseUpdateState(installed: string | null | undefined, releases: NodeRelease[], platform?: string):
    'available' | 'current' | 'unknown' | 'newer' {
    const latest = releaseForPlatform(releases, platform);
    if (!installed || !latest) return 'unknown';
    const parsed = /^(\d+)\.(\d+)\.(\d+)(?:\+([a-f0-9]{12}))?$/.exec(installed);
    const target = /^(\d+)\.(\d+)\.(\d+)$/.exec(latest.version);
    if (!parsed || !target) return 'unknown';
    const currentNumbers = parsed.slice(1, 4).map(Number);
    const targetNumbers = target.slice(1, 4).map(Number);
    for (let i = 0; i < 3; i++) {
        if (currentNumbers[i]! < targetNumbers[i]!) return 'available';
        if (currentNumbers[i]! > targetNumbers[i]!) return 'newer';
    }
    if (parsed[4] === latest.commit) return 'current';
    if (parsed[4] && releases.some(release => release.platform === platform &&
        release.version === latest.version && release.commit === parsed[4]))
        return 'available';
    return 'unknown';
}

export type SoftwareIntentSnapshot =
    | { state:'loading' }
    | { state:'unavailable' }
    | { state:'ready'; records: NodeUpdateIntent[] };

export function effectiveIntentStatus(intent: NodeUpdateIntent, now: number):
    NodeUpdateIntent['status'] {
    if (intent.status !== 'requested') return intent.status;
    const expiry = Date.parse(intent.expiresAt);
    return !Number.isFinite(expiry) || expiry <= now ? 'expired' : 'requested';
}

export function latestSoftwareIntent(records: NodeUpdateIntent[], nodeId: string, now: number):
    NodeUpdateIntent | undefined {
    const scoped = records.filter(record => record.nodeId === nodeId);
    return scoped.find(item => effectiveIntentStatus(item, now) === 'claimed') ??
        scoped.find(item => effectiveIntentStatus(item, now) === 'requested') ??
        scoped[0];
}

export function lifecycleLabel(intent: NodeUpdateIntent | undefined, now: number) {
    if (!intent) return 'No recorded request';
    switch (effectiveIntentStatus(intent, now)) {
        case 'requested': return 'Request prepared';
        case 'claimed': return 'Operator reconciliation needed';
        case 'reconciled': return 'Operator acknowledged';
        case 'cancelled': return 'Request cancelled';
        case 'expired': return 'Request expired';
    }
}
