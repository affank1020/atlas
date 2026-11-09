import { useState } from 'react';
import { useAllViewsQuery, useApplicationRead } from './atlasApi';
import { editViewHash, standaloneViewUrl } from './viewLinks';
import { rememberWork } from './recentWork';
import { CatalogueHeading, CatalogueToolbar, filterCatalogue } from './CatalogueBrowse';
import type { ApplicationManifest } from './Applications';
import './applications-directory.css';
import { SkeletonCards } from './Skeleton';

const launchHref = (app: ApplicationManifest) => app.projectId
    ? `#/projects/${app.projectId}/applications/${app.slug}`
    : `#/applications/${app.slug}`;

function ApplicationSymbol({ type }: { type: string }) {
    return <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {type === 'portfolio'
            ? <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>
            : type === 'football-training'
                ? <><circle cx="12" cy="12" r="9" /><path d="m12 6 4 3-1.5 4.5h-5L8 9zM9.5 13.5 6 16m8.5-2.5L18 16" /></>
                : <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>}
    </svg>;
}

/** Global launcher: one read of the server registry, independent of how many Projects exist. */
export function ApplicationsDirectory() {
    const [search, setSearch] = useState('');
    const [viewSearch, setViewSearch] = useState('');
    const { data: applications = [], error, isLoading, isFetching, refetch } = useApplicationRead<ApplicationManifest[]>('list_all_applications');
    const visible = filterCatalogue(applications, search, app => `${app.name} ${app.description}`)
        .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
    const { data: views = [], error: viewsError, isLoading: viewsLoading, isFetching: viewsFetching, refetch: refetchViews } = useAllViewsQuery();
    const visibleViews = filterCatalogue(views, viewSearch, view => `${view.name} ${view.description ?? ''} ${view.projectName}`)
        .sort((a, b) => a.name.localeCompare(b.name) || a.projectName.localeCompare(b.projectName));

    return <section className="applications-directory catalogue-page" aria-label="Applications">
        <CatalogueHeading title="Applications" actions={
            <button type="button" className="ghost" onClick={() => void refetch()} disabled={isFetching}
                aria-label="Refresh applications">↻ Refresh</button>
        } />
        <CatalogueToolbar label="Search applications" placeholder="Find an application…" query={search}
            onQueryChange={setSearch} count={isLoading ? null : visible.length} itemName="application" />
        {isLoading && <SkeletonCards count={4} label="Loading applications" />}
        {error && <div className="notice error" role="alert">Couldn't load applications. <button type="button" className="ghost" onClick={() => void refetch()}>Try again</button></div>}
        {isFetching && !isLoading && !error && <small role="status" className="applications-refresh-status">Refreshing applications…</small>}
        {!isLoading && !error && visible.length === 0 && <p className="application-directory-state">{applications.length === 0 ? 'No applications are registered yet.' : 'No applications match your search.'}</p>}
        {!isLoading && !error && <div className="applications-directory-grid">
            {visible.map(app => <a key={`${app.projectId ?? 'standalone'}/${app.slug}`}
                className="applications-directory-card" href={launchHref(app)}
                aria-label={`Launch ${app.name}`}
                onClick={() => rememberWork({ href: launchHref(app), name: app.name, projectId: app.projectId, kind: 'Application' })}>
                <span className="applications-directory-icon"><ApplicationSymbol type={app.type} /></span>
                <span className="applications-directory-arrow" aria-hidden="true">→</span>
                <span className="applications-directory-card-name">{app.name}</span>
                <span className="applications-directory-card-copy">{app.description}</span>
            </a>)}
        </div>}
        <section className="views-directory" aria-label="Views">
            <header className="views-directory-head">
                <div><p className="eyebrow">Views</p><h2>Project Views</h2>
                    <p>Open dashboards and saved Views directly, without navigating through Projects.</p></div>
                <button type="button" className="ghost" onClick={() => void refetchViews()} disabled={viewsFetching}
                    aria-label="Refresh views">↻ Refresh</button>
            </header>
            <CatalogueToolbar label="Search views" placeholder="Find a View or project…" query={viewSearch}
                onQueryChange={setViewSearch} count={viewsLoading ? null : visibleViews.length} itemName="view" />
            {viewsLoading && <SkeletonCards count={4} label="Loading views" />}
            {viewsError && <div className="notice error" role="alert">Couldn't load Views. <button type="button" className="ghost" onClick={() => void refetchViews()}>Try again</button></div>}
            {viewsFetching && !viewsLoading && !viewsError && <small role="status" className="applications-refresh-status">Refreshing Views…</small>}
            {!viewsLoading && !viewsError && visibleViews.length === 0 && <p className="application-directory-state">{views.length === 0 ? 'No Views have been created yet.' : 'No Views match your search.'}</p>}
            {!viewsLoading && !viewsError && <div className="views-directory-grid">
                {visibleViews.map(view => <a key={`${view.projectId}/${view.id}`}
                    className="views-directory-card" href={standaloneViewUrl(view)} target="_blank" rel="noopener noreferrer"
                    aria-label={`Open ${view.name} from ${view.projectName} in new tab`}
                    onClick={() => rememberWork({ href: editViewHash(view), name: view.name, projectId: view.projectId, kind: 'View', viewSlug: view.slug })}>
                    <span className="views-directory-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 14h4m-4 3h8" /></svg></span>
                    <span className="views-directory-body"><span className="views-directory-card-name">{view.name}</span>
                        <span className="views-directory-card-project">{view.projectName}</span>
                        {view.description && <span className="views-directory-card-copy">{view.description}</span>}</span>
                    <span className="views-directory-arrow" aria-hidden="true">↗</span>
                </a>)}
            </div>}
        </section>
    </section>;
}
