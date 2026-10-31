import { useEffect, useState } from 'react';
import { callTool } from './api';
import { Skeleton } from './Skeletons';
import type { AtlasNode } from './Nodes';
import type { NodeRelease, NodeUpdateIntent } from './NodeSoftware';
import {
    effectiveIntentStatus, latestSoftwareIntent, lifecycleLabel,
    nodeSoftwareCapability, releaseForPlatform, releaseUpdateState,
    type SoftwareIntentSnapshot,
} from './node-software-model';

type FleetState = { nodes: AtlasNode[]; loading: boolean; error: string | null };
type Filter = 'all' | 'review' | 'linux' | 'darwin' | 'android' | 'other';
type CatalogueSnapshot = { state: 'ready' | 'unavailable'; releases: NodeRelease[] } | undefined;

function useNodeSoftwareFleet(refreshGeneration: number) {
    const [fleet, setFleet] = useState<FleetState>({ nodes: [], loading: true, error: null });
    const [intents, setIntents] = useState<Record<string, SoftwareIntentSnapshot>>({});
    useEffect(() => {
        let active = true;
        const controller = new AbortController();
        let polling = false;
        let pollInterval: number | undefined;
        // Keep the last successful inventory visible during explicit refresh.
        setFleet(current => ({ ...current, loading: true, error: null }));
        setIntents({});
        void (async () => {
            try {
                const nodes = await callTool<AtlasNode[]>('list_nodes', {}, controller.signal);
                if (!active) return;
                const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
                setFleet({ nodes: sorted, loading: false, error: null });
                const linux = sorted.filter(node => node.platform === 'linux');
                setIntents(Object.fromEntries(linux.map(node => [node.id, { state: 'loading' as const }])));
                async function pollIntents() {
                    // Avoid overlapping polls (and unbounded requests) if the
                    // Server is slow. Old refresh generations never publish.
                    if (!active || polling) return;
                    polling = true;
                    try {
                        let next = 0;
                        await Promise.all(Array.from({ length: Math.min(3, linux.length) }, async () => {
                            while (active && next < linux.length) {
                                const node = linux[next++]!;
                                try {
                                    const records = await callTool<NodeUpdateIntent[]>('list_node_update_intents',
                                        { nodeId: node.id, limit: 20 }, controller.signal);
                                    if (!active) return;
                                    setIntents(current => ({
                                        ...current, [node.id]: {
                                            state:'ready', records:records.filter(record => record.nodeId === node.id),
                                        },
                                    }));
                                } catch {
                                    if (!active) return;
                                    // Never treat a failed poll as proof that a
                                    // claimed intent disappeared or was resolved.
                                    setIntents(current => ({ ...current, [node.id]: { state:'unavailable' } }));
                                }
                            }
                        }));
                    } finally {
                        polling = false;
                    }
                }
                await pollIntents();
                if (active && linux.length) {
                    // The Node can claim an intent or an operator can reconcile
                    // it without changing the registry snapshot or this route.
                    pollInterval = window.setInterval(() => { void pollIntents(); }, 5_000);
                }
            } catch (error) {
                if (active) setFleet({ nodes: [], loading:false,
                    error:error instanceof Error ? error.message : 'Node inventory unavailable.' });
            }
        })();
        return () => {
            active = false;
            // Abort in-flight reads before the next refresh generation starts.
            // Without transport cancellation, each Refresh could temporarily
            // add three more requests while old 30-second fetches linger.
            controller.abort();
            if (pollInterval !== undefined) window.clearInterval(pollInterval);
        };
    }, [refreshGeneration]);
    return { ...fleet, intents };
}

function latestStatus(node: AtlasNode, intentions: Record<string,SoftwareIntentSnapshot>, now: number) {
    const snapshot = intentions[node.id];
    return snapshot?.state === 'ready'
        ? latestSoftwareIntent(snapshot.records,node.id,now) : undefined;
}

function versionStatus(node: AtlasNode, catalogue: CatalogueSnapshot) {
    const capability = nodeSoftwareCapability(node);
    if (capability.distribution === 'not-available') return 'No stable distribution';
    if (catalogue?.state !== 'ready') return 'Release status unknown';
    if (!releaseForPlatform(catalogue.releases,node.platform)) return 'No published release';
    const state = releaseUpdateState(node.version,catalogue.releases,node.platform);
    if (state === 'available') return 'Newer release available';
    if (state === 'current') return 'Matches published release';
    if (state === 'newer') return 'Ahead of catalogue';
    return 'Cannot confirm release match';
}

