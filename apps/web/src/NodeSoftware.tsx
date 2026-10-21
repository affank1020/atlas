import { useEffect, useState } from 'react';
import { callTool } from './api';
import type { AtlasNode } from './Nodes';
import './node-software.css';

export type NodeRelease = {
    component: 'desktop-node';
    version: string;
    commit: string;
    platform: 'linux' | 'darwin';
    architecture: 'any';
    channel: 'stable';
    protocol: number;
    minimumNodeJs: number;
    publishedAt: string;
    notes: string;
    downloadUrl: string;
    checksumUrl: string;
    sha256: string;
    releaseUrl: string;
    provenance: 'unverified';
};
type Catalogue = { state: 'ready' | 'unavailable'; releases: NodeRelease[]; checkedAt: string; error?: string };
export type LinuxNodeUpdatePlan = {
    nodeId: string;
    status: 'unsupported' | 'offline' | 'unavailable' | 'current' | 'ahead' | 'unknown' | 'candidate';
    reason: string;
    candidate: NodeRelease | null;
    canInstall: false;
    canActivate: false;
    provenanceVerified: false;
};


function useSoftwareCatalogue() {
    const [catalogue, setCatalogue] = useState<Catalogue>();
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        let live = true;
        setLoading(true);
        setError('');
        callTool<Catalogue>('list_node_releases', revision ? { refresh: true } : {})
            .then(result => { if (live) setCatalogue(result); })
            .catch(cause => { if (live) { setCatalogue(undefined); setError(cause instanceof Error ? cause.message : String(cause)); } })
            .finally(() => { if (live) setLoading(false); });
        return () => { live = false; };
    }, [revision]);
    return { catalogue, error, loading, refresh: () => setRevision(value => value + 1) };
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
    if (parsed[4] && releases.some(release => release.platform === platform && release.version === latest.version && release.commit === parsed[4]))
        return 'available';
    return 'unknown';
}

export function NodeSoftwareSummary({ node }: { node: AtlasNode }) {
    const { catalogue, error, loading } = useSoftwareCatalogue();
    const [preflight, setPreflight] = useState<{ nodeId: string; result?: LinuxNodeUpdatePlan; error?: string; busy?: boolean }>();
    const currentPreflight = preflight?.nodeId === node.id ? preflight : undefined;
    function checkReadiness() {
        const nodeId = node.id;
        setPreflight({ nodeId, busy: true });
        void callTool<LinuxNodeUpdatePlan>('plan_node_update', { nodeId })
            .then(result => setPreflight({ nodeId, result }))
            .catch(cause => setPreflight({ nodeId, error: cause instanceof Error ? cause.message : String(cause) }));
    }
    const latest = releaseForPlatform(catalogue?.releases ?? [], node.platform);
    const status = catalogue?.state === 'ready' ? releaseUpdateState(node.version, catalogue.releases, node.platform) : 'unknown';
    return <section className="node-detail-card node-detail-software" aria-label="Node software">
        <h3>Software</h3>
        <dl className="node-software-summary">
            <div><dt>Installed</dt><dd>{node.version || 'Not reported'}</dd></div>
            <div><dt>Latest compatible</dt><dd>{loading ? 'Checking…' : latest ? latest.version + '+' + latest.commit : 'Not available'}</dd></div>
            <div><dt>Update</dt><dd>{status === 'available' ? 'Newer release available' : status === 'current' ? 'Current release' : status === 'newer' ? 'Newer than catalogue' : 'Cannot confirm'}</dd></div>
            <div><dt>Last successful update</dt><dd>Not recorded</dd></div>
            <div><dt>Update control</dt><dd>Not enabled for this Node</dd></div>
        </dl>
        {(error || catalogue?.state === 'unavailable') && <p className="node-detail-empty" role="status">Release lookup unavailable.</p>}
        {node.platform === 'linux' && <div className="node-software-preflight">
            <button className="ghost" type="button" onClick={checkReadiness} disabled={currentPreflight?.busy === true}>
                {currentPreflight?.busy ? 'Checking…' : 'Check Linux update eligibility'}
            </button>
            {currentPreflight?.result && <p role="status"><strong>{currentPreflight.result.status === 'candidate' ? 'Candidate identified' : 'No update approved'}:</strong> {currentPreflight.result.reason} <span>Update execution is not enabled.</span></p>}
            {currentPreflight?.error && <p role="alert">Unable to check update eligibility: {currentPreflight.error}</p>}
        </div>}
        <a href="#/nodes/software">View downloads and release notes →</a>
    </section>;
}

