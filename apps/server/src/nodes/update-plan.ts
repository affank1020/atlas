import type { AtlasNode } from './model.js';
import type { NodeRelease, NodeReleaseCatalogue } from './releases.js';

/**
 * Read-only Linux update eligibility. This is a *candidate* computation, not
 * an authorisation to download, install or restart software.
 *
 * Version/build ordering is derived only from the stable catalogue. Unknown
 * same-version SHAs never become downgrade recommendations.
 */
export type NodeUpdatePlanStatus = 'unsupported' | 'offline' | 'unavailable' |
    'current' | 'ahead' | 'unknown' | 'candidate';

export type NodeUpdatePlan = {
    nodeId: string;
    platform: string;
    installedVersion: string | null;
    status: NodeUpdatePlanStatus;
    reason: string;
    candidate: NodeRelease | null;
    /** Deliberately false until host-side verification and authorisation exist. */
    canInstall: false;
    canActivate: false;
    provenanceVerified: false;
};

const INSTALLED = /^(\d+)\.(\d+)\.(\d+)(?:\+([a-f0-9]{12}))?$/;

function cmp(a: number[], b: number[]) {
    for (let i = 0; i < 3; i++) {
        if (a[i]! !== b[i]!) return Math.sign(a[i]! - b[i]!);
    }
    return 0;
}
function parts(version: string): number[] | undefined {
    const m = INSTALLED.exec(version);
    if (!m) return undefined;
    const nums = [Number(m[1]), Number(m[2]), Number(m[3])];
    return nums.every(Number.isSafeInteger) ? nums : undefined;
}

export function buildNodeUpdatePlan(node: Pick<AtlasNode, 'id' | 'platform' | 'status' | 'version' | 'credentialState' | 'metadata'>,
    catalogue: Pick<NodeReleaseCatalogue, 'state' | 'releases'>): NodeUpdatePlan {
    const result = (status: NodeUpdatePlanStatus, reason: string, candidate: NodeRelease | null = null): NodeUpdatePlan =>
        ({ nodeId: node.id, platform: node.platform, installedVersion: node.version,
            status, reason, candidate, canInstall: false, canActivate: false, provenanceVerified: false });

    if (node.platform !== 'linux') return result('unsupported', 'Only remote Linux Nodes have an update plan in this phase.');
    if (node.metadata.runtime !== 'remote') return result('unsupported', 'This Node is not registered as a remote runtime.');
    if (node.credentialState !== 'active') return result('offline', 'Node credential is not active.');
    if (node.status !== 'online') return result('offline', 'Node is not connected. Update planning requires an online Node.');
    if (catalogue.state !== 'ready') return result('unavailable', 'Published release catalogue is unavailable.');
    const releases = catalogue.releases.filter(r => r.platform === 'linux' && r.protocol === 2 && r.channel === 'stable');
    const latest = releases[0];
    if (!latest) return result('unavailable', 'No eligible immutable stable Linux release is published.');
    if (!node.version) return result('unknown', 'Node has not reported its installed runtime version.');
    const installedParts = parts(node.version);
    const targetParts = parts(latest.version);
    if (!installedParts || !targetParts) return result('unknown', 'Installed or release version is not comparable to stable SemVer.');
    const relation = cmp(installedParts, targetParts);
    if (relation > 0) return result('ahead', 'Installed Node version is newer than the available stable release.');
    if (relation < 0) return result('candidate', 'A newer stable Linux release is available; provenance and host approval remain unverified.', latest);

    const installedMatch = INSTALLED.exec(node.version)!;
    const installedCommit = installedMatch[4];
    if (!installedCommit) return result('unknown', 'Installed build commit is missing; cannot compare same-version builds.');
    if (installedCommit === latest.commit) return result('current', 'Node reports the latest published stable build.');
    const installedRelease = releases.find(r => r.version === latest.version && r.commit === installedCommit);
    if (!installedRelease) return result('unknown', 'Installed same-version build is absent from the ordered release catalogue.');
    if (installedRelease.sourceOrder >= latest.sourceOrder)
        return result(installedRelease.sourceOrder > latest.sourceOrder ? 'ahead' : 'unknown',
            'Catalogue does not prove the selected release is newer than the installed build.');
    return result('candidate', 'A newer stable build of the same version is available; provenance and host approval remain unverified.', latest);
}
