import { useEffect, useState } from 'react';
import { callTool } from './api';
import type { AtlasNode } from './Nodes';
import './node-sharing.css';

export type ShareApproval = {
    sourceNodeId: string;
    targetNodeId: string;
    origin: 'managed' | 'environment';
};

/** Sender-scoped, directional permissions. Runtime receiving still requires
 * an online destination, advertised capability and local Mac user approval.
 */
export function NodeSharePermissions({ source, nodes }: {source: AtlasNode; nodes: AtlasNode[]}) {
    const [approvals, setApprovals] = useState<ShareApproval[]>([]);
    const [loading, setLoading] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        let live = true;
        setLoading(true);
        setLoaded(false);
        setError('');
        callTool<ShareApproval[]>('list_node_share_approvals').then(value => {
            if (live) {
                if (!Array.isArray(value)) throw new Error('Atlas did not return a permission list.');
                setApprovals(value);
                setLoaded(true);
            }
        }).catch(err => { if (live) setError(err instanceof Error ? err.message : String(err)); })
          .finally(() => { if (live) setLoading(false); });
        return () => { live = false; };
    }, [source.id, revision]);

    async function change(target: AtlasNode, enabled: boolean) {
        if (busyId || loading || !loaded) return;
        if (!enabled && !window.confirm('Stop ' + source.name + ' from sharing text to ' + target.name + '?')) return;
        setBusyId(target.id);
        setError('');
        setNotice('');
        try {
            await callTool('update_node_share_approval',
                { sourceNodeId: source.id, targetNodeId: target.id, enabled });
            setNotice(enabled ? 'Directional sharing approved.' : 'Directional sharing revoked.');
            setRevision(value => value + 1);
        } catch (err) {
            // A lost mutation response may hide a committed grant or revoke.
            // Require a successful refresh before offering another write.
            setLoaded(false);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyId(null);
        }
    }

    const targets = nodes.filter(node => node.id !== source.id);
    return <section className="node-share-permissions" aria-label={'Sharing permissions for ' + source.name}>
        <header className="node-share-permissions-head">
            <div><span className="eyebrow">Permissions</span><h2>Device sharing</h2></div>
            <button type="button" className="ghost" disabled={loading || busyId !== null}
                onClick={() => setRevision(value => value + 1)}>Refresh approvals</button>
        </header>
        <p>Choose which Nodes <strong>{source.name}</strong> may send text to. Each approval is directional.
            Receiving Nodes must still be online and explicitly accept every share.</p>
        {error && <p role="alert" className="node-page-notice">{error}</p>}
        {notice && <p role="status" className="node-page-notice">{notice}</p>}
        {loading ? <p role="status">Loading sharing approvals…</p>
            : !loaded ? <p role="status">Sharing approval state is unknown. Refresh approvals to retry.</p>
            : !targets.length ? <p>No other Nodes are enrolled yet.</p>
            : <ul className="node-share-list">
                {targets.map(target => {
                    const permission = approvals.find(entry =>
                        entry.sourceNodeId.toLowerCase() === source.id.toLowerCase() &&
                        entry.targetNodeId.toLowerCase() === target.id.toLowerCase());
                    const env = permission?.origin === 'environment';
                    const canApprove = source.credentialState === 'active' && target.credentialState === 'active';
                    return <li key={target.id}>
                        <div className="node-share-peer">
                            <strong>{target.name}</strong>
                            <span>{target.platform || 'Node'} · {target.status}</span>
                            {permission && <small>{env ? 'Managed by server environment' : 'Approved in Atlas'}</small>}
                        </div>
                        {env ? <span className="badge muted">Read-only</span>
                            : <button type="button" className={permission ? 'ghost danger' : 'ghost'}
                                disabled={busyId !== null || (!permission && !canApprove)}
                                title={!permission && !canApprove ? 'Both Nodes require active credentials' : undefined}
                                onClick={() => void change(target, !permission)}>
                                {busyId === target.id ? 'Saving…' : permission ? 'Revoke access' : 'Approve sharing'}
                            </button>}
                    </li>;
                })}
            </ul>}
        <p className="node-share-footnote">Approvals never grant Workspace access, bypass the Mac confirmation
            dialog, or enable receiving on a Node. Existing <code>ATLAS_DEVICE_SHARE_PAIRS</code> grants
            remain read-only until that configuration is retired.</p>
    </section>;
}
