import { standaloneViewUrl } from './viewLinks';
import { useEffect, useMemo, useState } from 'react';
import { API_BASE, IS_MOCK_MODE } from './api';
import { useListProjectsQuery, useListStoresQuery, useListViewsQuery, useWorkspaceNodesQuery, useWorkspaceStatusQuery } from './atlasApi';
import { clearRecentWork, rememberWork, useRecentWork } from './recentWork';
import type { Project } from './types';
import type { AtlasNode } from './Nodes';
import { callTool } from './api';
import './workspace-overview.css';

export function WorkspaceHeading({ title, copy, children }: { title: string; copy: string; children?: React.ReactNode }) {
    return <header className="page-head"><div><p className="eyebrow">Atlas workspace</p><h1>{title}</h1><p>{copy}</p></div><div className="actions">{children}</div></header>;
}
export function QueryNotice({ loading, error, retry }: { loading: boolean; error: unknown; retry: () => unknown }) {
    return <>{loading && <p className="workspace-loading" role="status">Loading…</p>}{!!error && <div className="notice error" role="alert">Unable to load this section. <button className="ghost" onClick={() => retry()}>Try again</button></div>}</>;
}
function ProjectSymbol({ name }: { name: string }) {
    const category = name.toLowerCase();
    const isUniversity = /university|learning|study/.test(category);
    const isResearch = /research|final year|fyp/.test(category);
    const isCareer = /career|job/.test(category);
    const isPortfolio = /portfolio/.test(category);
    return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {isUniversity ? <><path d="m2 9 10-5 10 5-10 5zM6 11v6c3.5 3 8.5 3 12 0v-6M22 9v7" /></>
            : isResearch ? <><path d="M9 3h6M10 3v7L4 20h16l-6-10V3M7 16h10" /></>
            : isCareer ? <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13c5 3 13 3 18 0M10 14h4" /></>
            : isPortfolio ? <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M10 10v10" /></>
            : <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>}
    </svg>;
}
export function ProjectRows({ projects }: { projects: Project[] }) {
    return <div className="home-project-grid">{projects.map(project =>
        <a className="home-project-card" key={project.id} href={`#/projects/${project.id}`}>
            <span className="home-project-symbol"><ProjectSymbol name={project.name} /></span>
            <strong>{project.name}</strong>
            <small>{project.description || 'Open project workspace'}</small>
            {project.archivedAt && <span className="badge muted">Archived</span>}
        </a>
    )}</div>;
}

type HostedWorkspace = { id: string; projectId: string; name: string; nodeId: string; nodeName: string };
const workspaceDetailsCache = new Map<string, AtlasNode>();

