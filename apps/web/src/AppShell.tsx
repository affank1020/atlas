import { useEffect, useState, type ReactNode } from 'react';
import { API_BASE, callTool } from './api';
import type { Project } from './types';

export type ProjectSection = 'overview' | 'data' | 'views' | 'applications' | 'workspaces' | 'activity' | 'settings';
const sections: ProjectSection[] = ['overview', 'data', 'views', 'applications', 'workspaces', 'activity', 'settings'];
export function ProjectNav({ projectId, section }: { projectId: string; section: ProjectSection }) {
    return <nav className="tabs project-nav" aria-label="Project sections">{sections.map(item => <a key={item} aria-current={section === item ? 'page' : undefined} className={section === item ? 'active' : ''} href={`#/projects/${projectId}${item === 'overview' ? '' : `/${item}`}`}>{item[0].toUpperCase() + item.slice(1)}</a>)}</nav>;
}

export function AppShell({ page, projectId, contentClass, children }: { page: string; projectId?: string; contentClass: string; children: ReactNode }) {
    const [projects, setProjects] = useState<Project[]>([]);
    const [error, setError] = useState('');
    const [open, setOpen] = useState(false);
    useEffect(() => {
        let live = true;
        callTool<Project[]>('list_projects').then(value => { if (live) { setProjects(value); setError(''); } }).catch(() => { if (live) setError('Projects unavailable'); });
        setOpen(false);
        return () => { live = false; };
    }, [page, projectId, location.hash]);
    const project = projects.find(p => p.id === projectId);
    const link = (href: string, label: string, active: boolean, icon: string) => <a href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}><span aria-hidden="true" className="nav-icon">{icon}</span>{label}</a>;
    return <div className={`app-shell ${open ? 'nav-open' : ''}`}>
        <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
        <aside className="sidebar" aria-label="Atlas navigation">
            <a className="brand" href="#/"><span aria-hidden="true">A</span><div><b>Atlas</b><small>WEB</small></div></a>
            <button className="nav-toggle ghost" aria-expanded={open} aria-controls="global-navigation" onClick={() => setOpen(!open)}>{open ? 'Close menu' : 'Menu'}</button>
            <nav id="global-navigation" aria-label="Main navigation">
                {link('#/', 'Home', page === 'overview', '⌂')}
                <p className="nav-group">Projects</p>
                {link('#/projects', 'All projects', page === 'projects', '▦')}
                {projects.map(p => <a href={`#/projects/${p.id}`} key={p.id} className={p.id === projectId ? 'active project-link' : 'project-link'} aria-current={p.id === projectId ? 'page' : undefined}><span className="project-monogram" aria-hidden="true">{p.name.slice(0, 2).toUpperCase()}</span><span>{p.name}</span></a>)}
                {error && <small className="nav-message">{error}</small>}
                <p className="nav-group">Infrastructure</p>
                {link('#/nodes', 'Nodes', page === 'nodes', '▤')}
                {link('#/activity', 'Activity', page === 'activity', '≋')}
                <p className="nav-group">Tools</p>
                <details className="developer-nav" open={page === 'fabric' || undefined}><summary>Developer</summary>{link('#/fabric', 'Retrieval inspector', page === 'fabric', '⌘')}</details>
            </nav>
            <div className="sidebar-foot">Atlas Server<small>{API_BASE}</small></div>
        </aside>
        <div className="content-frame">
            <header className="topbar"><div><a href="#/">Atlas</a><span>/</span><span>{project?.name ?? (page === 'overview' ? 'Home' : page === 'fabric' ? 'Developer' : page === 'ask-atlas' ? 'Ask Atlas' : page.charAt(0).toUpperCase() + page.slice(1).replaceAll('-', ' '))}</span></div><a className="ask-entry" href="#/ask-atlas">Ask Atlas <span aria-hidden="true">↗</span></a></header>
            <main id="main-content" tabIndex={-1} className={contentClass}>{children}</main>
        </div>
    </div>;
}
