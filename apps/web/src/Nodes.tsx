import { useEffect, useState } from 'react';
import { callTool } from './api';
import './workspaces.css';
export type AtlasNode = {
    id: string; name: string; status: 'online' | 'offline' | 'unavailable';
    platform?: string; version?: string | null; credentialState?: string; credentialUpdatedAt?: string | null;
    capabilities: string[]; lastSeen: string | null; hostedWorkspaceCount: number;
    workspaces?: { id: string; projectId: string; name: string; kind: string }[];
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
export function Nodes() {
    const [nodes, setNodes] = useState<AtlasNode[]>([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(true);
    const [revision, setRevision] = useState(0);
    const [ticket, setTicket] = useState<{enrolmentToken: string; expiresAt: string; nodeId: string | null} | null>(null);
    const [message, setMessage] = useState('');
    useEffect(() => {
        let live = true; setBusy(true); setError('');
        callTool<AtlasNode[]>('list_nodes').then(async list => {
            const details = await Promise.all(list.map(node => callTool<AtlasNode>('get_node', { nodeId: node.id })));
            if (live) setNodes(details);
        }).catch(error => { if (live) setError(error.message); }).finally(() => { if (live) setBusy(false); });
        return () => { live = false; };
    }, [revision]);
    async function change(action: () => Promise<unknown>, success: string) {
        setError(''); setMessage('');
        try { await action(); setMessage(success); setRevision(value => value + 1); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    }
    async function enrol() {
        await change(async () => { setTicket(await callTool<typeof ticket>('create_node_enrolment', {})); }, 'Enrolment code issued. It expires in ten minutes.');
    }
    return <><header className="page-head"><div><p className="eyebrow">Infrastructure</p><h1>Nodes</h1><p>Trusted runtimes that host your Workspaces.</p></div><div className="actions"><button onClick={() => void enrol()}>Enrol Node</button><button disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh</button></div></header>
        {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
        {ticket && <section className="panel"><h2>One-time enrolment code</h2><p>Use this code on the Node host before {new Date(ticket.expiresAt).toLocaleString()}. The Node receives its private credential during enrolment.</p><code style={{ overflowWrap: 'anywhere' }}>{ticket.enrolmentToken}</code><p><button onClick={() => setTicket(null)}>Dismiss</button></p></section>}
        {busy && <p role="status">Loading Nodes…</p>}
        {!busy && !error && !nodes.length && <p>No Nodes registered.</p>}
        {!busy && nodes.map(node => <section key={node.id} id={node.id} className="panel" aria-label={node.name}>
            <div className="panel-head"><h2>{node.name}</h2><NodeStatus status={node.status} /></div>
            <div className="workspace-body"><p className="hint">ID: {node.id} · {node.platform || 'Unknown platform'}{node.version ? ` · v${node.version}` : ''}</p>
                <p className="hint">Last seen: {node.lastSeen ? new Date(node.lastSeen).toLocaleString() : 'Not yet connected'} · Credential: {node.credentialState || 'Unknown'}{node.credentialUpdatedAt ? ` since ${new Date(node.credentialUpdatedAt).toLocaleString()}` : ''}</p>
                <h3>Live capabilities</h3><NodeCapabilities capabilities={node.capabilities} />
                <div className="actions"><button onClick={() => { const name = window.prompt('Node name', node.name); if (name?.trim()) void change(() => callTool('update_node', { nodeId: node.id, name: name.trim() }), 'Node renamed.'); }}>Rename</button>
                <button onClick={() => { if (window.confirm(`Rotate ${node.name}'s credential? Its current connection will close.`)) void change(async () => { setTicket(await callTool('rotate_node_credential', { nodeId: node.id })); }, 'Credential rotated. Enrol this Node again with the one-time code.'); }}>Rotate credential</button>
                <button onClick={() => { if (window.confirm(`Revoke ${node.name}? Its current connection will close and assigned Workspaces will be offline.`)) void change(() => callTool('revoke_node', { nodeId: node.id }), 'Node credential revoked.'); }}>Revoke</button></div>
                <h3>Workspaces · {node.hostedWorkspaceCount}</h3>
                {node.workspaces?.length ? <ul>{node.workspaces.map(workspace => <li key={workspace.id}><a href={`#/projects/${workspace.projectId}/workspaces`}>{workspace.name}</a> <select aria-label={`Assign ${workspace.name} to Node`} value={node.id} onChange={event => { const target = event.target.value; if (window.confirm(`Move ${workspace.name} to ${nodes.find(item => item.id === target)?.name}?`)) void change(() => callTool('assign_workspace_node', { projectId: workspace.projectId, workspaceId: workspace.id, nodeId: target, expectedNodeId: node.id }), 'Workspace placement updated.'); }}><option value={node.id}>{node.name}</option>{nodes.filter(target => target.id !== node.id && target.credentialState === 'active').map(target => <option key={target.id} value={target.id}>{target.name}</option>)}</select></li>)}</ul> : <p>No active Workspaces.</p>}
                <h3>Recent activity</h3>{node.activity?.length ? <ul>{node.activity.map((item, index) => <li key={`${item.createdAt}-${index}`}>{item.operation} · {new Date(item.createdAt).toLocaleString()}</li>)}</ul> : <p>No recent activity.</p>}
            </div></section>)}
    </>;
}
