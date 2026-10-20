import { useRouteTiming } from './performance';
import { useEffect, useRef, lazy, Suspense, type ComponentType } from 'react';
import { useApplicationRead, useListProjectsQuery } from './atlasApi';
const Portfolio = lazy(() => import('./Portfolio').then(module => ({ default: module.Portfolio })));
const FootballGeneralistExperience = lazy(() => import('./FootballGeneralistExperience').then(module => ({ default: module.FootballGeneralistExperience })));
import './applications.css';

export type ApplicationManifest = {
    type: string;
    slug: string;
    name: string;
    description: string;
    projectId: string;
};

// First-party UI components ship with Atlas Web; the Server registry controls
// which Applications are attached to each Project.
const applicationComponents: Record<string, ComponentType> = {
    portfolio: Portfolio,
    'football-training': FootballGeneralistExperience,
};

export function ProjectApplications({ projectId, refreshVersion = 0 }: { projectId: string; refreshVersion?: number }) {
    const { data: applications = [], isLoading: busy, error: queryError, refetch } = useApplicationRead<ApplicationManifest[]>('list_applications', { projectId });
    const error = queryError?.message ?? '';
    const previousRefresh = useRef(refreshVersion);
    useEffect(() => { if (previousRefresh.current !== refreshVersion) void refetch(); previousRefresh.current = refreshVersion; }, [refreshVersion, refetch]);
    return <section className="panel project-applications" aria-label="Project Applications">
        <div className="panel-head"><div><p className="eyebrow">Applications</p><h2>Launch an application</h2></div><span>{applications.length} available <button onClick={() => void refetch()}>Refresh</button></span></div>
        <p className="application-section-copy">Applications open in their own tab. Unlike Views, they provide dedicated tools and workflows.</p>
        {busy && <p role="status" className="application-status">Loading Applications…</p>}
        {error && <div role="alert" className="notice error">{error}</div>}
        {!busy && !error && applications.length === 0 && <p className="application-status">No Applications are registered in this Project yet.</p>}
        <div className="application-grid">
            {applications.map(app => <article className="application-card" key={app.slug}>
                <div className="application-card-icon" aria-hidden="true">{app.name.slice(0, 2).toUpperCase()}</div>
                <div className="application-card-details"><h3>{app.name}</h3><p>{app.description}</p><small>{app.type} Application</small></div>
                <a className="button application-launch" href={`#/projects/${projectId}/applications/${app.slug}`} target="_blank" rel="noopener noreferrer" aria-label={`Launch ${app.name} in a new tab`}>Launch ↗</a>
            </article>)}
        </div>
    </section>;
}

export function ApplicationWindow({ projectId, slug }: { projectId: string; slug: string }) {
    useListProjectsQuery({ includeArchived: false });
    const { data: application, error: queryError, isLoading: busy, refetch } = useApplicationRead<ApplicationManifest>('get_application', { projectId, slug });
    const error = queryError?.message ?? '';
    useEffect(() => {
        if (!application) return;
        const previous = document.title;
        document.title = `${application.name} · Atlas`;
        return () => { document.title = previous; };
    }, [application]);
    useRouteTiming("application-manifest", `${projectId}/${slug}`, !!application);
    const currentApplication = application?.projectId === projectId && application.slug === slug ? application : undefined;
    const Component = currentApplication ? applicationComponents[currentApplication.type] : undefined;
    return <div className="application-window">
        <header className="application-window-bar">
            <a href={`#/projects/${projectId}/applications`} className="application-back">← Project Applications</a>
            {slug !== 'portfolio' && <button onClick={() => void refetch()}>Refresh application</button>}<span className="application-window-brand">Atlas / {application?.name ?? 'Application'}</span>
        </header>
        <main className="application-window-main">
            {busy && <p role="status" className="application-status">Loading Application…</p>}
            {error && <div role="alert" className="notice error">{error}</div>}
            {!busy && !error && currentApplication && !Component && <div role="alert" className="notice error">This Application is registered on Atlas Server but its UI is not included in this version of Atlas Web.</div>}
            {Component && !busy && <Suspense fallback={<p role="status">Loading application interface…</p>}><Component /></Suspense>}
        </main>
    </div>;
}
