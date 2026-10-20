import { useEffect, useState, type ReactNode } from 'react';
import { ShellIcon, type ShellIconName } from './ShellIcon';
import { useRecentWork } from './recentWork';
import { useListProjectsQuery } from './atlasApi';
import { GlobalSearch } from './GlobalSearch';
import { IS_MOCK_MODE } from './api';

export type ProjectSection = 'overview' | 'data' | 'views' | 'applications' | 'workspaces' | 'activity' | 'settings';
const sections: ProjectSection[] = ['overview', 'data', 'views', 'applications', 'workspaces', 'activity', 'settings'];

export function ProjectNav({ projectId, section }: { projectId: string; section: ProjectSection }) {
    return <nav className="tabs project-nav" aria-label="Project sections">{sections.map(item => <a key={item} aria-current={section === item ? 'page' : undefined} className={section === item ? 'active' : ''} href={`#/projects/${projectId}${item === 'overview' ? '' : `/${item}`}`}>{item[0].toUpperCase() + item.slice(1)}</a>)}</nav>;
}

export function AppShell({ page, projectId, contentClass, children }: { page: string; projectId?: string; contentClass: string; children: ReactNode }) {
    const { data: projects = [], error, isLoading, refetch } = useListProjectsQuery({ includeArchived: false });
    const recent = useRecentWork();
    const [open, setOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    useEffect(() => setOpen(false), [page, projectId]);
    useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
    useEffect(() => { const shortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(value => !value); } }; window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut); }, []);
    const shortcuts = [...new Set(recent.map(item => item.projectId))].map(id => projects.find(p => p.id === id)).filter(p => !!p).slice(0, 5);
    const visibleProjects = shortcuts.length ? shortcuts : projects.slice(0, 5);
    const link = (href: string, label: string, active: boolean, icon: ShellIconName) => <a href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}><ShellIcon name={icon} /><span>{label}</span></a>;
    return <div className={`app-shell ${open ? 'nav-open' : ''}`}>
        <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
        <header className="topbar">
            <a className="brand" href="#/">
                <b>atlas<span className="brand-period" aria-hidden="true">.</span></b>
            </a>
            <div className="header-actions">
                {IS_MOCK_MODE && <span className="badge muted" title="Illustrative local fixtures; server writes are disabled">Mock data</span>}
                <button className="header-icon-link" type="button" onClick={() => setSearchOpen(true)} aria-label="Search Atlas" title="Search Atlas (⌘K)"><ShellIcon name="search" /></button>
                <a className="header-icon-link" href="#/activity" aria-label="Activity" title="Activity" aria-current={page === "activity" ? "page" : undefined}><ShellIcon name="activity" /></a>
                <a className="header-icon-link" href="#/settings" aria-label="Settings" title="Settings" aria-current={["settings", "developer", "fabric", "ask-atlas"].includes(page) ? "page" : undefined}><ShellIcon name="settings" /></a>
                <button className="nav-toggle ghost" aria-expanded={open} aria-controls="global-navigation" onClick={() => setOpen(!open)}>{open ? 'Close menu' : 'Menu'}</button>
            </div>
        </header>
        <aside className="sidebar" aria-label="Atlas navigation">
            <nav id="global-navigation" aria-label="Main navigation" onClick={event => { if ((event.target as HTMLElement).closest('a')) setOpen(false); }}>
                <div className="sidebar-primary-links">
                    {link('#/', 'Home', page === 'overview', 'home')}
                    {link('#/projects', 'Projects', page === 'projects' || page === 'project' || page === 'application', 'projects')}
                    {link('#/views', 'Views', page === 'views' || page === 'view', 'views')}
                    {link('#/data', 'Data', page === 'data' || page === 'store', 'data')}
                    {link('#/nodes', 'Nodes', page === 'nodes', 'nodes')}
                    {link('#/monitoring', 'Monitoring', page === 'monitoring', 'monitoring')}
                </div>
                <div className="sidebar-projects">
                    <p className="nav-group">{shortcuts.length ? 'Recent projects' : 'Your projects'}</p>
                    {visibleProjects.map(p => <a href={`#/projects/${p.id}`} key={p.id} className={p.id === projectId ? 'active project-link' : 'project-link'}><span className="project-monogram" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span><span>{p.name}</span></a>)}
                    {isLoading && <small role="status">Loading projects…</small>}
                    {error && <small className="nav-message">Projects unavailable <button onClick={() => void refetch()}>Retry</button></small>}
                </div>
            </nav>
        </aside>
        <div className="content-frame">
            <main id="main-content" tabIndex={-1} className={contentClass}>{children}</main>
        </div>
        {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}
    </div>;
}
