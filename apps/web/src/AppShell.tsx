import { useEffect, useState, type ReactNode } from 'react';
import { useRecentWork } from './recentWork';
import { useListProjectsQuery } from './atlasApi';

export type ProjectSection = 'overview' | 'data' | 'views' | 'applications' | 'workspaces' | 'activity' | 'settings';
const sections: ProjectSection[] = ['overview', 'data', 'views', 'applications', 'workspaces', 'activity', 'settings'];
export function ProjectNav({ projectId, section }: { projectId: string; section: ProjectSection }) {
    return <nav className="tabs project-nav" aria-label="Project sections">{sections.map(item => <a key={item} aria-current={section === item ? 'page' : undefined} className={section === item ? 'active' : ''} href={`#/projects/${projectId}${item === 'overview' ? '' : `/${item}`}`}>{item[0].toUpperCase() + item.slice(1)}</a>)}</nav>;
}

export function AppShell({ page, projectId, contentClass, children }: { page: string; projectId?: string; contentClass: string; children: ReactNode }) {
    const { data: projects = [], error, isLoading, refetch } = useListProjectsQuery({ includeArchived: false });
    const recent = useRecentWork();
    const [open, setOpen] = useState(false);
    useEffect(() => setOpen(false), [page, projectId]);
    useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
    const shortcuts = [...new Set(recent.map(item => item.projectId))].map(id => projects.find(p => p.id === id)).filter(p => !!p).slice(0, 5);
    const visibleProjects = shortcuts.length ? shortcuts : projects.slice(0, 5);
    const project = projects.find(p => p.id === projectId);
    const link = (href: string, label: string, active: boolean, icon: string) => <a href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}><span aria-hidden="true" className="nav-icon">{icon}</span>{label}</a>;
    return <div className={`app-shell ${open ? 'nav-open' : ''}`}>
        <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
        <aside className="sidebar" aria-label="Atlas navigation">
            <a className="brand" href="#/"><span aria-hidden="true">A</span><div><b>Atlas</b><small>Workspace</small></div></a>
            <button className="nav-toggle ghost" aria-expanded={open} aria-controls="global-navigation" onClick={() => setOpen(!open)}>{open ? 'Close menu' : 'Menu'}</button>
            <nav id="global-navigation" aria-label="Main navigation" onClick={event => { if ((event.target as HTMLElement).closest("a")) setOpen(false); }}>
                {link('#/', 'Home', page === 'overview', '⌂')}
                {link('#/projects', 'Projects', page === 'projects' || page === 'project' || page === 'application', '▦')}
                {link('#/views', 'Views', page === 'views' || page === 'view', '▧')}
                {link('#/data', 'Data', page === 'data' || page === 'store', '≡')}
                {link('#/infrastructure', 'Infrastructure', ['infrastructure', 'nodes', 'activity', 'fabric'].includes(page), '◇')}
                <p className="nav-group">{shortcuts.length ? 'Recent projects' : 'Your projects'}</p>
                {visibleProjects.map(p => <a href={`#/projects/${p.id}`} key={p.id} className={p.id === projectId ? 'active project-link' : 'project-link'}><span className="project-monogram" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span><span>{p.name}</span></a>)}
                {isLoading && <small role="status">Loading projects…</small>}{error && <small className="nav-message">Projects unavailable <button onClick={() => void refetch()}>Retry</button></small>}
                <div className="nav-bottom">
                    {link('#/settings', 'Settings', page === 'settings', '⚙')}
                    <span className="sidebar-caption">A place for everything you build.</span>
                </div>
            </nav>
        </aside>
        <div className="content-frame">
            <header className="topbar"><div><a href="#/">Atlas</a><span>/</span><span>{project?.name ?? (page === 'overview' ? 'Home' : page === 'fabric' ? 'Developer' : page === 'ask-atlas' ? 'Ask Atlas' : page.charAt(0).toUpperCase() + page.slice(1).replaceAll('-', ' '))}</span></div><a className="ask-entry" href="#/ask-atlas">Ask Atlas <span aria-hidden="true">↗</span></a></header>
            <main id="main-content" tabIndex={-1} className={contentClass}>{children}</main>
        </div>
    </div>;
}
