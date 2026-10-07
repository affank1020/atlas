import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityFeed } from './ActivityFeed';
import { callTool } from './api';
import { ViewFrame } from './ViewPage';
import type { Project, View, ViewRenderResult } from './types';

/** Reuses the trusted View host; each embedded View owns its parameters independently. */
export function ViewContainer({ view }: { view: View }) {
    const [rendered, setRendered] = useState<ViewRenderResult>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(true);
    const request = useRef(0);
    const refresh = useCallback(async (params: Record<string, string> = {}) => {
        const current = ++request.current;
        setBusy(true);
        try {
            const result = await callTool<ViewRenderResult>('render_view', { projectId: view.projectId, viewId: view.id, params });
            if (current === request.current) { setRendered(result); setError(''); }
            return result;
        } catch (e) { if (current === request.current) setError((e as Error).message); throw e; }
        finally { if (current === request.current) setBusy(false); }
    }, [view.projectId, view.id]);
    useEffect(() => { void refresh().catch(() => {}); return () => { request.current++; }; }, [refresh]);
    return <section className="view-container" aria-label={view.name}>
        <header><p className="eyebrow">View</p><a href={`#/projects/${view.projectId}/views/${view.id}`}>Open View ↗</a></header>
        {busy && <p role="status">Loading View…</p>}
        {error && <div role="alert" className="notice error">{error} <button onClick={() => void refresh().catch(() => {})}>Retry</button></div>}
        {rendered && <ViewFrame rendered={rendered} embedded actionsEnabled actionViewId={view.id} onRefresh={refresh} onError={setError} />}
    </section>;
}
export function ProjectOverview({ project, views, viewsBusy }: { project: Project; views?: View[]; viewsBusy: boolean }) {
    const active = views?.filter(v => !v.archivedAt) ?? [];
    return <div className="project-overview">
        <div className="project-context"><span className={`badge ${project.archivedAt ? 'muted' : 'neutral'}`}>{project.archivedAt ? 'Archived' : 'Project'}</span><span>Updated {new Date(project.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span><a href={`#/projects/${project.id}/data`}>Browse data →</a></div>
        {viewsBusy && <p role="status">Loading project Views…</p>}
        {!viewsBusy && views && active.length === 0 && <section className="overview-empty"><h2>A place for your project</h2><p>Bring your data into focus with a View, or explore this project’s stores and workspaces.</p>{!project.archivedAt && <a href={`#/projects/${project.id}/views/new`}>Create a View →</a>}</section>}
        {!project.archivedAt && active.slice(0, 2).map(view => <ViewContainer key={view.id} view={view} />)}
        {active.length > 2 && <a className="all-views" href={`#/projects/${project.id}/views`}>Explore all {active.length} Views →</a>}
        <ActivityFeed projectId={project.id} title="Recent activity" />
    </div>;
}