function HomeWorkspaces({ nodes, nodesUnavailable, refreshKey, projects }: { nodes: AtlasNode[] | undefined; nodesUnavailable: boolean; refreshKey: number; projects: Project[] }) {
    const [items, setItems] = useState<HostedWorkspace[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        if (!nodes) { setLoading(!nodesUnavailable); setFailed(nodesUnavailable); setItems([]); return; }
        if (!nodes.length) { setItems([]); setLoading(false); setFailed(false); return; }
        const controller = new AbortController();
        setLoading(true); setFailed(false);
        const readNode = (node: AtlasNode) => {
            const cached = refreshKey === 0 ? workspaceDetailsCache.get(node.id) : undefined;
            if (cached) return Promise.resolve(cached);
            return callTool<AtlasNode>('get_node', { nodeId: node.id }, controller.signal)
                .then(detail => { workspaceDetailsCache.set(node.id, detail); return detail; });
        };
        void Promise.allSettled(nodes.map(readNode)).then(results => {
            if (controller.signal.aborted) return;
            setFailed(results.some(item => item.status === 'rejected'));
            setItems(results.flatMap((result, index) => result.status === 'fulfilled'
                ? (result.value.workspaces ?? []).map(workspace => ({
                    id: workspace.id, projectId: workspace.projectId, name: workspace.name,
                    nodeId: nodes[index].id, nodeName: nodes[index].name,
                })) : []));
            setLoading(false);
        });
        return () => controller.abort();
    }, [nodes, nodesUnavailable, refreshKey]);
    const projectNames = useMemo(() => new Map(projects.map(p => [p.id, p.name])), [projects]);
    const total = nodes?.reduce((sum, node) => sum + node.hostedWorkspaceCount, 0);
    return <section className="overview-card" aria-label="Hosted workspaces">
        <div className="overview-card-head"><h2>Workspaces</h2><a href="#/projects">Projects <span aria-hidden="true">↗</span></a></div>
        <div className="overview-card-feature"><strong>{total ?? '—'}</strong><span>Hosted across {nodes?.length ?? '—'} nodes</span></div>
        {loading && <p className="overview-muted" role="status">Loading workspace details…</p>}
        {!loading && failed && <p className="overview-muted" role="status">Some workspace details are unavailable.</p>}
        {!loading && items.length === 0 && <p className="overview-muted">{failed ? 'Open the Nodes view to inspect assignments.' : 'No workspaces currently assigned.'}</p>}
        <div className="overview-compact-list">{!loading && items.slice(0, 5).map(workspace =>
            <a key={workspace.id} href={`#/projects/${workspace.projectId}/workspaces`} className="overview-compact-row">
                <span className="overview-item-main"><strong>{workspace.name}</strong><small>{projectNames.get(workspace.projectId) ?? workspace.nodeName}</small></span>
                <span aria-hidden="true">↗</span>
            </a>)}</div>
        {items.length > 5 && <p className="overview-list-more">+{items.length - 5} more workspaces</p>}
    </section>;
}

function HomeRecent({ items, kind, projectIds }: {
    items: ReturnType<typeof useRecentWork>;
    kind: 'Application' | 'View';
    projectIds: Set<string>;
}) {
    const filtered = items.filter(item => item.kind === kind && projectIds.has(item.projectId)).slice(0, 4);
    return <section className="overview-card" aria-label={kind === 'Application' ? 'Recent applications' : 'Recent views'}>
        <div className="overview-card-head"><h2>{kind === 'Application' ? 'Applications' : 'Views'}</h2><a href={kind === 'Application' ? '#/projects' : '#/views'}>Browse <span aria-hidden="true">↗</span></a></div>
        <p className="overview-card-subtitle">Recently opened {kind === 'Application' ? 'applications' : 'views'}</p>
        {filtered.length ? <div className="overview-compact-list">{filtered.map(item =>
            <a key={item.href} className="overview-compact-row" href={kind === 'View'
                ? standaloneViewUrl({ projectId: item.projectId, id: item.href.split('/').pop()!, slug: item.viewSlug })
                : item.href} target="_blank" rel="noopener noreferrer">
                <span className="overview-item-main"><strong>{item.name}</strong><small>{kind}</small></span>
                <span aria-hidden="true">↗</span>
            </a>)}</div> : <p className="overview-muted">No {kind === 'Application' ? 'applications' : 'views'} opened in this browser session.</p>}
    </section>;
}