function PlatformRelease({ title, platform, catalogue }: { title: string; platform: 'darwin' | 'linux'; catalogue: Catalogue | undefined }) {
    const release = releaseForPlatform(catalogue?.releases ?? [], platform);
    return <section className="node-software-card" aria-label={title}>
        <div className="node-software-card-title"><div><p className="eyebrow">{platform === 'linux' ? 'systemd' : 'launchd'}</p><h2>{title}</h2></div><span className="badge">{release ? 'Published archive' : 'No eligible release'}</span></div>
        {release ? <>
            <p><strong>v{release.version}</strong> <span className="node-software-muted">Build {release.commit} · protocol {release.protocol} · Node.js {release.minimumNodeJs}+ · any CPU architecture</span></p>
            <p className="node-software-muted">Published {new Date(release.publishedAt).toLocaleString()} · {release.channel}</p>
            <div className="node-software-actions">
                <a href={release.downloadUrl} target="_blank" rel="noopener noreferrer" className="node-software-download">Download release archive ↗</a>
                <a href={release.checksumUrl} target="_blank" rel="noopener noreferrer">SHA-256 file ↗</a>
                <a href={release.releaseUrl} target="_blank" rel="noopener noreferrer">Release notes ↗</a>
            </div>
            <p className="node-software-digest">SHA-256 <code>{release.sha256}</code></p>
            <p className="node-software-muted" role="status">Build provenance is unverified by Atlas. A GitHub SHA-256 asset digest is not proof of who built the archive. Verify the attestation against the expected repository and build workflow before installing.</p>
            <details className="node-software-instructions"><summary>Verification and installation</summary>
                <p>Download both files to the same directory. Verify checksum and source provenance before installing:</p>
                <pre>{['shasum -a 256 -c atlas-node-v' + release.version + '-' + release.commit + '.tar.gz.sha256', 'gh attestation verify atlas-node-v' + release.version + '-' + release.commit + '.tar.gz --repo affank1020/atlas'].join('\n')}</pre>
                {platform === 'linux' ? <p>Run the existing <code>scripts/linux-node-release.sh verify</code> and <code>install</code> commands to stage the archive; use <code>linux-node-lifecycle.sh plan</code> and <code>activate</code> for a separate, explicit, health-checked activation. Installation never updates Atlas Server or PostgreSQL.</p> :
                    <p>Extract to a separate private directory, run the bundle’s documented <code>npm ci --omit=dev --ignore-scripts</code> installation, and configure the existing Node identity and launchd process manually. Automatic macOS replacement and rollback are not yet available; do not overwrite a running checkout.</p>}
                <p><a href="https://github.com/affank1020/atlas/blob/main/docs/NODE_RELEASES.md" target="_blank" rel="noopener noreferrer">Full installation guide ↗</a></p>
            </details>
        </> : <p className="node-software-muted">There is no published immutable archive with a recorded SHA-256 digest for this platform yet. No development or expired CI artifacts are offered.</p>}
    </section>;
}

export function NodeSoftware() {
    const { catalogue, error, loading, refresh } = useSoftwareCatalogue();
    return <div className="nodes-page node-software-page">
        <header className="page-head"><div><p className="eyebrow">Nodes / software</p><h1>Node Software</h1><p>Published runtime archives. Verify checksums and build provenance before installation.</p></div>
            <div className="actions"><a className="ghost" href="#/nodes">← Nodes</a><button className="ghost" disabled={loading} onClick={refresh}>Refresh</button></div></header>
        {loading && <p role="status">Checking published GitHub releases…</p>}
        {(error || catalogue?.state === 'unavailable') && <p className="node-page-notice" role="alert">{error || catalogue?.error || 'Release catalogue unavailable.'}</p>}
        <div className="node-software-grid">
            <PlatformRelease title="macOS Node" platform="darwin" catalogue={catalogue?.state === 'ready' ? catalogue : undefined} />
            <PlatformRelease title="Linux Node" platform="linux" catalogue={catalogue?.state === 'ready' ? catalogue : undefined} />
            <section className="node-software-card" aria-label="Android Node">
                <div className="node-software-card-title"><div><p className="eyebrow">Coming later</p><h2>Android Node</h2></div><span className="badge muted">Unavailable</span></div>
                <p className="node-software-muted">Android development APKs are not production-signed. Atlas will offer a direct APK and QR download only after a stable signing identity, verified release and install testing exist.</p>
            </section>
        </div>
        <p className="node-software-muted">Downloads do not install or restart anything. Updates from Atlas are not enabled yet. Atlas Server, desktop Nodes, Android and wire protocol are versioned independently.</p>
    </div>;
}
