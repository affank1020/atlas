import { useState } from 'react';
import { useApplicationRead } from './atlasApi';
import { rememberWork } from './recentWork';
import { CatalogueHeading, CatalogueToolbar, filterCatalogue } from './CatalogueBrowse';
import type { ApplicationManifest } from './Applications';
import { SkeletonRows } from './Skeletons';
import './applications-directory.css';

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
    const { data: applications = [], error, isLoading, isFetching, refetch } = useApplicationRead<ApplicationManifest[]>('list_all_applications');
    const visible = filterCatalogue(applications, search, app => `${app.name} ${app.description}`)
        .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));

    return <section className="applications-directory catalogue-page" aria-label="Applications">
        <CatalogueHeading title="Applications" actions={
            <button type="button" className="ghost" onClick={() => void refetch()} disabled={isFetching}
                aria-label="Refresh applications">↻ Refresh</button>
        } />
        <CatalogueToolbar label="Search applications" placeholder="Find an application…" query={search}
            onQueryChange={setSearch} count={isLoading || error ? null : visible.length} itemName="application" />
        {isLoading && !error && <SkeletonRows label="Loading applications" variant="applications" rows={6} />}
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
    </section>;
}