export function WorkspaceHome() {
    const projects = useListProjectsQuery({ includeArchived: false });
    const status = useWorkspaceStatusQuery(undefined);
    const nodes = useWorkspaceNodesQuery(undefined);
    const recent = useRecentWork();
    const [workspaceRefresh, setWorkspaceRefresh] = useState(0);
    const projectIds = useMemo(() => new Set((projects.data ?? []).map(project => project.id)), [projects.data]);
    const online = nodes.data?.filter(node => node.status === 'online').length;
    const workspaceCount = nodes.data?.reduce((sum, node) => sum + node.hostedWorkspaceCount, 0);
    const topProjects = [...(projects.data ?? [])].sort((a, b) =>
        (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0)).slice(0, 4);
    const refresh = () => {
        void projects.refetch(); void status.refetch(); void nodes.refetch();
        setWorkspaceRefresh(value => value + 1);
    };
    return <div className="workspace-home overview-home">
        <header className="page-head overview-heading">
            <div><h1>Home</h1></div>
            <div className="actions"><button className="ghost" onClick={refresh} disabled={projects.isFetching || status.isFetching || nodes.isFetching}>Refresh</button></div>
        </header>
        <div className="overview-metrics" aria-label="Atlas totals">
            <a href="#/projects" className="overview-metric"><span>Projects</span><strong>{projects.data?.length ?? '—'}</strong><small>Active projects</small></a>
            <a href="#/data" className="overview-metric"><span>Data stores</span><strong>{status.data?.stores ?? '—'}</strong><small>{status.error ? 'Unavailable' : 'Atlas storage'}</small></a>
            <a href="#/data" className="overview-metric"><span>Records</span><strong>{status.data?.records?.toLocaleString() ?? '—'}</strong><small>{status.error ? 'Unavailable' : 'Stored records'}</small></a>
            <a href="#/nodes" className="overview-metric"><span>Connected nodes</span><strong>{online ?? '—'}<em>{nodes.data ? ` / ${nodes.data.length}` : ''}</em></strong><small>{workspaceCount ?? '—'} hosted workspaces</small></a>
        </div>
        <div className="overview-content-grid">
            <div className="overview-content-column">
                <section className="overview-card overview-projects" aria-label="Projects overview">
                    <div className="overview-card-head"><h2>Projects</h2><a href="#/projects">All projects <span aria-hidden="true">↗</span></a></div>
                    <QueryNotice loading={projects.isLoading} error={projects.error} retry={projects.refetch} />
                    <ProjectRows projects={topProjects} />
                    {!projects.isLoading && !projects.error && projects.data?.length === 0 && <p className="overview-muted">No active projects.</p>}
                </section>
                <HomeRecent items={recent} kind="Application" projectIds={projectIds} />
                <HomeRecent items={recent} kind="View" projectIds={projectIds} />
            </div>
            <div className="overview-content-column">
                <section className="overview-card" aria-label="System health">
                    <div className="overview-card-head"><h2>System health</h2><a href="#/monitoring">Details <span aria-hidden="true">↗</span></a></div>
                    <div className="overview-service">
                        <span className="overview-item-main">
                            <strong>Atlas Server</strong>
                            <small>{status.data ? `v${status.data.version} · ${status.data.storage}` : status.error ? 'Unable to reach server' : 'Checking connection…'}</small>
                        </span>
                        <span className={`overview-status ${status.data ? 'online' : status.error ? 'offline' : 'pending'}`}>{status.data ? 'Connected' : status.error ? 'Unavailable' : 'Checking'}</span>
                    </div>
                    {nodes.data?.map(node => <div className="overview-service" key={node.id}>
                        <span className="overview-item-main"><strong>{node.name}</strong><small>{node.platform === 'linux' ? 'Linux node / server runtime' : node.platform === 'darwin' ? 'macOS node' : node.platform || 'Node'} · {node.hostedWorkspaceCount} workspaces</small></span>
                        <span className={`overview-status ${node.status === 'online' ? 'online' : 'offline'}`}>{node.status}</span>
                    </div>)}
                    {nodes.isLoading && <p className="overview-muted" role="status">Loading nodes…</p>}
                    {nodes.error && <p className="overview-muted">Node status unavailable. <button className="overview-inline-button" onClick={() => void nodes.refetch()}>Retry</button></p>}
                    {nodes.data?.length === 0 && <p className="overview-muted">No nodes registered.</p>}
                    <a href="#/nodes" className="overview-card-bottom-link">View nodes and connections <span aria-hidden="true">↗</span></a>
                </section>
                <HomeWorkspaces nodes={nodes.data} nodesUnavailable={!!nodes.error} refreshKey={workspaceRefresh} projects={projects.data ?? []} />
                <section className="overview-card" aria-label="Data overview">
                    <div className="overview-card-head"><h2>Data</h2><a href="#/data">Open data <span aria-hidden="true">↗</span></a></div>
                    <p className="overview-card-subtitle">{status.data?.storage ? `${status.data.storage} storage` : 'Atlas storage'}</p>
                    <div className="overview-data-summary">
                        <div><strong>{status.data?.stores ?? '—'}</strong><span>Stores</span></div>
                        <div><strong>{status.data?.records?.toLocaleString() ?? '—'}</strong><span>Records</span></div>
                        <div><strong>{status.data?.schemaVersion ?? '—'}</strong><span>Schema version</span></div>
                    </div>
                </section>
            </div>
        </div>
    </div>;
}

