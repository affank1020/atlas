import { useRouteTiming } from './performance';
import { rememberWork } from './recentWork';
import { useEffect, useRef, lazy, Suspense, type ComponentType } from 'react';
import { useApplicationRead } from './atlasApi';
import { AtlasTopBar } from './AtlasTopBar';
const Portfolio = lazy(() => import('./Portfolio').then(module => ({ default: module.Portfolio })));
const FootballGeneralistExperience = lazy(() => import('./FootballGeneralistExperience').then(module => ({ default: module.FootballGeneralistExperience })));
const CodeReviews = lazy(() => import('./CodeReviews').then(module => ({ default: module.CodeReviews })));
import './applications.css';
import { SkeletonProjectApplications, SkeletonApplicationWindow } from './Skeleton';

export type ApplicationManifest = {
    type: string;
    slug: string;
    name: string;
    description: string;
    projectId: string | null;
};

// First-party UI components ship with Atlas Web; the Server registry controls
// which Applications are attached to each Project.
const applicationComponents: Record<string, ComponentType> = {
    portfolio: Portfolio,
    'football-training': FootballGeneralistExperience,
    'code-reviews': CodeReviews,
};

export function ProjectApplications({ projectId, refreshVersion = 0 }: { projectId: string; refreshVersion?: number }) {
    const { data: applications = [], isLoading: busy, error: queryError, refetch } = useApplicationRead<ApplicationManifest[]>('list_applications', { projectId });
    const error = queryError?.message ?? '';
    const previousRefresh = useRef(refreshVersion);
    useEffect(() => { if (previousRefresh.current !== refreshVersion) void refetch(); previousRefresh.current = refreshVersion; }, [refreshVersion, refetch]);
    return <section className="panel project-applications" aria-label="Project Applications">
        <div className="panel-head"><div><p className="eyebrow">Applications</p><h2>Launch an application</h2></div><span>{busy ? '— available' : `${applications.length} available`} <button onClick={() => void refetch()}>Refresh</button></span></div>
        <p className="application-section-copy">Applications open within Atlas. Unlike Views, they provide dedicated tools and workflows.</p>
        {busy && applications.length === 0 && <SkeletonProjectApplications />}
        {error && <div role="alert" className="notice error">{error}</div>}
        {!busy && !error && applications.length === 0 && <p className="application-status">No Applications are registered in this Project yet.</p>}
        {applications.length > 0 && <div className="application-grid">
            {applications.map(app => <article className="application-card" key={app.slug}>
                <div className="application-card-icon" aria-hidden="true">{app.name.slice(0, 2).toUpperCase()}</div>
                <div className="application-card-details"><h3>{app.name}</h3><p>{app.description}</p><small>{app.type} Application</small></div>
                <a className="button application-launch" href={`#/projects/${projectId}/applications/${app.slug}`} onClick={() => rememberWork({ href: `#/projects/${projectId}/applications/${app.slug}`, name: app.name, projectId, kind: 'Application' })} aria-label={`Launch ${app.name}`}>Launch →</a>
            </article>)}
        </div>}
    </section>;
}

export function ApplicationWindow({ projectId, slug }: { projectId?: string; slug: string }) {
    const { data: application, error: queryError, isLoading: busy, refetch } = useApplicationRead<ApplicationManifest>('get_application', projectId ? { projectId, slug } : { slug });
    const error = queryError?.message ?? '';
    useEffect(() => {
        if (!application) return;
        const previous = document.title;
        document.title = `${application.name} · Atlas`;
        return () => { document.title = previous; };
    }, [application]);
    useRouteTiming("application-manifest", `${projectId}/${slug}`, !!application);
    const currentApplication = (application?.projectId ?? null) === (projectId ?? null) && application?.slug === slug ? application : undefined;
    useEffect(() => {
        if (currentApplication) rememberWork({ href: projectId ? `#/projects/${projectId}/applications/${slug}` : `#/applications/${slug}`, name: currentApplication.name, projectId: projectId ?? null, kind: 'Application' });
    }, [projectId, slug, currentApplication?.name]);
    const Component = currentApplication ? applicationComponents[currentApplication.type] : undefined;
    return <div className="application-window">
        <AtlasTopBar page="application" context={<nav className="application-breadcrumb" aria-label="Application location">
            <a href={projectId ? `#/projects/${projectId}/applications` : '#/applications'} className="application-back">← {projectId ? 'Project Applications' : 'All Applications'}</a>
            <span className="application-breadcrumb-separator" aria-hidden="true">/</span>
            <span className="application-window-name" title={application?.name ?? slug}>{application?.name ?? 'Application'}</span>
        </nav>} />
        <main className="application-window-main">
            {busy && !application && <SkeletonApplicationWindow />}
            {error && <div role="alert" className="notice error">{error} <button type="button" className="ghost" onClick={() => void refetch()}>Retry</button></div>}
            {!busy && !error && currentApplication && !Component && <div role="alert" className="notice error">This Application is registered on Atlas Server but its UI is not included in this version of Atlas Web.</div>}
            {Component && <Suspense fallback={<SkeletonApplicationWindow />}><Component /></Suspense>}
        </main>
    </div>;
}
