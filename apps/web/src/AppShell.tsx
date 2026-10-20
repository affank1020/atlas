import { useEffect, useState, type ReactNode } from 'react';
import { useRecentWork } from './recentWork';
import { useListProjectsQuery } from './atlasApi';

export type ProjectSection = 'overview' | 'data' | 'views' | 'applications' | 'workspaces' | 'activity' | 'settings';
const sections: ProjectSection[] = ['overview', 'data', 'views', 'applications', 'workspaces', 'activity', 'settings'];

type ShellIconName = 'home' | 'projects' | 'views' | 'data' | 'infrastructure' | 'activity' | 'settings' | 'search' | 'sparkles' | 'user';
export function ShellIcon({ name }: { name: ShellIconName }) {
    const drawings: Record<ShellIconName, ReactNode> = {
        home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M9 21v-8h6v8" /></>,
        projects: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>,
        views: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>,
        data: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3" /></>,
        infrastructure: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="8.5" y="14" width="7" height="7" rx="1.5" /><path d="M6.5 10v2h12v-2M12 12v2" /></>,
        activity: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
        settings: <><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /><circle cx="12" cy="12" r="4" /></>,
        search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
        sparkles: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" /></>,
        user: <><circle cx="12" cy="8" r="3.5" /><path d="M5.5 20c.3-4 2.7-6 6.5-6s6.2 2 6.5 6" /></>,
    };
    return <svg className="shell-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{drawings[name]}</svg>;
}

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
    const link = (href: string, label: string, active: boolean, icon: ShellIconName) => <a href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}><ShellIcon name={icon} /><span>{label}</span></a>;
    return <div className={`app-shell ${open ? 'nav-open' : ''}`}>
        <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
        <header className="topbar">
            <a className="brand" href="#/">
                <b>atlas<span className="brand-period" aria-hidden="true">.</span></b>
            </a>
            <div className="header-actions">
                <a className="header-icon-link" href="#/projects" aria-label="Browse projects" title="Browse projects"><ShellIcon name="search" /></a>
                <a className="header-icon-link" href="#/activity" aria-label="Activity" title="Activity"><ShellIcon name="activity" /></a>
                <a className="ask-entry" href="#/ask-atlas"><ShellIcon name="sparkles" /><span>Ask Atlas</span></a>
                <a className="header-profile" href="#/settings" aria-label="Settings" title="Settings"><ShellIcon name="user" /></a>
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
                    {link('#/infrastructure', 'Infrastructure', ['infrastructure', 'nodes', 'activity', 'fabric'].includes(page), 'infrastructure')}
                </div>
                <div className="sidebar-projects">
                    <p className="nav-group">{shortcuts.length ? 'Recent projects' : 'Your projects'}</p>
                    {visibleProjects.map(p => <a href={`#/projects/${p.id}`} key={p.id} className={p.id === projectId ? 'active project-link' : 'project-link'}><span className="project-monogram" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span><span>{p.name}</span></a>)}
                    {isLoading && <small role="status">Loading projects…</small>}
                    {error && <small className="nav-message">Projects unavailable <button onClick={() => void refetch()}>Retry</button></small>}
                </div>
                <div className="nav-bottom">
                    {link('#/settings', 'Settings', page === 'settings', 'settings')}
                </div>
            </nav>
        </aside>
        <div className="content-frame">
            <main id="main-content" tabIndex={-1} className={contentClass}>{children}</main>
        </div>
    </div>;
}
