import { standaloneViewUrl } from './viewLinks';
import { useState } from 'react';
import { API_BASE } from './api';
import { useListProjectsQuery, useListStoresQuery, useListViewsQuery, useWorkspaceNodesQuery, useWorkspaceStatusQuery } from './atlasApi';
import { clearRecentWork, rememberWork, useRecentWork } from './recentWork';
import type { Project } from './types';

export function WorkspaceHeading({ title, copy, children }: { title: string; copy: string; children?: React.ReactNode }) {
    return <header className="page-head"><div><p className="eyebrow">Atlas workspace</p><h1>{title}</h1><p>{copy}</p></div><div className="actions">{children}</div></header>;
}
export function QueryNotice({ loading, error, retry }: { loading: boolean; error: unknown; retry: () => unknown }) {
    return <>{loading && <p className="workspace-loading" role="status">Loading…</p>}{!!error && <div className="notice error" role="alert">Unable to load this section. <button className="ghost" onClick={() => retry()}>Try again</button></div>}</>;
}
export function ProjectRows({ projects }: { projects: Project[] }) {
    return <div className="workspace-list">{projects.map(project => <a className="workspace-row" key={project.id} href={`#/projects/${project.id}`}><span className="project-monogram" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span><span className="row-copy"><strong>{project.name}</strong><small>{project.description || 'Projects, applications and ideas in one place.'}</small></span>{project.archivedAt && <span className="badge muted">Archived</span>}<span className="row-arrow" aria-hidden="true">↗</span></a>)}</div>;
}
export function WorkspaceHome() {
    const projects = useListProjectsQuery({ includeArchived: false });
    const status = useWorkspaceStatusQuery(undefined, { refetchOnMountOrArgChange: true });
    const nodes = useWorkspaceNodesQuery(undefined, { refetchOnMountOrArgChange: true });
    const recent = useRecentWork().filter(item => projects.data?.some(p => p.id === item.projectId));
    const refresh = () => { void projects.refetch(); void status.refetch(); void nodes.refetch(); };
    return <div className="workspace-home"><WorkspaceHeading title="Your workspace." copy="Projects, data, applications and infrastructure. Together in Atlas."><button className="ghost" disabled={projects.isFetching || status.isFetching || nodes.isFetching} onClick={refresh}>Refresh</button></WorkspaceHeading>
        <section className="workspace-section"><div className="section-heading"><h2>Continue where you left off</h2><span>This session</span></div>
            {recent.length ? <div className="recent-grid">{recent.slice(0, 4).map(item => <a className="recent-item" href={item.kind === 'View' ? standaloneViewUrl({ projectId: item.projectId, id: item.href.split('/').pop()!, slug: item.viewSlug }) : item.href} target={item.kind === 'View' ? '_blank' : undefined} rel={item.kind === 'View' ? 'noopener noreferrer' : undefined} key={item.href}><small>{item.kind}</small><strong>{item.name}</strong><span aria-hidden="true">↗</span></a>)}</div> : <p className="quiet-empty">Open a project or View and find it here next time.</p>}
        </section>
        <section className="workspace-section"><div className="section-heading"><h2>Projects & applications</h2><a href="#/projects">All projects <span aria-hidden="true">→</span></a></div><QueryNotice loading={projects.isLoading} error={projects.error} retry={projects.refetch} /><ProjectRows projects={(projects.data ?? []).slice(0, 6)} />{projects.data?.length === 0 && <p className="quiet-empty">Start with a project to bring your work together. <a href="#/projects">Create your first project →</a></p>}</section>
        <section className="infrastructure-summary" aria-label="Infrastructure summary"><div><h2>Infrastructure</h2><p>{status.data ? `Atlas Server v${status.data.version}` : status.isLoading ? 'Connecting to Atlas…' : 'Server status unavailable'}{nodes.data && ` · ${nodes.data.filter(node => node.status === 'online').length} of ${nodes.data.length} nodes online`}</p></div><a href="#/infrastructure">Manage infrastructure →</a></section>
        <QueryNotice loading={false} error={status.error || nodes.error} retry={refresh} />
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
export function InfrastructureNav({ page }: { page: string }) {
    return <nav className="tabs infrastructure-nav" aria-label="Infrastructure sections">{[['infrastructure', 'Overview'], ['nodes', 'Nodes'], ['activity', 'Activity'], ['fabric', 'Developer']].map(([route, name]) => <a key={route} href={`#/${route}`} className={route === page ? 'active' : ''} aria-current={route === page ? 'page' : undefined}>{name}</a>)}</nav>;
}
export function InfrastructureOverview() {
    const status = useWorkspaceStatusQuery(undefined, { refetchOnMountOrArgChange: true });
    const nodes = useWorkspaceNodesQuery(undefined, { refetchOnMountOrArgChange: true });
    return <><WorkspaceHeading title="Infrastructure" copy="The server, nodes and workspaces that keep Atlas running."><button className="ghost" disabled={status.isFetching || nodes.isFetching} onClick={() => { void status.refetch(); void nodes.refetch(); }}>Refresh</button></WorkspaceHeading><QueryNotice loading={status.isLoading || nodes.isLoading} error={status.error || nodes.error} retry={() => { void status.refetch(); void nodes.refetch(); }} />
        {status.data && <section className="workspace-section"><div className="section-heading"><h2>Atlas Server</h2><span className="badge success">Connected</span></div><dl className="settings-list"><div><dt>Endpoint</dt><dd>{API_BASE}</dd></div><div><dt>Version</dt><dd>{status.data.version}</dd></div><div><dt>Storage</dt><dd>{status.data.storage}</dd></div></dl></section>}
        <section className="workspace-section"><div className="section-heading"><h2>Remote nodes</h2><a href="#/nodes">Manage nodes & placement →</a></div>{nodes.data?.map(node => <a className="workspace-row" key={node.id} href="#/nodes"><span className="row-copy"><strong>{node.name}</strong><small>{node.hostedWorkspaceCount} workspaces · {node.platform || 'Remote runtime'}</small></span><span className={`badge ${node.status === 'online' ? 'success' : 'muted'}`}>{node.status}</span></a>)}{nodes.data?.length === 0 && <p className="quiet-empty">No remote nodes registered. <a href="#/nodes">Connect a node →</a></p>}</section>
    </>;
}
export function WorkspaceSettings() {
    const recent = useRecentWork();
    return <><WorkspaceHeading title="Settings" copy="Your Atlas connection and workspace preferences." /><dl className="settings-list"><div><dt>Server endpoint</dt><dd>{API_BASE}</dd></div><div><dt>Appearance</dt><dd>Graphite · Atlas purple</dd></div><div><dt>Recent work</dt><dd>Stored for this browser session. <button className="ghost" disabled={!recent.length} onClick={clearRecentWork}>Clear recent work</button></dd></div></dl><p className="hint">Manage project names, descriptions and archiving from each project's Settings tab.</p><a href="#/projects">Browse projects →</a></>;
}
