import { useEffect, useState } from 'react';
import { callTool } from './api';
import './workspaces.css';
export type AtlasNode = {
    id: string; name: string; status: 'online' | 'offline' | 'unavailable';
    platform?: string; deviceType?: 'phone' | 'tablet'; version?: string | null; credentialState?: string; credentialUpdatedAt?: string | null;
    capabilities: string[]; lastSeen: string | null; hostedWorkspaceCount: number;
    workspaces?: { id: string; projectId: string | null; name: string; kind: string }[];
    activity?: {operation: string; createdAt: string}[];
};
const labels: Record<string, string> = { 'workspace.files': 'Filesystem', 'workspace.git': 'Git', 'workspace.dev': 'Development', unity: 'Unity' };
export function NodeStatus({ status }: { status: AtlasNode['status'] }) {
    return <span className={`badge ${status === 'online' ? 'success' : 'muted'}`}>{status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Unavailable'}</span>;
}
export function NodeCapabilities({ capabilities }: { capabilities: string[] }) {
    return <span className="node-capabilities">{capabilities.map(capability => <span key={capability} className="badge">{labels[capability] ?? capability}</span>)}{!capabilities.length && <span>No capabilities advertised</span>}</span>;
}
export function WorkspaceHost({ nodeId }: { nodeId: string }) {
    const [node, setNode] = useState<AtlasNode>();
    const [error, setError] = useState('');
    useEffect(() => {
        let live = true; setNode(undefined); setError('');
        callTool<AtlasNode>('get_node', { nodeId }).then(value => { if (live) setNode(value); }).catch(error => { if (live) setError(error.message); });
        return () => { live = false; };
    }, [nodeId]);
    return <div className="workspace-host"><span className="eyebrow">Host</span>{node ? <><p><a href="#/nodes">{node.name}</a> <NodeStatus status={node.status} /></p><NodeCapabilities capabilities={node.capabilities} /></> : <p>{error ? `Host unavailable: ${error}` : 'Loading host…'}</p>}</div>;
}
type NodePoint = { x: number; y: number };
function topologyPoints(count: number): NodePoint[] {
    if (count === 1) return [{ x: 500, y: 95 }];
    if (count === 2) return [{ x: 175, y: 300 }, { x: 825, y: 300 }];
    return Array.from({ length: count }, (_, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
        return { x: 500 + 300 * Math.cos(angle), y: 300 + 205 * Math.sin(angle) };
    });
}
function formatWhen(value: string | null | undefined) {
    return value ? new Date(value).toLocaleString() : 'Never connected';
}
function platformName(value: string | undefined) {
    if (value === 'darwin') return 'macOS';
    if (value === 'linux') return 'Linux';
    if (value === 'win32') return 'Windows';
    if (value === 'android') return 'Android';
    return value || 'Unknown OS';
}

function nodeIcon(node: AtlasNode) {
    if (node.platform === 'android') return node.deviceType === 'tablet' ? '▭' : '▯';
    return node.platform === 'darwin' ? '⌘' : node.platform === 'linux' ? '▤' : '▣';
}
function nodePlatformLabel(node: AtlasNode) {
    return node.platform === 'android' && node.deviceType ? `Android ${node.deviceType}` : platformName(node.platform);
}

function NodeSummary({ node, detail, nodes, loading, unavailable, onClear, onChange, onTicket }: {
    node?: AtlasNode; detail?: AtlasNode; nodes: AtlasNode[]; loading: boolean; unavailable: boolean; onClear: () => void;
    onChange: (action: () => Promise<unknown>, success: string) => Promise<void>;
    onTicket: (value: {enrolmentToken: string; expiresAt: string; nodeId: string | null}) => void;
}) {
    const online = nodes.filter(item => item.status === 'online').length;
    const disconnected = nodes.length - online;
    return <aside className="node-summary" aria-label={node ? 'Selected node' : 'Node health overview'}>
        {node ? <>
            <header className="node-summary-top">
                <span className="eyebrow">Selected node</span>
                <button className="node-summary-clear" type="button" aria-label="Clear node selection" onClick={onClear}>×</button>
            </header>
            <span className="node-summary-machine" aria-hidden="true">{nodeIcon(node)}</span>
            <h2 className="node-summary-name">{node.name}</h2>
            <div className="node-summary-state"><NodeStatus status={node.status} /><span>{nodePlatformLabel(node)}</span></div>
            <dl className="node-summary-metrics node-summary-selected-metrics">
                <div><dt>Workspaces</dt><dd>{detail?.hostedWorkspaceCount ?? node.hostedWorkspaceCount}</dd></div>
                <div><dt>Last seen</dt><dd className="node-summary-time">{formatWhen(node.lastSeen)}</dd></div>
            </dl>
            <section className="node-summary-capabilities" aria-label="Capabilities">
                <h3>Capabilities</h3>
                <NodeCapabilities capabilities={detail?.capabilities ?? node.capabilities} />
            </section>
            <section className="node-summary-manage" aria-label="Manage node">
                <h3>Manage node</h3>
                <div className="node-management-actions">
                    <button className="ghost" onClick={() => {
                        const name = window.prompt('Node name', node.name);
                        if (name?.trim()) void onChange(() => callTool('update_node', { nodeId: node.id, name: name.trim() }), 'Node renamed.');
                    }}>Rename</button>
                    <button className="ghost" onClick={() => {
                        if (window.confirm('Rotate ' + node.name + "'s credential? Its current connection will close.")) {
                            void onChange(async () => { onTicket(await callTool('rotate_node_credential', { nodeId: node.id })); }, 'Credential rotated. Enrol this Node again with the one-time code.');
                        }
                    }}>Rotate credential</button>
                    <button className="ghost danger" onClick={() => {
                        if (window.confirm('Revoke ' + node.name + '? Its current connection will close and assigned workspaces will be offline.')) {
                            void onChange(() => callTool('revoke_node', { nodeId: node.id }), 'Node credential revoked.');
                        }
                    }}>Revoke</button>
                </div>
            </section>
        </> : <>
            <span className="eyebrow">Status overview</span>
            <h2>{loading && !nodes.length ? 'Connecting to nodes…' : unavailable ? 'Status unavailable' : !nodes.length ? 'No nodes connected' : !disconnected ? 'All nodes online' : online + ' of ' + nodes.length + ' online'}</h2>
            <p className="node-summary-description">{unavailable ? 'Unable to load node health. Use Refresh to try again.' : !nodes.length ? 'Enrol a runtime to start monitoring your nodes here.' : disconnected ? 'Some runtimes are offline or unavailable. Select a node to inspect it.' : 'All registered runtimes are currently connected.'}</p>
            <dl className="node-summary-metrics">
                <div><dt>Online</dt><dd>{unavailable || (loading && !nodes.length) ? '—' : online}</dd></div>
                <div><dt>Offline / unavailable</dt><dd>{unavailable || (loading && !nodes.length) ? '—' : disconnected}</dd></div>
            </dl>
        </>}
    </aside>;
}

function NodeDetails({ node, detail, loading, detailError }: {
    node: AtlasNode; detail: AtlasNode | undefined; loading: boolean; detailError: string;
}) {
    const current = detail || node;
    return <section className="node-details" aria-label="Selected node details">
        <div className="node-details-heading"><h2>Node details</h2><span>{node.name}</span></div>
        {loading && <p className="node-detail-notice" role="status">Loading node details…</p>}
        {detailError && <p className="node-detail-notice" role="alert">Some details could not be loaded: {detailError}</p>}
        <div className="node-detail-grid">
            <section className="node-detail-card node-detail-workspaces">
                <h3>Hosted workspaces <span>{current.hostedWorkspaceCount}</span></h3>
                {detail?.workspaces?.length ? <ul className="node-workspace-list">{detail.workspaces.map(workspace => <li key={workspace.id}>
                    <a href={'#/workspaces?workspace=' + encodeURIComponent(workspace.id)}>{workspace.name}</a>
                </li>)}</ul> : <p className="node-detail-empty">{loading ? 'Loading workspaces…' : detail ? 'No active workspaces.' : detailError ? 'Workspace details unavailable.' : 'Loading workspace details…'}</p>}
            </section>
            <section className="node-detail-card node-detail-activity">
                <h3>Recent activity</h3>
                {detail?.activity?.length ? <ul className="node-activity-list">{detail.activity.map((item, index) => <li key={item.createdAt + '-' + index}><span>{item.operation}</span><time>{formatWhen(item.createdAt)}</time></li>)}</ul> : <p className="node-detail-empty">{loading ? 'Loading activity…' : detailError ? 'Activity unavailable.' : 'No recent activity.'}</p>}
            </section>
            <section className="node-detail-card node-detail-technical">
                <h3>Technical details</h3>
                <dl className="node-technical-list">
                    <div><dt>Node ID</dt><dd><code>{node.id}</code></dd></div>
                    <div><dt>Runtime version</dt><dd>{node.version || 'Not reported'}</dd></div>
                    <div><dt>Credential</dt><dd>{node.credentialState || 'Unknown'}</dd></div>
                    <div><dt>Credential updated</dt><dd>{formatWhen(node.credentialUpdatedAt)}</dd></div>
                    <div><dt>Last connected</dt><dd>{formatWhen(node.lastSeen)}</dd></div>
                </dl>
            </section>

        </div>
    </section>;
}
export function Nodes() {
    const [nodes, setNodes] = useState<AtlasNode[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.hash.split('?')[1] || '').get('node'));
    useEffect(() => {
        const restore = () => {
            const fromUrl = new URLSearchParams(window.location.hash.split('?')[1] || '').get('node');
            if (fromUrl) setSelectedId(fromUrl);
        };
        window.addEventListener('hashchange', restore);
        return () => window.removeEventListener('hashchange', restore);
    }, []);
    const [detail, setDetail] = useState<AtlasNode>();
    const [detailError, setDetailError] = useState('');
    const [detailLoading, setDetailLoading] = useState(false);
    const [error, setError] = useState('');
    const [registryError, setRegistryError] = useState(false);
    const [busy, setBusy] = useState(true);
    const [revision, setRevision] = useState(0);
    const [ticket, setTicket] = useState<{enrolmentToken: string; expiresAt: string; nodeId: string | null} | null>(null);
    const [message, setMessage] = useState('');
    useEffect(() => {
        let live = true;
        setBusy(true);
        setError('');
        setRegistryError(false);
        callTool<AtlasNode[]>('list_nodes').then(list => {
            if (!live) return;
            setNodes(list);
            setSelectedId(current => current && list.some(node => node.id === current) ? current : null);
        }).catch(error => { if (live) { setError(error instanceof Error ? error.message : String(error)); setRegistryError(true); } })
          .finally(() => { if (live) setBusy(false); });
        return () => { live = false; };
    }, [revision]);
    useEffect(() => {
        if (!selectedId) { setDetail(undefined); setDetailError(''); setDetailLoading(false); return; }
        let live = true;
        setDetail(undefined);
        setDetailError('');
        setDetailLoading(true);
        callTool<AtlasNode>('get_node', { nodeId: selectedId })
            .then(node => { if (live) setDetail(node); })
            .catch(error => { if (live) setDetailError(error instanceof Error ? error.message : String(error)); })
            .finally(() => { if (live) setDetailLoading(false); });
        return () => { live = false; };
    }, [selectedId, revision]);
    async function change(action: () => Promise<unknown>, success: string) {
        setError(''); setMessage('');
        try { await action(); setMessage(success); setRevision(value => value + 1); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    }
    async function enrol() {
        await change(async () => { setTicket(await callTool<typeof ticket>('create_node_enrolment', {})); }, 'Enrolment code issued. It expires in ten minutes.');
    }
    const selected = nodes.find(node => node.id === selectedId);
    const points = topologyPoints(nodes.length);
    const online = nodes.filter(node => node.status === 'online').length;
    return <div className="nodes-page">
        <header className="page-head"><div><h1>Nodes</h1></div>
            <div className="actions"><button onClick={() => void enrol()}>+ Enrol node</button><button className="ghost" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh</button></div>
        </header>
        {error && <p className="node-page-notice" role="alert">{error}</p>}
        {message && <p className="node-page-notice" role="status">{message}</p>}
        {ticket && <section className="node-enrolment" aria-label="One-time enrolment code">
            <div><strong>One-time enrolment code</strong><p>Use on the Node host before {new Date(ticket.expiresAt).toLocaleString()}. The private credential is issued during enrolment.</p>
            <code>{ticket.enrolmentToken}</code></div><button className="ghost" onClick={() => setTicket(null)}>Dismiss</button>
        </section>}
        <div className="node-topology-layout">
            <section className="node-network" aria-label="Node topology">
                <div className="node-network-header"><h2>Map</h2>
                    <span className="node-network-count"><span className={'node-network-status-dot' + (online ? '' : ' is-offline')} /> {busy ? 'Connecting…' : online + ' online / ' + nodes.length + ' nodes'}</span>
                </div>
                <div className="node-graph">
                    <svg className="node-connections" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
                        {nodes.map((node, index) => <g key={node.id}>
                            <line x1="500" y1="300" x2={points[index].x} y2={points[index].y} className={'node-connection ' + (node.status === 'online' ? 'is-online' : 'is-offline') + (node.id === selectedId ? ' is-selected' : '')} />
                            <circle cx={points[index].x} cy={points[index].y} r="4" className={'node-connection-end ' + (node.status === 'online' ? 'is-online' : '')} />
                        </g>)}
                    </svg>
                    <div className="node-server" aria-label="Atlas server control plane">
                        <span className="node-server-emblem" aria-hidden="true"><span>Ａ</span></span>
                        <strong>Atlas Server</strong>
                    </div>
                    {nodes.map((node, index) => <button key={node.id} className={'node-graph-card ' + node.status + (selectedId === node.id ? ' is-selected' : '')} style={{ left: (points[index].x / 10) + '%', top: (points[index].y / 6) + '%' }}
                        aria-label={'Inspect ' + node.name} aria-pressed={selectedId === node.id} onClick={() => setSelectedId(node.id)}>
                        <span className="node-graph-machine" aria-hidden="true">{nodeIcon(node)}</span>
                        <span className="node-graph-info"><strong title={node.name}>{node.name}</strong><small>{nodePlatformLabel(node)}</small></span>
                        <span className={'node-graph-presence ' + node.status} aria-hidden="true" />
                    </button>)}
                    {busy && !nodes.length && <p className="node-graph-loading" role="status">Loading nodes…</p>}
                    {!busy && !nodes.length && <div className="node-graph-empty"><strong>No nodes registered</strong><span>Enrol a runtime to connect it to Atlas.</span></div>}
                </div>
                <footer className="node-network-footer"><span><i className="node-legend-dot online" /> Online</span><span><i className="node-legend-dot offline" /> Offline / unavailable</span></footer>
            </section>
            <NodeSummary node={selected} detail={detail?.id === selected?.id ? detail : undefined} nodes={nodes} loading={busy} unavailable={registryError} onClear={() => setSelectedId(null)} onChange={change} onTicket={setTicket} />
        </div>
        {selected && <NodeDetails key={selected.id} node={selected} detail={detail?.id === selected.id ? detail : undefined}
            detailError={detailError} loading={detailLoading} />}
    </div>;
}
