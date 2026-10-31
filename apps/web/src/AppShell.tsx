import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ShellIcon, type ShellIconName } from './ShellIcon';
import { AtlasTopBar } from './AtlasTopBar';
import { useRecentWork } from './recentWork';
import { useListProjectsQuery } from './atlasApi';
import { SkeletonRows } from './Skeletons';

export type ProjectSection = 'overview' | 'data' | 'views' | 'applications' | 'workspaces' | 'activity' | 'settings';
const sections: ProjectSection[] = ['overview', 'data', 'views', 'applications', 'workspaces', 'activity', 'settings'];

export function ProjectNav({ projectId, section }: { projectId: string; section: ProjectSection }) {
    return <nav className="tabs project-nav" aria-label="Project sections">{sections.map(item => <a key={item} aria-current={section === item ? 'page' : undefined} className={section === item ? 'active' : ''} href={`#/projects/${projectId}${item === 'overview' ? '' : `/${item}`}`}>{item[0].toUpperCase() + item.slice(1)}</a>)}</nav>;
}

export function AppShell({ page, projectId, contentClass, children }: { page: string; projectId?: string; contentClass: string; children: ReactNode }) {
    const { data: projects = [], error, isLoading, refetch } = useListProjectsQuery({ includeArchived: false });
    const recent = useRecentWork();
    const [open, setOpen] = useState(false);
    const contentFrameRef = useRef<HTMLDivElement>(null);
    useEffect(() => setOpen(false), [page, projectId]);
    // Keep the content pane's position while selecting Workspaces or checkouts.
    // These are URL state changes within the same page, not page navigation.
    useEffect(() => {
        let previousRoute = window.location.hash.split('?')[0];
        const resetContentScroll = () => {
            const nextRoute = window.location.hash.split('?')[0];
            const withinWorkspaces = previousRoute === '#/workspaces' && nextRoute === '#/workspaces';
            if (!withinWorkspaces && contentFrameRef.current) contentFrameRef.current.scrollTop = 0;
            previousRoute = nextRoute;
        };
        window.addEventListener('hashchange', resetContentScroll);
        return () => window.removeEventListener('hashchange', resetContentScroll);
    }, []);
    useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
    const shortcuts = [...new Set(recent.map(item => item.projectId))].map(id => projects.find(p => p.id === id)).filter(p => !!p).slice(0, 5);
    const visibleProjects = shortcuts.length ? shortcuts : projects.slice(0, 5);
    const link = (href: string, label: string, active: boolean, icon: ShellIconName) => <a href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}><ShellIcon name={icon} /><span>{label}</span></a>;
    return <div className={`app-shell ${open ? 'nav-open' : ''}`}>
        <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
        <AtlasTopBar page={page} menuOpen={open} onToggleMenu={() => setOpen(!open)} />
        <aside className="sidebar" aria-label="Atlas navigation">
            <nav id="global-navigation" aria-label="Main navigation" onClick={event => { if ((event.target as HTMLElement).closest('a')) setOpen(false); }}>
                <div className="sidebar-primary-links">
                    {link('#/', 'Home', page === 'overview', 'home')}
                    {link('#/projects', 'Projects', page === 'projects' || page === 'project' || page === 'view', 'projects')}
                    {link('#/applications', 'Applications', page === 'applications', 'applications')}
                    {link('#/data', 'Data', page === 'data' || page === 'store', 'data')}
                    {link('#/files', 'Files', page === 'files', 'files')}
                    {link('#/nodes', 'Nodes', (page === 'nodes' || page === 'node-software'), 'nodes')}
                    {link('#/workspaces', 'Workspaces', page === 'workspaces', 'workspaces')}
                    {link('#/monitoring', 'Monitoring', page === 'monitoring', 'monitoring')}
                </div>
                <div className="sidebar-projects">
                    <p className="nav-group">{shortcuts.length ? 'Recent projects' : 'Your projects'}</p>
                    {visibleProjects.map(p => <a href={`#/projects/${p.id}`} key={p.id} className={p.id === projectId ? 'active project-link' : 'project-link'}><span className="project-monogram" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span><span>{p.name}</span></a>)}
                    {isLoading && !visibleProjects.length && !error && <SkeletonRows label="Loading project navigation" variant="nav" rows={4} />}
                    {error && <small className="nav-message">Projects unavailable <button onClick={() => void refetch()}>Retry</button></small>}
                </div>
            </nav>
        </aside>
        <div className="content-frame" ref={contentFrameRef}>
            <main id="main-content" tabIndex={-1} className={contentClass}>{children}</main>
        </div>
    </div>;
}