function ProjectCollection({ project, kind, search }: { project: Project; kind: 'views' | 'data'; search: string }) {
    const views = useListViewsQuery({ projectId: project.id }, { skip: kind !== 'views' });
    const stores = useListStoresQuery({ projectId: project.id }, { skip: kind !== 'data' });
    const query = kind === 'views' ? views : stores;
    const items = query.currentData?.filter(item => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(search.toLowerCase()));
    return <section className="workspace-section"><div className="section-heading"><h2>{project.name}</h2><div className="actions"><button className="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh</button><a href={`#/projects/${project.id}/${kind}`}>Manage {kind === 'views' ? 'Views' : 'stores'} →</a></div></div><QueryNotice loading={query.isFetching && !query.currentData} error={query.error} retry={query.refetch} />
        <div className="workspace-list">{items?.map(item => <a className="workspace-row" href={kind === 'views' ? standaloneViewUrl(item) : `#/projects/${project.id}/stores/${item.id}/records`} target={kind === 'views' ? '_blank' : undefined} rel={kind === 'views' ? 'noopener noreferrer' : undefined} onClick={() => { if (kind === 'views') rememberWork({ href: `#/projects/${project.id}/views/${item.id}`, name: item.name, projectId: project.id, kind: 'View', viewSlug: 'slug' in item ? item.slug : undefined }); }} key={item.id}><span className="row-copy"><strong>{item.name}</strong><small>{item.description || (kind === 'views' ? 'Open this project View' : 'Browse records and manage the store schema')}</small></span><span className="row-arrow" aria-hidden="true">→</span></a>)}</div>{items?.length === 0 && <p className="quiet-empty">{search ? 'No matches. Try another search.' : `No ${kind === 'views' ? 'Views' : 'stores'} in this project yet.`}</p>}
    </section>;
}
export function WorkspaceLibrary({ kind }: { kind: 'views' | 'data' }) {
    const projects = useListProjectsQuery({ includeArchived: false });
    const [selected, setSelected] = useState('');
    const [search, setSearch] = useState('');
    // The global library defaults to every project, not the first (Careers).
    // Each ProjectCollection owns its cached query, so changing the filter
    // preserves already-loaded results without requesting a global backend API.
    const visibleProjects = (projects.data ?? []).filter(project => !selected || project.id === selected);
    return <>
        <WorkspaceHeading title={kind === 'views' ? 'Views' : 'Data'} copy={kind === 'views' ? 'Explore the interfaces built around your projects.' : 'The stores and records behind your work, organised by project.'} />
        <QueryNotice loading={projects.isLoading} error={projects.error} retry={projects.refetch} />
        {!!projects.data?.length && <div className="browse-toolbar">
            <label>Project<select value={selected} onChange={event => setSelected(event.target.value)}>
                <option value="">All projects</option>
                {projects.data.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select></label>
            <label>Search<input type="search" placeholder={kind === 'views' ? 'Find a View…' : 'Find a store…'} value={search} onChange={event => setSearch(event.target.value)} /></label>
        </div>}
        {visibleProjects.map(project => <ProjectCollection key={`${kind}/${project.id}`} kind={kind} project={project} search={search} />)}
        {projects.data?.length === 0 && <p className="quiet-empty">Your {kind === 'views' ? 'Views' : 'data'} will appear here once you create a project. <a href="#/projects">Go to projects →</a></p>}
    </>;
}
export function MonitoringOverview() {
    const status = useWorkspaceStatusQuery(undefined, { refetchOnMountOrArgChange: true });
    const nodes = useWorkspaceNodesQuery(undefined, { refetchOnMountOrArgChange: true });
    return <><WorkspaceHeading title="Monitoring" copy="Server health and connectivity across Atlas."><a className="ghost" href="#/activity">Activity feed →</a><button className="ghost" disabled={status.isFetching || nodes.isFetching} onClick={() => { void status.refetch(); void nodes.refetch(); }}>Refresh</button></WorkspaceHeading><QueryNotice loading={status.isLoading || nodes.isLoading} error={status.error || nodes.error} retry={() => { void status.refetch(); void nodes.refetch(); }} />
        {status.data && <section className="workspace-section"><div className="section-heading"><h2>Atlas Server</h2><span className={"badge " + (IS_MOCK_MODE ? "muted" : "success")}>{IS_MOCK_MODE ? "Simulated" : "Connected"}</span></div><dl className="settings-list"><div><dt>Endpoint</dt><dd>{IS_MOCK_MODE ? "Local fixture backend" : API_BASE}</dd></div><div><dt>Version</dt><dd>{status.data.version}</dd></div><div><dt>Storage</dt><dd>{status.data.storage}</dd></div></dl></section>}
        <section className="workspace-section"><div className="section-heading"><h2>Remote nodes</h2><a href="#/nodes">Manage nodes & placement →</a></div>{nodes.data?.map(node => <a className="workspace-row" key={node.id} href="#/nodes"><span className="row-copy"><strong>{node.name}</strong><small>{node.hostedWorkspaceCount} workspaces · {node.platform || 'Remote runtime'}</small></span><span className={`badge ${node.status === 'online' ? 'success' : 'muted'}`}>{node.status}</span></a>)}{nodes.data?.length === 0 && <p className="quiet-empty">No remote nodes registered. <a href="#/nodes">Connect a node →</a></p>}</section>
    </>;
}
export function WorkspaceSettings() {
    const recent = useRecentWork();
    return <><WorkspaceHeading title="Settings" copy="Your Atlas connection and workspace preferences." /><dl className="settings-list"><div><dt>Server endpoint</dt><dd>{IS_MOCK_MODE ? "Local fixture backend (read-only)" : API_BASE}</dd></div><div><dt>Appearance</dt><dd>Graphite · Atlas purple</dd></div><div><dt>Recent work</dt><dd>Stored for this browser session. <button className="ghost" disabled={!recent.length} onClick={clearRecentWork}>Clear recent work</button></dd></div></dl><section className="workspace-section"><div className="section-heading"><h2>Advanced</h2></div><a className="workspace-row" href="#/developer"><span className="row-copy"><strong>Developer tools</strong><small>Inspect retrieval and access experimental features.</small></span><span className="row-arrow" aria-hidden="true">→</span></a></section><p className="hint">Manage project names, descriptions and archiving from each project's Settings tab.</p><a href="#/projects">Browse projects →</a></>;
}

/** Advanced tools live here instead of in the primary navigation. */
export function DeveloperHub() {
    return <><WorkspaceHeading title="Developer tools" copy="Diagnostics and experimental capabilities, separate from the production workspace." /><section className="workspace-section"><div className="workspace-list"><a className="workspace-row" href="#/fabric"><span className="row-copy"><strong>Retrieval inspector</strong><small>Inspect Fabric indexing and search internals.</small></span><span className="row-arrow" aria-hidden="true">→</span></a><a className="workspace-row" href="#/ask-atlas"><span className="row-copy"><strong>Ask Atlas · Experimental</strong><small>Requires a separately configured model runtime; not a production feature.</small></span><span className="row-arrow" aria-hidden="true">→</span></a></div></section><p className="hint"><a href="#/settings">← Back to settings</a></p></>;
}
