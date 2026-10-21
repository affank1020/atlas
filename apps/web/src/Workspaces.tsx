import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { callTool, IS_MOCK_MODE } from './api';
import type { AtlasNode } from './Nodes';
import './workspaces-manager.css';

type Workspace = { id: string; nodeId: string; projectId: string | null; name: string; rootPath: string; kind: string; status: string };
type LogicalWorkspace = { id: string; name: string; repository: string | null; kind: 'git' | 'local'; checkouts: Workspace[] };
type Repository = { repository: string; private: boolean; defaultBranch: string; archived: boolean };
type GitStatus = { available: boolean; reason?: string; branch?: string; head?: string; originRepository?: string | null; dirty?: boolean; changes?: {path: string; status: string}[] };
type Worktree = { rootPath: string; head: string; branch: string | null };
type Created = { workspace: Workspace; head: string; branch: string };
type RetirementReport = { eligible: boolean; reason?: string; estimatedReclaimedBytes?: number;
    mergedPullRequest?: { number: number; url: string } };
type RetirementState = { targetId: string; sourceId: string; head: string; checking: boolean;
    report?: RetirementReport; error?: string };
type Draft = { url: string; number: number; draft: boolean };
const directoryPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const branchPattern = /^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const shortSha = (head?: string) => head?.slice(0, 9) || '—';
const reclaimed = (bytes: number) => bytes >= 1024 * 1024
    ? `~${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `~${Math.ceil(bytes / 1024)} KiB`;
function suggestTarget(path: string, branch: string) {
    const slash = path.lastIndexOf('/');
    return slash > 0 ? path.slice(0, slash + 1) + path.slice(slash + 1) + '-' + branch.replace(/^atlas\//, '').replaceAll('/', '-') : '';
}

export function Workspaces() {
    const [nodes, setNodes] = useState<AtlasNode[]>([]);
    const [all, setAll] = useState<Workspace[]>([]);
    const [logical, setLogical] = useState<LogicalWorkspace[]>([]);
    const [repositories, setRepositories] = useState<Repository[]>([]);
    const [catalogError, setCatalogError] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [loading, setLoading] = useState(true);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [catalogLoading, setCatalogLoading] = useState(true);
    const [working, setWorking] = useState(false);
    const [revision, setRevision] = useState(0);
    const [search, setSearch] = useState('');
    const [nodeFilter, setNodeFilter] = useState('');
    const [selectedId, setSelectedId] = useState(() => new URLSearchParams(location.hash.split('?')[1] || '').get('workspace') || '');
    const [rawStatus, setStatus] = useState<GitStatus>();
    const [rawWorktrees, setWorktrees] = useState<Worktree[]>([]);
    const [inspectedId, setInspectedId] = useState('');
    const [inspecting, setInspecting] = useState(false);
    const [inspectionError, setInspectionError] = useState('');
    const [provision, setProvision] = useState(false);
    const [nodeId, setNodeId] = useState('');
    const [managerId, setManagerId] = useState('');
    const [root, setRoot] = useState('');
    const [showRegister, setShowRegister] = useState(false);
    const [repository, setRepository] = useState('');
    const [directoryName, setDirectoryName] = useState('');
    const [branch, setBranch] = useState('atlas/');
    const [targetPath, setTargetPath] = useState('');
    const [featureName, setFeatureName] = useState('');
    const [prTitle, setPrTitle] = useState('');
    const [prBody, setPrBody] = useState('');
    const [draftPR, setDraftPR] = useState<Draft>();
    const [retirement, setRetirement] = useState<RetirementState>();

    // Accept both new logical Workspace URLs and existing checkout deep links.
    const selected = all.find(w => w.id === selectedId) ?? logical.find(group => group.id === selectedId)?.checkouts[0];
    const selectedNode = nodes.find(n => n.id === selected?.nodeId);
    const status = inspectedId === selected?.id ? rawStatus : undefined;
    const worktrees = inspectedId === selected?.id ? rawWorktrees : [];
    const initialLoading = loading && !hasLoaded;
    const inspectorPending = !!(selected && selectedNode?.status === 'online' && inspectedId !== selected.id);
    const online = nodes.filter(n => n.status === 'online' && n.capabilities.includes('workspace.git'));
    const provisionNode = online.find(n => n.id === nodeId);
    const managers = all.filter(w => w.nodeId === nodeId && w.kind === 'generic');
    const groups = useMemo(() => logical.length ? logical :
        all.map(w => ({ id: w.id, name: w.name, repository: null, kind: 'local' as const, checkouts: [w] })), [logical, all]);
    const entries = useMemo(() => groups.map(group => ({
        ...group,
        checkouts: group.checkouts.filter(checkout => !nodeFilter || checkout.nodeId === nodeFilter),
    })).filter(group => group.checkouts.length > 0 &&
        (group.name + ' ' + (group.repository || '') + ' ' + group.checkouts.map(checkout =>
            checkout.name + ' ' + checkout.rootPath + ' ' +
            (nodes.find(node => node.id === checkout.nodeId)?.name || '')).join(' '))
            .toLowerCase().includes(search.toLowerCase())), [groups, nodes, search, nodeFilter]);
    const selectedLogical = (logical.length ? logical : groups)
        .find(group => group.checkouts.some(checkout => checkout.id === selected?.id));
    const validFeature = branchPattern.test(branch) && !branch.endsWith('/') && !branch.includes('//');
    const canPublish = !!(status?.available && status.originRepository && status.branch?.startsWith('atlas/') &&
        status.head && !status.dirty && selectedNode?.status === 'online');

    useEffect(() => {
        const sync = () => setSelectedId(new URLSearchParams(location.hash.split('?')[1] || '').get('workspace') || '');
        window.addEventListener('hashchange', sync);
        return () => window.removeEventListener('hashchange', sync);
    }, []);
    useEffect(() => {
        let live = true;
        setLoading(true);
        Promise.allSettled([
            callTool<AtlasNode[]>('list_nodes'),
            callTool<Workspace[]>('list_workspaces', {}),
            callTool<LogicalWorkspace[]>('list_logical_workspaces', {}),
        ]).then(([nodeResult, wsResult, logicalResult]) => {
            if (!live) return;
            if (nodeResult.status === 'fulfilled') setNodes(nodeResult.value);
            if (wsResult.status === 'fulfilled') setAll(wsResult.value.filter(w => w.status === 'active'));
            // Graceful fallback during server upgrades, without hiding old checkout IDs.
            if (logicalResult.status === 'fulfilled' && Array.isArray(logicalResult.value))
                setLogical(logicalResult.value.map(group => ({ ...group,
                    checkouts: group.checkouts.filter(checkout => checkout.status === 'active') }))
                    .filter(group => group.checkouts.length > 0));
            else setLogical([]);
            setError([nodeResult, wsResult].filter(v => v.status === 'rejected')
                .map(v => message((v as PromiseRejectedResult).reason)).join(' '));
        }).finally(() => {
            if (live) { setHasLoaded(true); setLoading(false); }
        });
        return () => { live = false; };
    }, [revision]);
    useEffect(() => {
        let live = true;
        setCatalogLoading(true);
        callTool<{repositories: Repository[]}>('list_github_repositories', {}).then(result => {
            if (!live) return;
            setRepositories(result.repositories);
            setCatalogError('');
        }).catch(cause => {
            if (live) setCatalogError(message(cause));
        }).finally(() => {
            if (live) setCatalogLoading(false);
        });
        return () => { live = false; };
    }, [revision]);
    useEffect(() => {
        if (!nodeId && online.length) setNodeId(online[0].id);
    }, [nodeId, nodes]);
    useEffect(() => {
        if (!selected || selectedNode?.status !== 'online') {
            setStatus(undefined); setWorktrees([]); setInspectedId('');
            setInspecting(false); setInspectionError('');
            return;
        }
        let live = true;
        // Retain the last inspection during a refresh; the selected ID prevents
        // checkout details from leaking into a newly selected Workspace.
        setInspecting(true); setInspectionError('');
        Promise.allSettled([
            callTool<GitStatus>('workspace_git_status', { workspaceId: selected.id }),
            callTool<{worktrees: Worktree[]}>('workspace_git_list_worktrees', { workspaceId: selected.id }),
        ]).then(([git, trees]) => {
            if (!live) return;
            setStatus(git.status === 'fulfilled' ? git.value : undefined);
            setWorktrees(trees.status === 'fulfilled' ? trees.value.worktrees : []);
            setInspectedId(selected.id);
            setInspectionError([git, trees].filter(x => x.status === 'rejected').map(x => message((x as PromiseRejectedResult).reason)).join(' '));
        }).finally(() => { if (live) setInspecting(false); });
        return () => { live = false; };
    }, [selected?.id, selectedNode?.status, revision]);
    useEffect(() => {
        setBranch('atlas/'); setTargetPath(''); setFeatureName(''); setPrTitle(''); setPrBody(''); setDraftPR(undefined);
    }, [selected?.id]);
    useEffect(() => { setRetirement(undefined); }, [selected?.id, revision]);

    function choose(id: string) {
        setSelectedId(id);
        location.hash = id ? '/workspaces?workspace=' + encodeURIComponent(id) : '/workspaces';
    }
    async function mutate<T>(action: () => Promise<T>, done: string | ((result: T) => string), after?: (value: T) => void) {
        if (IS_MOCK_MODE) return;
        setWorking(true); setError(''); setNotice('');
        try { const result = await action(); after?.(result); setNotice(typeof done === 'string' ? done : done(result)); setRevision(n => n + 1); }
        catch (cause) { setError(message(cause)); }
        finally { setWorking(false); }
    }
    async function reconcile() {
        if (IS_MOCK_MODE || working) return;
        setWorking(true); setError(''); setNotice('');
        let linked = 0;
        let skipped = 0;
        try {
            for (const checkout of all) {
                const onlineNode = online.some(node => node.id === checkout.nodeId);
                if (checkout.kind !== 'generic' || !onlineNode) { skipped++; continue; }
                try {
                    const git = await callTool<GitStatus>('workspace_git_status', { workspaceId: checkout.id });
                    if (!git.available || !git.originRepository) { skipped++; continue; }
                    // The Node-derived origin is verified again by the Server;
                    // neither a repository URL nor a Node path is caller-selected.
                    await callTool('attach_checkout_repository', { workspaceId: checkout.id });
                    linked++;
                } catch { skipped++; }
            }
            setNotice(`Recognised ${linked} verified checkouts; ${skipped} skipped or unavailable.`);
            setRevision(value => value + 1);
        } catch (cause) { setError(message(cause)); }
        finally { setWorking(false); }
    }
    async function register(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!provisionNode || !root.startsWith('/')) return;
        await mutate(() => callTool<Workspace>('create_workspace', {
            nodeId: nodeId, name: 'Development root · ' + root.split('/').pop(), rootPath: root.trim(), kind: 'generic',
        }), 'Development directory registered.', result => {
            setManagerId(result.id); setRoot(''); setShowRegister(false);
        });
    }
    async function clone(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!managerId || !directoryPattern.test(directoryName) || !repository) return;
        await mutate(() => callTool<Created>('workspace_git_clone_repository', {
            workspaceId: managerId, repository, directoryName,
        }), 'Repository cloned and Workspace registered.', result => {
            choose(result.workspace.id); setProvision(false);
        });
    }
    async function createWorktree(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selected || !validFeature || !targetPath.startsWith('/')) return;
        await mutate(() => callTool<Created>('workspace_git_create_worktree', {
            workspaceId: selected.id, branch, targetPath: targetPath.trim(),
            ...(featureName.trim() ? { name: featureName.trim() } : {}),
        }), 'Feature worktree created.', result => choose(result.workspace.id));
    }
    // Prefer a persistent checkout on the same Node. This avoids chaining
    // feature checkouts into one another's retirement lifecycle.
    function retirementSource(record: Workspace) {
        const main = worktrees.find(tree => tree.branch === 'main' || tree.branch === 'master');
        const permanent = main && all.find(checkout => checkout.nodeId === record.nodeId &&
            checkout.rootPath === main.rootPath && checkout.id !== record.id);
        return permanent ?? (selected?.id !== record.id ? selected : undefined);
    }
    async function checkRetirement(entry: Worktree, record: Workspace, source: Workspace) {
        const key = { targetId: record.id, sourceId: source.id, head: entry.head };
        setRetirement({ ...key, checking: true });
        try {
            const report = await callTool<RetirementReport>('workspace_git_retirement_preflight', {
                workspaceId: source.id, targetWorkspaceId: record.id, expectedHead: entry.head,
            });
            setRetirement({ ...key, checking: false, report });
        } catch (cause) {
            setRetirement({ ...key, checking: false, error: message(cause) });
        }
    }
    async function retire(entry: Worktree, record: Workspace, source: Workspace) {
        const report = retirement?.report;
        if (!report?.eligible || retirement?.sourceId !== source.id ||
            retirement?.targetId !== record.id || retirement?.head !== entry.head) return;
        if (!confirm('Retire ' + record.name + '?\n\nThis deletes ' + record.rootPath +
            ' from this Node. Atlas will recheck every safety condition before deletion. ' +
            'The Git branch and commits are preserved.')) return;
        await mutate(() => callTool<{ removed: boolean; estimatedReclaimedBytes: number }>('workspace_git_remove_worktree', {
            workspaceId: source.id, targetWorkspaceId: record.id, expectedHead: entry.head,
        }), result => `Local worktree folder deleted (${reclaimed(result.estimatedReclaimedBytes)} estimated reclaimed); Git branch and commits preserved.`);
    }
    async function push() {
        if (!selected || !canPublish) return;
        await mutate(() => callTool('workspace_git_push_branch', {
            workspaceId: selected.id, repository: status!.originRepository,
            branch: status!.branch, expectedHead: status!.head,
        }), 'Branch published to GitHub.');
    }
    async function openPR(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selected || !canPublish || !prTitle.trim()) return;
        await mutate(() => callTool<Draft>('workspace_git_open_pull_request', {
            workspaceId: selected.id, repository: status!.originRepository, branch: status!.branch,
            expectedHead: status!.head, title: prTitle.trim(), body: prBody,
        }), 'Draft pull request opened.', setDraftPR);
    }

    return <div className="workspaces-manager">
        <header className="page-head">
            <div><p className="eyebrow">Development / across Nodes</p><h1>Workspaces</h1><p>One workspace, multiple checkouts. Choose a Node to inspect and work on its files.</p></div>
            <div className="actions"><button className="ghost" onClick={() => setRevision(r => r + 1)} disabled={loading || working}>{loading && hasLoaded ? 'Refreshing…' : 'Refresh'}</button>
                <button className="ghost" onClick={reconcile} disabled={loading || working || IS_MOCK_MODE || !online.length} title="Group existing checkouts only after checking each Node's Git origin">Recognise repositories</button>
                <button disabled={IS_MOCK_MODE || !online.length} onClick={() => setProvision(!provision)}>{provision ? 'Close' : '+ Add repository'}</button></div>
        </header>
        {IS_MOCK_MODE && <p className="wm-notice" role="status">Mock preview · write operations are disabled.</p>}
        {error && <p className="wm-notice error" role="alert">{error}</p>}
        {notice && <p className="wm-notice" role="status">{notice}</p>}
        {loading && <p className="wm-sr-only" role="status">{initialLoading ? 'Loading Nodes and Workspaces…' : 'Refreshing Workspaces…'}</p>}
        {provision && <section className="wm-panel" aria-label="Provision repository">
            <div className="wm-title"><div><p className="eyebrow">GitHub → Node</p><h2>Provision repository</h2></div><span>Existing directories are never overwritten</span></div>
            <div className="wm-fields">
                <label>Node<select value={nodeId} onChange={e => { setNodeId(e.target.value); setManagerId(''); }} disabled={working}>
                    {online.map(n => <option key={n.id} value={n.id}>{n.name} · {n.platform}</option>)}</select></label>
                <label>Registered development directory<select value={managerId} onChange={e => setManagerId(e.target.value)} disabled={working}>
                    <option value="">Select directory</option>{managers.map(w => <option key={w.id} value={w.id}>{w.name} · {w.rootPath}</option>)}</select></label>
            </div>
            <button className="wm-link" onClick={() => setShowRegister(!showRegister)} type="button" disabled={working}>
                {showRegister ? 'Cancel registration' : '+ Register existing development directory'}</button>
            {showRegister && <form className="wm-fields" onSubmit={register}>
                <label>Absolute directory on Node<input value={root} onChange={e => setRoot(e.target.value)} required placeholder="/srv/atlas/workspaces" /></label>
                <button disabled={working || !root.startsWith('/') || IS_MOCK_MODE}>Register</button>
            </form>}
            <form className="wm-fields" onSubmit={clone}>
                <label>Authorised GitHub repository<select value={repository} onChange={e => { setRepository(e.target.value); setDirectoryName(e.target.value.split('/')[1] || ''); }}>
                    <option value="">{catalogLoading ? 'Loading repositories…' : 'Select repository'}</option>
                    {repositories.filter(r => !r.archived).map(r => <option key={r.repository} value={r.repository}>{r.repository}{r.private ? ' · Private' : ''}</option>)}</select></label>
                <label>Directory name<input value={directoryName} onChange={e => setDirectoryName(e.target.value)} required maxLength={80} placeholder="repository-name" /></label>
                <button disabled={working || IS_MOCK_MODE || !managerId || !repository || !directoryPattern.test(directoryName)}>Clone</button>
            </form>
            {catalogError && <p role="alert" className="wm-hint error">GitHub catalog unavailable: {catalogError}</p>}
            <p className="wm-hint">Cloning adds a checkout on the selected Node. Checkouts of the same verified GitHub repository belong to one logical Workspace.</p>
        </section>}
        <div className="wm-layout">
            <section className="wm-panel wm-browser" aria-label="Workspace browser" aria-busy={initialLoading}>
                <div className="wm-fields"><label>Search<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Repository, workspace, checkout, Node…" /></label>
                    <label>Node<select value={nodeFilter} onChange={e => setNodeFilter(e.target.value)}><option value="">All Nodes</option>
                        {nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label></div>
                <div className="wm-title"><h2>{initialLoading ? <span className="wm-skeleton wm-skeleton-count" aria-hidden="true" /> : `${entries.length} ${entries.length === 1 ? 'Workspace' : 'Workspaces'}`}</h2><small>{initialLoading ? <span className="wm-skeleton wm-skeleton-meta" aria-hidden="true" /> : `${nodes.filter(n => n.status === 'online').length} Nodes online`}</small></div>
                <div className="wm-list" aria-busy={initialLoading}>{initialLoading ? Array.from({ length: 4 }, (_, index) =>
                    <div className="wm-row wm-row-skeleton" key={index} aria-hidden="true">
                        <span className="wm-skeleton wm-skeleton-glyph" />
                        <span className="wm-row-main">
                            <span className="wm-skeleton wm-skeleton-title" />
                            <span className="wm-skeleton wm-skeleton-path" />
                            <span className="wm-skeleton wm-skeleton-node" />
                        </span>
                        <span className="wm-skeleton wm-skeleton-dot" />
                    </div>
                ) : entries.map(group => {
                    const checkoutsByNode = new Map<string, Workspace[]>();
                    for (const checkout of group.checkouts) {
                        const siblings = checkoutsByNode.get(checkout.nodeId) || [];
                        siblings.push(checkout);
                        checkoutsByNode.set(checkout.nodeId, siblings);
                    }
                    const nodeCount = checkoutsByNode.size;
                    return <div className="wm-group" key={group.id}>
                        <button className="wm-row wm-group-heading"
                            aria-label={group.name}
                            aria-pressed={group.checkouts.some(checkout => checkout.id === selected?.id)}
                            onClick={() => choose(group.id)}>
                            <span className="wm-glyph" aria-hidden="true">⌁</span>
                            <span className="wm-row-main"><strong>{group.name}</strong>
                                <small title={group.repository || undefined}>{group.repository || 'Local Workspace'}</small>
                                <small>{group.checkouts.length} {group.checkouts.length === 1 ? 'checkout' : 'checkouts'} across {nodeCount} {nodeCount === 1 ? 'Node' : 'Nodes'}</small>
                            </span>
                        </button>
                        {Array.from(checkoutsByNode.entries()).map(([hostId, nodeCheckouts]) => {
                            const host = nodes.find(node => node.id === hostId);
                            return <div className="wm-node-group" key={hostId}>
                                <div className="wm-node-heading">
                                    <span className={'wm-dot' + (host?.status === 'online' ? ' online' : '')} aria-hidden="true" />
                                    <strong>{host?.name || 'Unknown Node'}</strong>
                                    <small>{nodeCheckouts.length} {nodeCheckouts.length === 1 ? 'checkout' : 'checkouts'}</small>
                                </div>
                                <div className="wm-checkout-list">{nodeCheckouts.map(checkout => {
                                    const isSelected = selected?.id === checkout.id;
                                    return <button className={'wm-checkout-row' + (isSelected ? ' selected' : '')}
                                        key={checkout.id} aria-pressed={isSelected}
                                        aria-label={'Checkout on ' + (host?.name || 'Unknown Node') + ' at ' + checkout.rootPath}
                                        onClick={() => choose(checkout.id)}>
                                        <span className="wm-checkout-glyph" aria-hidden="true">↳</span>
                                        <span><strong>{checkout.name === group.name ? checkout.name + ' checkout' : checkout.name}{isSelected && status?.branch ? ' · ' + status.branch : ''}</strong>
                                            <small title={checkout.rootPath}>{checkout.rootPath}</small></span>
                                    </button>;
                                })}</div>
                            </div>;
                        })}
                    </div>;
                })}</div>
                {!loading && !entries.length && <p className="wm-hint">No Workspaces match the current filters.</p>}
            </section>
            <aside className="wm-panel wm-inspector" aria-label="Workspace details" aria-busy={!!(inspecting || inspectorPending || (initialLoading && selectedId))}>
                {!selected && initialLoading && selectedId ? <div className="wm-inspector-skeleton" aria-hidden="true">
                    <span className="wm-skeleton wm-skeleton-meta" />
                    <span className="wm-skeleton wm-skeleton-heading" />
                    <span className="wm-skeleton wm-skeleton-path-wide" />
                    <span className="wm-skeleton wm-skeleton-path-wide" />
                </div> : !selected ? <div className="wm-empty"><h2>Workspace details</h2><p>Choose a Node checkout to inspect its branch, files and Git operations.</p></div> : <>
                    <div className="wm-title"><div><p className="eyebrow">Workspace</p><h2>{selectedLogical?.name || selected.name}</h2></div><button className="wm-link" onClick={() => choose('')}>Close</button></div>
                    <p className="wm-workspace-origin">{selectedLogical?.repository || 'Local Workspace'} · {selectedLogical?.checkouts.length || 1} {(selectedLogical?.checkouts.length || 1) === 1 ? 'checkout' : 'checkouts'}</p>
                    {(selectedLogical?.checkouts.length || 0) > 1 && (selectedLogical!.checkouts.length > 3
                        ? <label className="wm-checkout-select">Choose checkout
                            <select value={selected.id} onChange={event => choose(event.target.value)} aria-label="Choose checkout">
                                {selectedLogical!.checkouts.map(checkout => {
                                    const host = nodes.find(node => node.id === checkout.nodeId);
                                    return <option key={checkout.id} value={checkout.id}>{checkout.name} · {host?.name || 'Unknown Node'} · {checkout.rootPath}</option>;
                                })}
                            </select>
                        </label>
                        : <div className="wm-checkout-switch" role="group" aria-label="Choose Node checkout">
                            {selectedLogical!.checkouts.map(checkout => {
                                const host = nodes.find(node => node.id === checkout.nodeId);
                                return <button key={checkout.id}
                                    className={selected.id === checkout.id ? 'active' : ''}
                                    aria-pressed={selected.id === checkout.id}
                                    title={checkout.rootPath}
                                    onClick={() => choose(checkout.id)}>
                                    <span className={'wm-dot' + (host?.status === 'online' ? ' online' : '')} aria-hidden="true"/>
                                    <span className="wm-switch-label"><strong>{checkout.name}</strong><small>{host?.name || 'Unknown Node'}</small><small className="wm-switch-path">{checkout.rootPath}</small></span>
                                </button>;
                            })}
                        </div>)}
                    <div className="wm-selected-checkout">
                        <p className="eyebrow">Selected checkout</p>
                        <div className="wm-status"><span className={'wm-dot' + (selectedNode?.status === 'online' ? ' online' : '')} />
                            {selectedNode?.name || 'Unknown Node'} · {selectedNode?.status || 'Unknown'}</div>
                        <p className="wm-checkout-name">{selected.name}</p>
                        <p className="wm-path">{selected.rootPath}</p>
                        <p className="wm-hint">{selected.kind} checkout · {selected.projectId ? 'Project linked' : 'Project-independent'}</p>
                    </div>
                    {inspecting && <p role="status" className="wm-sr-only">{inspectedId === selected.id ? 'Refreshing checkout…' : 'Inspecting checkout…'}</p>}
                    {inspectionError && <p role="alert" className="wm-hint error">{inspectionError}</p>}
                    {selectedNode?.status !== 'online' && <p className="wm-hint">Reconnect this Node to inspect or modify its checkout.</p>}
                    {inspectorPending ? <>
                        <div className="wm-git wm-git-skeleton" aria-hidden="true">
                            {['Branch', 'HEAD', 'Working tree', 'Origin'].map((label, index) =>
                                <div key={label}><span>{label}</span><span className={'wm-skeleton wm-skeleton-git wm-skeleton-git-' + index} /></div>)}
                        </div>
                        <section className="wm-subsection wm-trees-skeleton" aria-hidden="true">
                            <h3>Worktrees</h3>
                            {Array.from({ length: 2 }, (_, index) =>
                                <div className="wm-tree" key={index}><div>
                                    <span className="wm-skeleton wm-skeleton-title" />
                                    <span className="wm-skeleton wm-skeleton-path" />
                                </div></div>)}
                        </section>
                    </> : status?.available ? <div className="wm-git">
                        <div><span>Branch</span><strong>{status.branch || 'Detached'}</strong></div>
                        <div><span>HEAD</span><code>{shortSha(status.head)}</code></div>
                        <div><span>Working tree</span><strong>{status.dirty ? 'Uncommitted changes' : 'Clean'}</strong></div>
                        <div><span>Origin</span><strong>{status.originRepository || 'None'}</strong></div>
                    </div> : status?.reason && <p className="wm-hint">{status.reason}</p>}
                    {!!status?.changes?.length && <details><summary>{status.changes.length} changed files</summary>
                        <ul className="wm-changes">{status.changes.slice(0,40).map(x => <li key={x.path}>{x.status} {x.path}</li>)}</ul></details>}
                    {status?.available && <section className="wm-subsection">
                        <h3>Worktrees</h3>
                        <div className="wm-trees">{worktrees.map(t => {
                            const record = all.find(w => w.nodeId === selected.nodeId && w.rootPath === t.rootPath);
                            const source = record ? retirementSource(record) : undefined;
                            const check = record && source && retirement?.targetId === record.id &&
                                retirement.sourceId === source.id && retirement.head === t.head ? retirement : undefined;
                            return <div key={t.rootPath} className="wm-tree"><div><strong>{t.branch || 'Detached HEAD'}</strong>
                                <small>{t.rootPath} · {shortSha(t.head)}</small>
                                {check?.checking && <small role="status">Checking retirement safety…</small>}
                                {check?.error && <small role="alert" className="wm-retirement-blocked">{check.error}</small>}
                                {check?.report?.eligible === false && <small role="status" className="wm-retirement-blocked">
                                    Not ready: {check.report.reason || 'Safety checks did not pass'}</small>}
                                {check?.report?.eligible && <small role="status" className="wm-retirement-ready">
                                    Ready · merged PR #{check.report.mergedPullRequest?.number || 'verified'}
                                    {check.report.estimatedReclaimedBytes !== undefined ?
                                        ' · ' + reclaimed(check.report.estimatedReclaimedBytes) + ' reclaimable' : ''}
                                </small>}
                                </div>
                                {record && source && t.branch?.startsWith('atlas/') && <div className="wm-retire-actions">
                                    <button className="ghost" disabled={working || inspecting || IS_MOCK_MODE || check?.checking}
                                        onClick={() => checkRetirement(t, record, source)}>
                                        {check?.checking ? 'Checking…' : 'Check eligibility'}</button>
                                    {check?.report?.eligible && <button className="ghost wm-retire-confirm"
                                        disabled={working || inspecting || IS_MOCK_MODE}
                                        onClick={() => retire(t, record, source)}>Retire</button>}
                                </div>}
                            </div>;
                        })}</div>
                        <form className="wm-stack" onSubmit={createWorktree}>
                            <h3>New feature worktree</h3>
                            <p className="wm-hint">Atlas-managed feature worktrees are temporary checkouts. Once their exact PR is merged, you can check eligibility and retire them safely; the branch is preserved.</p>
                            <label>Branch<input value={branch} onChange={e => { const value = e.target.value; setBranch(value); if (!targetPath || targetPath === suggestTarget(selected.rootPath, branch)) setTargetPath(suggestTarget(selected.rootPath, value)); }} placeholder="atlas/feature-name" /></label>
                            <label>Destination on Node<input value={targetPath} onChange={e => setTargetPath(e.target.value)} placeholder={suggestTarget(selected.rootPath, 'atlas/feature')} /></label>
                            <label>Display name (optional)<input value={featureName} onChange={e => setFeatureName(e.target.value)} /></label>
                            <button disabled={working || inspecting || IS_MOCK_MODE || !validFeature || !targetPath.startsWith('/') || selectedNode?.status !== 'online'}>Create worktree</button>
                        </form>
                    </section>}
                    {canPublish && <section className="wm-subsection wm-stack"><h3>Publish</h3>
                        <button className="ghost" onClick={push} disabled={working || inspecting || IS_MOCK_MODE}>Push feature branch to GitHub</button>
                        <form className="wm-stack" onSubmit={openPR}><label>Pull request title<input value={prTitle} onChange={e => setPrTitle(e.target.value)} required minLength={5} maxLength={120} /></label>
                            <label>Description<textarea value={prBody} onChange={e => setPrBody(e.target.value)} rows={3} maxLength={8000} /></label>
                            <button disabled={working || inspecting || IS_MOCK_MODE || prTitle.trim().length < 5}>Open draft PR</button></form>
                        {draftPR && <a href={draftPR.url} target="_blank" rel="noreferrer">Draft PR #{draftPR.number} ↗</a>}
                    </section>}
                    {working && <p role="status" className="wm-hint">Working on the Node…</p>}
                </>}
            </aside>
        </div>
    </div>;
}
