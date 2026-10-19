import { useEffect, useRef } from 'react';
import { ActivityFeed } from './ActivityFeed';
import { useRenderViewQuery } from './atlasApi';
import { ViewFrame } from './ViewPage';
import { editViewHash, standaloneViewUrl } from './viewLinks';
import type { Project, View } from './types';

/**
 * A bounded, non-interactive snapshot of a View. Interactions and scrolling
 * belong to its standalone tab, not to an iframe nested in a project page.
 */
export function ViewContainer({ view, refreshVersion = 0 }: { view: View; refreshVersion?: number }) {
    const { data: rendered, error, isLoading, isFetching, refetch } = useRenderViewQuery(
        { projectId: view.projectId, viewId: view.id, params: {} },
        { skip: !!view.archivedAt },
    );
    const previousRefresh = useRef(refreshVersion);
    useEffect(() => { if (refreshVersion !== previousRefresh.current && !view.archivedAt) void refetch(); previousRefresh.current = refreshVersion; }, [refreshVersion]);

    const archived = !!view.archivedAt;
    const launchUrl = standaloneViewUrl(view);
    return <article className={`view-card${archived ? ' view-card-archived' : ''}`} aria-label={view.name}>
        <header className="view-card-head">
            <div className="view-card-heading">
                <span className="eyebrow">View {archived && '· Archived'}</span>
                <h3>{view.name}</h3>
                {view.description && <p>{view.description}</p>}
            </div>
            <a className="view-card-edit" href={editViewHash(view)} aria-label={`Edit ${view.name}`}>Edit</a>
        </header>
        {archived
            ? <div className="view-card-placeholder">This View is archived.</div>
            : <a className="view-card-launch-surface" href={launchUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${view.name} in new tab`}>
                <div className="view-card-preview" inert aria-hidden="true">
                    {rendered ? <ViewFrame rendered={rendered} preview embedded /> : <div className="view-card-placeholder">{isLoading ? 'Loading preview…' : 'Preview unavailable'}</div>}
                </div>
                <span className="view-card-preview-label">Preview only · Open to interact</span>
            </a>}
        {isFetching && rendered && <small role="status">Refreshing…</small>}
        {error && !archived && <p className="view-card-error" role="status">Preview unavailable: {'message' in Object(error) ? String((error as { message: string }).message) : 'Atlas request failed'}</p>}
        <footer className="view-card-footer">
            <span>{archived ? 'Archived View' : 'Live View'}</span>
            {!archived && <a className="view-card-open" href={launchUrl} target="_blank" rel="noopener noreferrer">Open in new tab <span aria-hidden="true">↗</span></a>}
        </footer>
    </article>;
}

export function ProjectOverview({ project, views, viewsBusy, refreshVersion = 0 }: { project: Project; views?: View[]; viewsBusy: boolean; refreshVersion?: number }) {
    const active = views?.filter(v => !v.archivedAt) ?? [];
    return <div className="project-overview">
        <div className="project-context"><span className={`badge ${project.archivedAt ? 'muted' : 'neutral'}`}>{project.archivedAt ? 'Archived' : 'Project'}</span><span>Updated {new Date(project.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span><a href={`#/projects/${project.id}/data`}>Browse data →</a></div>
        {viewsBusy && <p role="status">Loading project Views…</p>}
        {!viewsBusy && views && active.length === 0 && <section className="overview-empty"><h2>A place for your project</h2><p>Bring your data into focus with a View, or explore this project's stores and workspaces.</p>{!project.archivedAt && <a href={`#/projects/${project.id}/views/new`}>Create a View →</a>}</section>}
        {!project.archivedAt && active.length > 0 && <section className="project-views">
            <header className="project-views-head"><div><p className="eyebrow">Project Views</p><h2>At a glance</h2></div><a href={`#/projects/${project.id}/views`}>All Views →</a></header>
            <div className="view-gallery">{active.slice(0, 2).map(view => <ViewContainer key={view.id} view={view} refreshVersion={refreshVersion} />)}</div>
        </section>}
        <ActivityFeed projectId={project.id} title="Recent activity" refreshVersion={refreshVersion} />
    </div>;
}