function platformFilter(node: AtlasNode): Filter {
    return node.platform === 'linux' || node.platform === 'darwin' || node.platform === 'android'
        ? node.platform : 'other';
}

export function NodeSoftwareFleet({ catalogue, refreshGeneration, catalogueLoading }: {
    catalogue: CatalogueSnapshot;
    refreshGeneration: number;
    catalogueLoading: boolean;
}) {
    const { nodes, loading, error, intents } = useNodeSoftwareFleet(refreshGeneration);
    const [filter, setFilter] = useState<Filter>('all');
    const [selectedId, setSelectedId] = useState<string | null>(() =>
        new URLSearchParams(window.location.hash.split('?')[1] || '').get('node'));
    useEffect(() => {
        // App.tsx keeps this component mounted when the route query changes.
        // Match Nodes.tsx: browser history and cross-page deep links must
        // update the inspected Node without a page remount.
        const fromHash = () => setSelectedId(
            new URLSearchParams(window.location.hash.split('?')[1] || '').get('node'));
        window.addEventListener('hashchange', fromHash);
        return () => window.removeEventListener('hashchange', fromHash);
    }, []);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        // An expiry changes the meaning of a prepared request even with no
        // network response. Schedule the closest upcoming expiration exactly;
        // the five-second poll separately detects remote status transitions.
        let nextExpiry = Infinity;
        for (const snapshot of Object.values(intents)) {
            if (snapshot.state !== 'ready') continue;
            for (const record of snapshot.records) {
                if (record.status !== 'requested') continue;
                const expiry = Date.parse(record.expiresAt);
                if (Number.isFinite(expiry) && expiry > now) nextExpiry = Math.min(nextExpiry, expiry);
            }
        }
        if (!Number.isFinite(nextExpiry)) return;
        const timer = window.setTimeout(() => setNow(Date.now()),
            Math.min(2_147_483_647, Math.max(1, nextExpiry - Date.now() + 1)));
        return () => window.clearTimeout(timer);
    }, [intents, now]);
    useEffect(() => {
        // Refresh display-time checks if the tab stays open across a long
        // interval, even when a network poll returns unchanged records.
        const interval = window.setInterval(() => setNow(Date.now()), 5_000);
        return () => window.clearInterval(interval);
    }, []);
    const visible = nodes.filter(node => {
        if (filter === 'all') return true;
        if (filter === 'review') {
            const latest = latestStatus(node,intents,now);
            return latest ? effectiveIntentStatus(latest,now) === 'claimed' : false;
        }
        return platformFilter(node) === filter;
    });
    // A filter may hide the previously selected Node. Always inspect one
    // of the currently visible Nodes rather than showing a mismatched panel.
    const selected = visible.find(node => node.id === selectedId) ?? visible[0];
    const activeReviews = nodes.filter(node => {
        const latest = latestStatus(node,intents,now);
        return latest ? effectiveIntentStatus(latest,now) === 'claimed' : false;
    }).length;
    const checksPending = nodes.some(node => node.platform === 'linux' &&
        (!intents[node.id] || intents[node.id]!.state !== 'ready'));
    const selectedCapability = selected && nodeSoftwareCapability(selected);
    const selectedSnapshot = selected && intents[selected.id];
    const selectedHistory = selectedSnapshot?.state === 'ready' ? selectedSnapshot.records : [];
    const selectedIntent = selected && latestStatus(selected,intents,now);
    const selectedRelease = selected && catalogue?.state === 'ready'
        ? releaseForPlatform(catalogue.releases,selected.platform) : undefined;

    return <section className="node-software-fleet" aria-label="Node software fleet">
        <div className="node-software-section-heading">
            <div><p className="eyebrow">Management overview</p><h2>Software across your Nodes</h2>
                <p className="node-software-muted">Node-reported versions and requests, not independently verified installations.</p></div>
            <a className="ghost" href="#/nodes">Manage Node identities →</a>
        </div>
        <div className="node-software-metrics" aria-label="Software fleet summary">
            <div><span>Registered Nodes</span><strong>{loading && !nodes.length && !error ? <Skeleton width={42} height={26} /> : error ? 'Unknown' : nodes.length}</strong></div>
            <div><span>Online</span><strong>{loading && !nodes.length && !error ? <Skeleton width={42} height={26} /> : error ? 'Unknown' : nodes.filter(node => node.status === 'online').length}</strong></div>
            <div><span>Claimed updates needing operator review</span><strong>{loading && !nodes.length && !error ? <Skeleton width={42} height={26} /> : error ? 'Unknown' : checksPending ? '—' : activeReviews}</strong>
                {!loading && !error && checksPending && <small>Some Linux histories unavailable or still loading</small>}</div>
            <div><span>Published runtime platforms</span><strong>{catalogueLoading && !catalogue ? <Skeleton width={42} height={26} /> : catalogue?.state === 'ready'
                ? new Set(catalogue.releases.map(release => release.platform)).size : 'Unknown'}</strong></div>
        </div>
        {error && <p role="alert" className="node-page-notice">Node inventory unavailable: {error}</p>}
        {loading && nodes.length === 0 && !error && <div className="node-software-fleet-layout" role="status" aria-label="Loading registered Nodes" aria-busy="true">
            <div className="node-software-nodes">
                {Array.from({ length: 3 }, (_, index) => <div className="node-software-node node-software-node-skeleton" key={index} aria-hidden="true">
                    <Skeleton width="66%" height={16} />
                    <Skeleton width="45%" height={12} />
                    <Skeleton width="78%" height={12} />
                </div>)}
            </div>
            <div className="node-software-inspector" aria-hidden="true">
                <Skeleton width="48%" height={22} />
                <div className="node-software-inspector-facts">
                    {Array.from({ length: 4 }, (_, index) => <div key={index}>
                        <Skeleton width="60%" height={11} /><Skeleton width="80%" height={16} />
                    </div>)}
                </div>
            </div>
        </div>}
        {!loading && !error && nodes.length === 0 && <p className="node-software-empty">No Nodes are registered yet. <a href="#/nodes">Enrol a Node</a> to start managing its software.</p>}
        {!error && nodes.length > 0 && <>
            <div className="node-software-fleet-controls">
                <label htmlFor="software-node-filter">Show Nodes</label>
                <select id="software-node-filter" value={filter} onChange={event => setFilter(event.target.value as Filter)}>
                    <option value="all">All platforms</option>
                    <option value="review">Needs operator review</option>
                    <option value="linux">Linux</option>
                    <option value="darwin">macOS</option>
                    <option value="android">Android</option>
                    <option value="other">Other platforms</option>
                </select>
                <span>{visible.length} of {nodes.length} Nodes</span>
            </div>
            <div className="node-software-fleet-layout">
                <div className="node-software-nodes" role="group" aria-label="Select a Node to inspect">
                    {!visible.length && <p className="node-software-empty">No Nodes match this filter.</p>}
                    {visible.map(node => {
                        const capability = nodeSoftwareCapability(node);
                        const intent = latestStatus(node,intents,now);
                        const intentState = intents[node.id];
                        return <button key={node.id} type="button"
                            className={'node-software-node' + (selected?.id === node.id ? ' is-selected' : '')}
                            aria-pressed={selected?.id === node.id}
                            onClick={() => setSelectedId(node.id)}>
                            <span className="node-software-node-head"><strong>{node.name}</strong>
                                <span className={'badge ' + (node.status === 'online' ? 'success' : 'muted')}>{node.status}</span></span>
                            <span className="node-software-muted">{capability.platformLabel} · {node.version || 'Version not reported'}</span>
                            <span className="node-software-node-state">{versionStatus(node,catalogue)}</span>
                            {node.platform === 'linux' && <span className={'node-software-node-lifecycle'+
                                (intent && effectiveIntentStatus(intent,now)==='claimed' ? ' needs-review' : '')}>
                                {intentState?.state === 'ready' ? lifecycleLabel(intent,now)
                                    : intentState?.state === 'unavailable' ? 'Request history unavailable'
                                    : 'Checking update requests…'}
                            </span>}
                        </button>;
                    })}
                </div>
                <section className="node-software-inspector" aria-label="Selected Node software details">
                    {selected && selectedCapability ? <>
                        <div className="node-software-inspector-head">
                            <div><p className="eyebrow">Selected Node</p><h3>{selected.name}</h3>
                                <p className="node-software-muted">{selectedCapability.platformLabel} · {selected.status}</p></div>
                            <a className="ghost" href={'#/nodes?node='+encodeURIComponent(selected.id)}>Open Node details →</a>
                        </div>
                        <dl className="node-software-inspector-facts">
                            <div><dt>Installed (Node-reported)</dt><dd>{selected.version || 'Not reported'}</dd></div>
                            <div><dt>Last Node heartbeat</dt><dd>{selected.lastSeen && Number.isFinite(Date.parse(selected.lastSeen))
                                ? new Date(selected.lastSeen).toLocaleString() : 'Not recorded'}</dd></div>
                            <div><dt>Latest compatible archive</dt><dd>{catalogueLoading ? 'Checking…' :
                                selectedRelease ? selectedRelease.version+'+'+selectedRelease.commit : 'Not available'}</dd></div>
                            <div><dt>Release assessment</dt><dd>{versionStatus(selected,catalogue)}</dd></div>
                            <div><dt>Managed update execution</dt><dd>{selectedCapability.execution === 'external-operator'
                                ? 'Operator-only' : selectedCapability.execution === 'manual'
                                    ? 'Manual installation' : 'Not supported'}</dd></div>
                            <div><dt>Preparation</dt><dd>{selectedCapability.preparation === 'request-only'
                                ? 'Request only' : selectedCapability.preparation === 'manual' ? 'Manual' : 'Not supported'}</dd></div>
                            <div><dt>Last Atlas-verified successful update</dt><dd>Not recorded</dd></div>
                        </dl>
                        <p className="node-software-inspector-note">{selectedCapability.description}</p>
                        {selected.platform === 'linux' && <section className="node-software-history" aria-label="Linux update history">
                            <h4>Update requests and recovery</h4>
                            {selectedSnapshot?.state === 'loading' || !selectedSnapshot
                                ? <div className="node-software-history-list" role="status" aria-label="Loading update history" aria-busy="true">
                                    {Array.from({ length: 2 }, (_, index) => <div className="node-software-history-skeleton" key={index} aria-hidden="true">
                                        <Skeleton width="52%" height={13} /><Skeleton width="78%" height={11} />
                                    </div>)}
                                </div>
                                : selectedSnapshot.state === 'unavailable'
                                    ? <p role="alert">Update history unavailable. No lifecycle state can be confirmed.</p>
                                    : !selectedHistory.length
                                        ? <p>No update requests recorded.</p>
                                        : <>
                                            {selectedIntent && effectiveIntentStatus(selectedIntent,now) === 'claimed' &&
                                                <p className="node-software-review-note" role="status">
                                                    <strong>Operator reconciliation required.</strong> A claimed update blocks another request until trusted review.
                                                    {selectedIntent.reportedOutcome && <> Node-credential outcome:
                                                        {' '}{selectedIntent.reportedOutcome.reportedState} (unverified).</>}
                                                </p>}
                                            <ol className="node-software-history-list">
                                                {selectedHistory.slice(0,10).map(item => <li key={item.id}>
                                                    <div><strong>{lifecycleLabel(item,now)}</strong>
                                                        <span>{item.targetVersion}+{item.targetCommit}</span></div>
                                                    <small>Requested {Number.isFinite(Date.parse(item.createdAt))
                                                        ? new Date(item.createdAt).toLocaleString() : 'at an unknown time'}</small>
                                                    {item.reportedOutcome && <small>Node-credential report: {item.reportedOutcome.reportedState}
                                                        {' '}· Unverified; not proof of installation</small>}
                                                </li>)}
                                            </ol>
                                            {selectedHistory.length > 10 && <p className="node-software-muted">Showing 10 of {selectedHistory.length} recent requests.</p>}
                                        </>}
                        </section>}
                        <a href="#node-software-downloads">View release downloads and verification guidance ↓</a>
                    </> : <p className="node-software-empty">{visible.length ? 'Select a Node to inspect.' : 'No Nodes match this filter.'}</p>}
                </section>
            </div>
        </>}
    </section>;
}
