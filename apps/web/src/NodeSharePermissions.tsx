import { useEffect, useRef, useState } from 'react';
import { callTool } from './api';
import type { AtlasNode } from './Nodes';
import './node-sharing.css';
import { SkeletonRows } from './Skeletons';

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
    const previousSource = useRef(source.id);
    useEffect(() => {
        let live = true;
        setLoading(true);
        if (previousSource.current !== source.id) { setLoaded(false); setApprovals([]); }
        previousSource.current = source.id;
        setError('');
        callTool<ShareApproval[]>('list_node_share_approvals').then(value => {
            if (live) {
                if (!Array.isArray(value)) throw new Error('Atlas did not return a permission list.');
                setApprovals(value);
                setLoaded(true);
            }
        }).catch(err => {
            if (!live) return;
            // A failed refresh invalidates previously displayed grants. Do not
            // present old approvals as verified after a registry read fails.
            setLoaded(false);
            setApprovals([]);
            setNotice('');
            setError(err instanceof Error ? err.message : String(err));
        })
          .finally(() => { if (live) setLoading(false); });
        return () => { live = false; };
    }, [source.id, revision]);

    async function change(target: AtlasNode, enabled: boolean) {
        if (busyId || loading || !loaded || error) return;
        const environmentGranted = approvals.some(entry =>
            entry.origin === 'environment' &&
            entry.sourceNodeId.toLowerCase() === source.id.toLowerCase() &&
            entry.targetNodeId.toLowerCase() === target.id.toLowerCase());
        if (!enabled && !window.confirm(
            'Remove the Atlas-managed approval from ' + source.name + ' to ' + target.name + '?' +
            (environmentGranted
                ? ' The separate server environment grant will STILL authorise sharing until removed and the Server restarted.'
                : ' This will revoke managed sharing access.')
        )) return;
        setBusyId(target.id);
        setError('');
        setNotice('');
        try {
            await callTool('update_node_share_approval',
                { sourceNodeId: source.id, targetNodeId: target.id, enabled });
            setNotice(enabled ? 'Directional sharing approved.'
                : environmentGranted ? 'Atlas approval removed. The server environment still authorises sharing.'
                : 'Directional sharing revoked.');
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
        {loading && !loaded && !error ? <SkeletonRows label="Loading sharing approvals" variant="list" rows={3} />
            : !loaded ? <p role="status">Sharing approval state is unknown. Refresh approvals to retry.</p>
            : !targets.length ? <p>No other Nodes are enrolled yet.</p>
            : <ul className="node-share-list">
                {targets.map(target => {
                    const pair = approvals.filter(entry =>
                        entry.sourceNodeId.toLowerCase() === source.id.toLowerCase() &&
                        entry.targetNodeId.toLowerCase() === target.id.toLowerCase());
                    const env = pair.some(entry => entry.origin === 'environment');
                    const managed = pair.some(entry => entry.origin === 'managed');
                    const permission = env || managed;
                    const canApprove = source.credentialState === 'active' && target.credentialState === 'active';
                    return <li key={target.id}>
                        <div className="node-share-peer">
                            <strong>{target.name}</strong>
                            <span>{target.platform || 'Node'} · {target.status}</span>
                            {managed && <small>Approved in Atlas</small>}
                            {env && <small>Managed by server environment</small>}
                            {managed && env && <small>Two independent grants are active. Removing the Atlas grant alone will NOT stop sharing.</small>}
                        </div>
                        {env && !managed ? <span className="badge muted">Read-only</span>
                            : <button type="button" className={managed ? 'ghost danger' : 'ghost'}
                                disabled={loading || !!error || busyId !== null || (!permission && !canApprove)}
                                title={!permission && !canApprove ? 'Both Nodes require active credentials' : undefined}
                                onClick={() => void change(target, !managed)}>
                                {busyId === target.id ? 'Saving…' : managed && env ? 'Revoke Atlas approval' : managed ? 'Revoke access' : 'Approve sharing'}
                            </button>}
                    </li>;
                })}
            </ul>}
        <p className="node-share-footnote">Approvals never grant Workspace access, bypass the Mac confirmation
            dialog, or enable receiving on a Node. Existing <code>ATLAS_DEVICE_SHARE_PAIRS</code> grants
            remain read-only until that configuration is retired. If both sources grant a pair,
            removing only the Atlas-managed grant leaves environment sharing enabled.</p>
    </section>;
}
