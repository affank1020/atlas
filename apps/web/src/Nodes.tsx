import { useEffect, useState } from 'react';
import { callTool } from './api';
import { RecentActivityPreview } from './RecentActivityPreview';
import { monitoringHash } from './monitoringLinks';
import './workspaces.css';
export type AtlasNode = {
    id: string; name: string; status: 'online' | 'offline' | 'unavailable';
    platform?: string; version?: string | null; credentialState?: string; credentialUpdatedAt?: string | null;
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
        return { x: 500 + 325 * Math.cos(angle), y: 300 + 205 * Math.sin(angle) };
    });
}
function formatWhen(value: string | null | undefined) {
    return value ? new Date(value).toLocaleString() : 'Never connected';
}
function platformName(value: string | undefined) {
    if (value === 'darwin') return 'macOS';
    if (value === 'linux') return 'Linux';
    if (value === 'win32') return 'Windows';
    return value || 'Unknown OS';
}
function NodeInspector({ node, detail, loading, detailError, nodes, revision, onClose, onChange, onTicket }: {
    node: AtlasNode; detail: AtlasNode | undefined; loading: boolean; detailError: string;
    nodes: AtlasNode[]; revision: number; onClose: () => void;
    onChange: (action: () => Promise<unknown>, success: string) => Promise<void>;
    onTicket: (value: {enrolmentToken: string; expiresAt: string; nodeId: string | null}) => void;
}) {
    const current = detail || node;
    return <aside className="node-inspector" aria-label="Node details">
        <header className="node-inspector-head">
            <span className="eyebrow">Node inspector</span>
            <button className="node-inspector-close" aria-label="Close node details" onClick={onClose}>×</button>
        </header>
        <div className="node-inspector-identity">
            <span className={'node-inspector-machine ' + (node.status === 'online' ? 'is-online' : '')} aria-hidden="true">▣</span>
            <h2>{node.name}</h2>
            <div className="node-inspector-state"><NodeStatus status={node.status} /><span>{platformName(node.platform)}</span></div>
        </div>
        <dl className="node-inspector-stats">
            <div><dt>Workspaces</dt><dd>{current.hostedWorkspaceCount}</dd></div>
            <div><dt>Last seen</dt><dd>{node.lastSeen ? new Date(node.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Never'}</dd></div>
        </dl>
        {loading && <p className="node-inspector-notice" role="status">Loading node details…</p>}
        {detailError && <p className="node-inspector-notice" role="alert">Some details could not be loaded: {detailError}</p>}
        <section className="node-inspector-section">
            <h3>Capabilities <span>{current.capabilities.length}</span></h3>
            <NodeCapabilities capabilities={current.capabilities} />
        </section>
        <section className="node-inspector-section">
            <h3>Hosted workspaces <span>{current.hostedWorkspaceCount}</span></h3>
            {detail?.workspaces?.length ? <ul className="node-workspace-list">{detail.workspaces.map(workspace => <li key={workspace.id}>
                <a href={'#/workspaces?workspace=' + encodeURIComponent(workspace.id)}>{workspace.name}</a>
                <select aria-label={'Assign ' + workspace.name + ' to Node'} value={node.id} onChange={event => {
                    const target = event.target.value;
                    if (target === node.id) return;
                    if (window.confirm('Move ' + workspace.name + ' to ' + nodes.find(item => item.id === target)?.name + '?')) {
                        void onChange(() => callTool('assign_workspace_node', { projectId: workspace.projectId, workspaceId: workspace.id, nodeId: target, expectedNodeId: node.id }), 'Workspace placement updated.');
                    }
                }}>
                    <option value={node.id}>{node.name}</option>
                    {nodes.filter(target => target.id !== node.id && target.credentialState === 'active').map(target => <option value={target.id} key={target.id}>{target.name}</option>)}
                </select>
            </li>)}</ul> : <p className="node-inspector-empty">{loading ? 'Loading workspaces…' : detail ? 'No active workspaces.' : 'Select to load workspace details.'}</p>}
        </section>
        <div className="node-inspector-section">
            <RecentActivityPreview title="Recent activity" filters={{ nodeId: node.id }} count={4} compact refreshVersion={revision} />
            <a className="monitoring-context-link" href={monitoringHash('logs', { nodeId: node.id })}>Open Node logs in Monitoring ↗</a>
        </div>
        <details className="node-inspector-advanced">
            <summary>Technical details</summary>
            <dl>
                <div><dt>Node ID</dt><dd><code>{node.id}</code></dd></div>
                <div><dt>Runtime version</dt><dd>{node.version || 'Not reported'}</dd></div>
                <div><dt>Credential</dt><dd>{node.credentialState || 'Unknown'}</dd></div>
                <div><dt>Credential updated</dt><dd>{formatWhen(node.credentialUpdatedAt)}</dd></div>
                <div><dt>Last connected</dt><dd>{formatWhen(node.lastSeen)}</dd></div>
            </dl>
        </details>
        <details className="node-inspector-advanced node-inspector-manage">
            <summary>Manage node</summary>
            <p>Changes here affect this runtime and its assigned workspaces.</p>
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
        </details>
    </aside>;
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
    const [busy, setBusy] = useState(true);
    const [revision, setRevision] = useState(0);
    const [ticket, setTicket] = useState<{enrolmentToken: string; expiresAt: string; nodeId: string | null} | null>(null);
    const [message, setMessage] = useState('');
    useEffect(() => {
        let live = true;
        setBusy(true);
        setError('');
        callTool<AtlasNode[]>('list_nodes').then(list => {
            if (!live) return;
            setNodes(list);
            setSelectedId(current => current && list.some(node => node.id === current) ? current : null);
        }).catch(error => { if (live) setError(error instanceof Error ? error.message : String(error)); })
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
        <header className="page-head"><div><p className="eyebrow">Infrastructure / topology</p><h1>Node network</h1><p>Your Atlas control plane and connected workspace runtimes.</p></div>
            <div className="actions"><button onClick={() => void enrol()}>+ Enrol node</button><button className="ghost" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh</button></div>
        </header>
        {error && <p className="node-page-notice" role="alert">{error}</p>}
        {message && <p className="node-page-notice" role="status">{message}</p>}
        {ticket && <section className="node-enrolment" aria-label="One-time enrolment code">
            <div><strong>One-time enrolment code</strong><p>Use on the Node host before {new Date(ticket.expiresAt).toLocaleString()}. The private credential is issued during enrolment.</p>
            <code>{ticket.enrolmentToken}</code></div><button className="ghost" onClick={() => setTicket(null)}>Dismiss</button>
        </section>}
        <div className={'node-topology-layout' + (selected ? ' has-selection' : '')}>
            <section className="node-network" aria-label="Node topology">
                <div className="node-network-header"><div><span className="eyebrow">Network overview</span><h2>Atlas infrastructure</h2></div>
                    <span className="node-network-count"><span className="node-network-status-dot" /> {busy ? 'Connecting…' : online + ' online / ' + nodes.length + ' nodes'}</span>
                </div>
                <div className="node-graph">
                    <div className="node-orbit node-orbit-one" aria-hidden="true" />
                    <div className="node-orbit node-orbit-two" aria-hidden="true" />
                    <svg className="node-connections" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
                        {nodes.map((node, index) => <g key={node.id}>
                            <line x1="500" y1="300" x2={points[index].x} y2={points[index].y} className={'node-connection ' + (node.status === 'online' ? 'is-online' : 'is-offline') + (node.id === selectedId ? ' is-selected' : '')} />
                            <circle cx={points[index].x} cy={points[index].y} r="4" className={'node-connection-end ' + (node.status === 'online' ? 'is-online' : '')} />
                        </g>)}
                    </svg>
                    <div className="node-server" aria-label="Atlas server control plane">
                        <span className="node-server-emblem" aria-hidden="true"><span>Ａ</span></span>
                        <strong>Atlas Server</strong><small>CONTROL PLANE</small><span className="node-server-running"><i /> Central server</span>
                    </div>
                    {nodes.map((node, index) => <button key={node.id} className={'node-graph-card ' + node.status + (selectedId === node.id ? ' is-selected' : '')} style={{ left: (points[index].x / 10) + '%', top: (points[index].y / 6) + '%' }}
                        aria-label={'Inspect ' + node.name} aria-pressed={selectedId === node.id} onClick={() => setSelectedId(node.id)}>
                        <span className="node-graph-machine" aria-hidden="true">{node.platform === 'darwin' ? '⌘' : node.platform === 'linux' ? '▤' : '▣'}</span>
                        <span className="node-graph-info"><strong title={node.name}>{node.name}</strong><small>{platformName(node.platform)} · {node.hostedWorkspaceCount} workspaces</small></span>
                        <span className={'node-graph-presence ' + node.status} aria-hidden="true" />
                    </button>)}
                    {busy && !nodes.length && <p className="node-graph-loading" role="status">Loading nodes…</p>}
                    {!busy && !nodes.length && <div className="node-graph-empty"><strong>No nodes registered</strong><span>Enrol a runtime to connect it to Atlas.</span></div>}
                </div>
                <footer className="node-network-footer"><span><i className="node-legend-dot online" /> Online</span><span><i className="node-legend-dot offline" /> Offline / unavailable</span><span className="node-network-tip">Select a node to inspect <span aria-hidden="true">↗</span></span></footer>
            </section>
            {selected && <NodeInspector key={selected.id} node={selected} detail={detail?.id === selected.id ? detail : undefined}
                detailError={detailError} loading={detailLoading} nodes={nodes} revision={revision} onClose={() => setSelectedId(null)} onChange={change} onTicket={setTicket} />}
        </div>
    </div>;
}
