import { useEffect, useRef, useState } from 'react';
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
export type NodeUpdateIntent = {
    id: string; nodeId: string;
    targetVersion: string; targetCommit: string; installedVersion: string;
    status: 'requested' | 'cancelled' | 'expired' | 'claimed' | 'reconciled';
    createdAt: string; expiresAt: string;
    approved: false; executable: false;
    reportedOutcome?: { intentId: string; nodeId: string;
        reportedState: 'activated' | 'requires_reconciliation';
        reportedAt: string; verified: false; clearsClaim: false };
};

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
    // Eligibility is snapshot-scoped. The durable intention belongs to the
    // Node ID, not to its currently reported version or connection state.
    const nodeSnapshot = JSON.stringify([node.id, node.platform, node.version, node.status, node.credentialState, node.credentialUpdatedAt]);
    const preflightGeneration = useRef(0);
    const intentReadGeneration = useRef(0);
    const intentMutationGeneration = useRef(0);
    const intentMutationBusy = useRef(false);
    const [preflight, setPreflight] = useState<{ snapshot: string; result?: LinuxNodeUpdatePlan; error?: string; busy?: boolean }>();
    const currentPreflight = preflight?.snapshot === nodeSnapshot ? preflight : undefined;
    const [intention, setIntention] = useState<{
        nodeId: string; loading?: boolean; busy?: boolean; result?: NodeUpdateIntent; error?: string;
    }>();
    const currentIntent = intention?.nodeId === node.id ? intention : undefined;
    const [clock, setClock] = useState(() => Date.now());
    const storedIntent = currentIntent?.result;
    const expiresAt = storedIntent?.status === 'requested' ? Date.parse(storedIntent.expiresAt) : NaN;
    const intentStatus = storedIntent?.status === 'requested' &&
        (!Number.isFinite(expiresAt) || expiresAt <= clock) ? 'expired' : storedIntent?.status;
    const hasPendingIntent = intentStatus === 'requested' || intentStatus === 'claimed';

    function refreshIntents(nodeId: string, silent = false): Promise<void> {
        const generation = ++intentReadGeneration.current;
        if (!silent) setIntention(current => ({
            ...(current?.nodeId === nodeId ? current : { nodeId }),
            nodeId, loading: true,
        }));
        return callTool<NodeUpdateIntent[]>('list_node_update_intents', { nodeId, limit: 20 })
            .then(items => {
                if (intentReadGeneration.current !== generation) return;
                const scoped = items.filter(item => item.nodeId === nodeId);
                const active = scoped.find(item => item.status === 'claimed' ||
                    (item.status === 'requested' && Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) > Date.now()));
                setClock(Date.now());
                setIntention(current => current?.nodeId === nodeId ? {
                    ...current, result: active ?? scoped[0], loading: false, error: undefined,
                } : current);
            }).catch(cause => {
                if (intentReadGeneration.current !== generation) return;
                setIntention(current => current?.nodeId === nodeId ? {
                    ...current, loading: false,
                    error: 'Unable to load update requests: ' + (cause instanceof Error ? cause.message : String(cause)),
                } : current);
            });
    }

    useEffect(() => {
        setPreflight(undefined);
        ++preflightGeneration.current;
        // Preserve any known intention while reloading its authoritative
        // state. A status/version/credential refresh must not orphan it.
        if (node.platform === 'linux') refreshIntents(node.id);
        else {
            ++intentReadGeneration.current;
            setIntention(undefined);
        }
        return () => { ++preflightGeneration.current; ++intentReadGeneration.current; };
    }, [nodeSnapshot]);

    useEffect(() => {
        // A mutation must survive a same-ID Node refresh or an unrelated
        // eligibility check. It must not update a different Node after switch.
        return () => { ++intentMutationGeneration.current; intentMutationBusy.current = false; };
    }, [node.id]);

    useEffect(() => {
        // A native Node can claim an intent without changing the Node's
        // reported version or connection snapshot. Reconcile while a request
        // is pending; otherwise the operator sees a stale Cancel button.
        // Background polls leave the current status visible while fetching.
        // Poll claimed intents even after a Node-reported outcome: the
        // separate operator terminal may reconcile them without changing
        // the Node version or connection snapshot.
        if (node.platform !== 'linux' ||
            (intentStatus !== 'requested' && intentStatus !== 'claimed')) return;
        let inFlight = false;
        const interval = window.setInterval(() => {
            if (inFlight || intentMutationBusy.current) return;
            inFlight = true;
            void refreshIntents(node.id, true).finally(() => { inFlight = false; });
        }, 5_000);
        return () => window.clearInterval(interval);
    }, [node.id, nodeSnapshot, intentStatus]);

    useEffect(() => {
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
        const timeout = window.setTimeout(() => {
            setClock(Date.now());
            refreshIntents(node.id);
        }, Math.min(2_147_483_647, Math.max(1, expiresAt - Date.now() + 1)));
        return () => window.clearTimeout(timeout);
    }, [node.id, expiresAt]);

    function checkReadiness() {
        const nodeId = node.id;
        const snapshot = nodeSnapshot;
        const generation = ++preflightGeneration.current;
        setPreflight({ snapshot, busy: true });
        void callTool<LinuxNodeUpdatePlan>('plan_node_update', { nodeId })
            .then(result => {
                if (preflightGeneration.current !== generation) return;
                setPreflight(current => current?.snapshot === snapshot ? { snapshot, result } : current);
            })
            .catch(cause => {
                if (preflightGeneration.current !== generation) return;
                setPreflight(current => current?.snapshot === snapshot
                    ? { snapshot, error: cause instanceof Error ? cause.message : String(cause) } : current);
            });
    }

    function prepareIntent() {
        const candidate = currentPreflight?.result?.candidate;
        if (currentPreflight?.result?.status !== 'candidate' || !candidate || !node.version ||
            currentIntent?.loading || hasPendingIntent || intentMutationBusy.current) return;
        if (!window.confirm('Record a 15-minute Linux Node update request for ' + node.name +
            ' to v' + candidate.version + '+' + candidate.commit +
            '? This only records an intention. No Node installation, approval or restart will occur.')) return;
        intentMutationBusy.current = true;
        ++intentReadGeneration.current; // an older list response cannot overwrite the mutation
        const generation = ++intentMutationGeneration.current;
        const nodeId = node.id;
        setIntention(current => ({
            ...(current?.nodeId === nodeId ? current : { nodeId }),
            nodeId, loading: false, busy: true, error: undefined,
        }));
        void callTool<NodeUpdateIntent>('prepare_node_update', {
            nodeId, expectedVersion: node.version, expectedCredentialUpdatedAt: node.credentialUpdatedAt ?? null,
            targetCommit: candidate.commit,
        }).then(result => {
            if (intentMutationGeneration.current !== generation) return;
            setClock(Date.now());
            setIntention(current => current?.nodeId === nodeId
                ? { nodeId, result, busy: false, loading: false } : current);
        }).catch(cause => {
            if (intentMutationGeneration.current !== generation) return;
            setIntention(current => current?.nodeId === nodeId ? {
                ...current, busy: false, error: cause instanceof Error ? cause.message : String(cause),
            } : current);
        }).finally(() => {
            if (intentMutationGeneration.current !== generation) return;
            intentMutationBusy.current = false;
            // Always reconcile: a network failure might happen AFTER the
            // server committed the request, or while a readiness check ran.
            refreshIntents(nodeId);
        });
    }

    function cancelIntent() {
        if (!storedIntent || !hasPendingIntent || intentMutationBusy.current) return;
        intentMutationBusy.current = true;
        ++intentReadGeneration.current;
        const generation = ++intentMutationGeneration.current;
        const { id: intentId, nodeId } = storedIntent;
        setIntention(current => current?.nodeId === nodeId
            ? { ...current, busy: true, loading: false, error: undefined } : current);
        void callTool<NodeUpdateIntent>('cancel_node_update_intent', { nodeId, intentId })
            .then(result => {
                if (intentMutationGeneration.current !== generation) return;
                setIntention(current => current?.nodeId === nodeId
                    ? { nodeId, result, busy: false, loading: false } : current);
            }).catch(cause => {
                if (intentMutationGeneration.current !== generation) return;
                setIntention(current => current?.nodeId === nodeId ? {
                    ...current, busy: false, error: cause instanceof Error ? cause.message : String(cause),
                } : current);
            }).finally(() => {
                if (intentMutationGeneration.current !== generation) return;
                intentMutationBusy.current = false;
                refreshIntents(nodeId);
            });
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
            {currentIntent?.loading && <p role="status">Loading saved update requests…</p>}
            {currentPreflight?.result?.status === 'candidate' && currentPreflight.result.candidate &&
                !hasPendingIntent && !currentIntent?.loading &&
                <button className="ghost" type="button" onClick={prepareIntent} disabled={currentIntent?.busy === true || Boolean(currentIntent?.error)}>
                    {currentIntent?.busy ? 'Recording request…' : 'Prepare update request (no installation)'}
                </button>}
            {storedIntent && <div className="node-update-intent" role="status">
                <strong>Update request: {intentStatus}</strong>
                <p>Target v{storedIntent.targetVersion}+{storedIntent.targetCommit}.
                    {intentStatus === 'requested' ? ' Expires ' + new Date(storedIntent.expiresAt).toLocaleString() + '.' : ''}
                    {' '}{intentStatus === 'claimed'
                        ? 'Reserved by the Node identity. This is not a host approval or proof of installation; reconciliation is required before preparing another update.'
                        : intentStatus === 'reconciled'
                            ? ' Closed after explicit administrator review of root-signed evidence and independent host checks. This is operator-acknowledged closure, not Atlas-measured health.'
                            : 'Not approved. No installation or restart will occur.'}</p>
                {intentStatus === 'claimed' && storedIntent.reportedOutcome && <p>
                    Host-reported outcome: {storedIntent.reportedOutcome.reportedState === 'activated'
                        ? 'activation reported' : 'requires reconciliation'}.
                    {' '}<strong>Unverified Node-credential report.</strong> It does not prove host execution,
                    release health or administrator approval, and does not clear the update lock.
                </p>}
                {intentStatus === 'requested' &&
                    <button type="button" className="ghost" disabled={currentIntent?.busy === true || currentIntent?.loading === true} onClick={cancelIntent}>
                        Cancel update request
                    </button>}
            </div>}
            {currentIntent?.error && <p role="alert">Update request error: {currentIntent.error} <button type="button" className="ghost" onClick={() => refreshIntents(node.id)}>Reload requests</button></p>}
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
