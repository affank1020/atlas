import { useState } from 'react';
import { useApplicationRead, useListProjectsQuery, useListStoresQuery, useStorageUsageQuery, useWorkspaceStatusQuery } from './atlasApi';
import type { Project } from './types';
import './data-overview.css';
import { Skeleton, SkeletonRows } from './Skeletons';

type MediaAsset = { id: string; status: string; byteSize: number };

function formatBytes(value: number) {
    if (!Number.isFinite(value)) return '—';
    if (value < 1024) return value + ' B';
    const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
    return (value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
}

function StorageSymbol({ kind }: { kind: 'postgres' | 'objects' }) {
    return <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {kind === 'postgres'
            ? <><ellipse cx="12" cy="5.5" rx="8" ry="3.5" /><path d="M4 5.5v13c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5v-13M4 12c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5" /></>
            : <><path d="M7 18H6a4 4 0 0 1-.7-7.9A7 7 0 0 1 19 12a3 3 0 0 1-.5 6H17" /><path d="M12 11v9m0-9-3 3m3-3 3 3" /></>}
    </svg>;
}

function StorageMetric({ label, value }: { label: string; value: string | number }) {
    return <span className="data-storage-metric"><strong>{value}</strong><small>{label}</small></span>;
}

function UsageBar({ label, value, allowance }: { label: string; value: number | undefined; allowance: number }) {
    const ratio = value === undefined ? 0 : value / allowance;
    return <div className="data-usage-bar">
        <div className="data-usage-label"><span>{label}</span><span>{value === undefined ? '—' : (ratio * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%'}</span></div>
        <div className="data-usage-track" role="progressbar" aria-label={label} aria-valuenow={value === undefined ? undefined : Math.round(Math.min(100, Math.max(0, ratio * 100)))} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: Math.min(100, Math.max(0, ratio * 100)) + '%' }} />
        </div>
    </div>;
}

function StorageComposition({ databaseBytes, tableBytes, indexBytes }: { databaseBytes: number; tableBytes: number; indexBytes: number }) {
    const total = Math.max(databaseBytes, tableBytes + indexBytes);
    if (!Number.isFinite(total) || total <= 0 || ![tableBytes, indexBytes].every(value => Number.isFinite(value) && value >= 0)) return null;
    const parts = [
        { label: 'Table data', bytes: tableBytes, kind: 'tables' },
        { label: 'Indexes', bytes: indexBytes, kind: 'indexes' },
        { label: 'Other', bytes: Math.max(0, total - tableBytes - indexBytes), kind: 'other' },
    ];
    const percent = (bytes: number) => (bytes / total * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%';
    return <div className="data-storage-composition" aria-label="Database storage composition">
        <div className="data-composition-heading"><h3>Storage composition</h3><span>Of database size</span></div>
        <div className="data-composition-track" role="img" aria-label={parts.map(part => part.label + ': ' + percent(part.bytes)).join(', ')}>
            {parts.filter(part => part.bytes > 0).map(part =>
                <span key={part.kind} className={'data-composition-part data-composition-' + part.kind} style={{ width: part.bytes / total * 100 + '%' }} />
            )}
        </div>
        <div className="data-composition-legend">
            {parts.map(part => <div className="data-composition-item" key={part.kind}>
                <span className="data-composition-label"><i className={'data-composition-dot data-composition-' + part.kind} aria-hidden="true" />{part.label}</span>
                <strong>{percent(part.bytes)}</strong>
                <small>{formatBytes(part.bytes)}</small>
            </div>)}
        </div>
    </div>;
}

function ProjectStorageRow({ project }: { project: Project }) {
    const [expanded, setExpanded] = useState(false);
    const stores = useListStoresQuery({ projectId: project.id, includeArchived: false });
    const active = stores.currentData?.filter(store => !store.archivedAt);
    const id = 'data-stores-' + project.id;
    return <div className="data-project">
        <div className="data-project-summary">
            <button className="data-project-toggle" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
                <span className={'data-chevron' + (expanded ? ' expanded' : '')} aria-hidden="true" />
                <span className="data-project-title">{project.name}</span>
                <span className="data-project-count">{stores.error ? 'Unavailable' : active ? active.length + (active.length === 1 ? ' store' : ' stores') : <Skeleton width={58} height={12} />}</span>
            </button>
        </div>
        {expanded && <div id={id} className="data-project-stores">
            {stores.error ? <div className="data-subtle">Stores unavailable. <button type="button" className="data-text-button" onClick={() => void stores.refetch()}>Retry</button></div> : null}
            {!stores.error && stores.isLoading ? <SkeletonRows label="Loading collections" variant="list" rows={3} /> : null}
            {active?.map(store => <a className="data-store-link" key={store.id} href={'#/projects/' + project.id + '/stores/' + store.id + '/records'}>
                <span>{store.name}</span><span className="data-store-arrow" aria-hidden="true">↗</span>
            </a>)}
            {!stores.error && active?.length === 0 && <span className="data-subtle">No active stores in this project.</span>}
        </div>}
    </div>;
}

export function DataOverview() {
    const status = useWorkspaceStatusQuery();
    const [refreshToken, setRefreshToken] = useState(0);
    const usage = useStorageUsageQuery({ refreshToken });
    const postgres = usage.data?.postgres;
    const cloudflare = usage.data?.r2;
    const projects = useListProjectsQuery({ includeArchived: false, withMetrics: true });
    const projectsWithStores = projects.data?.filter(project => (project.metrics?.stores ?? 0) > 0);
    const media = useApplicationRead<MediaAsset[]>('list_portfolio_media');
    const assets = media.data?.filter(asset => asset.status === 'active');
    const refreshing = status.isFetching || projects.isFetching || media.isFetching || usage.isFetching;
    const lastRefreshed = usage.isSuccess && usage.fulfilledTimeStamp
        ? new Date(usage.fulfilledTimeStamp).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : null;

    return <div className="data-overview">
        <header className="data-page-head">
            <div><h1>Data</h1></div>
            <div className="data-page-actions">
                {lastRefreshed && <span className="data-last-refreshed">Last refreshed {lastRefreshed}</span>}
                <button className="ghost" type="button" disabled={refreshing} onClick={() => {
                    void status.refetch(); void projects.refetch(); void media.refetch(); setRefreshToken(value => value + 1);
                }}>↻ Refresh</button>
            </div>
        </header>
        <div className="data-storage-grid" aria-label="Storage summary">
            <section className="data-storage-card" aria-labelledby="data-postgres-title">
                <div className="data-storage-card-heading"><span className="data-storage-symbol"><StorageSymbol kind="postgres" /></span><div><h2 id="data-postgres-title">PostgreSQL</h2></div></div>
                <div className="data-storage-metrics">
                    <StorageMetric label="Database size" value={postgres?.state === 'ready' && postgres.databaseBytes !== undefined ? formatBytes(postgres.databaseBytes) : '—'} />
                    <StorageMetric label="Table data" value={postgres?.state === 'ready' && postgres.tableBytes !== undefined ? formatBytes(postgres.tableBytes) : '—'} />
                    <StorageMetric label="Indexes" value={postgres?.state === 'ready' && postgres.indexBytes !== undefined ? formatBytes(postgres.indexBytes) : '—'} />
                    <StorageMetric label="Physical tables" value={postgres?.state === 'ready' ? postgres.tableCount ?? '—' : '—'} />
                    <StorageMetric label="Atlas stores" value={status.data?.stores?.toLocaleString() ?? '—'} />
                    <StorageMetric label="Records" value={status.data?.records?.toLocaleString() ?? '—'} />
                </div>
                {postgres?.state === 'ready' && postgres.databaseBytes !== undefined && postgres.tableBytes !== undefined && postgres.indexBytes !== undefined &&
                    <StorageComposition databaseBytes={postgres.databaseBytes} tableBytes={postgres.tableBytes} indexBytes={postgres.indexBytes} />}
                {(postgres?.state === 'unavailable' || usage.error) && <p className="data-usage-note">Database storage metrics unavailable.</p>}
            </section>
            <section className="data-storage-card" aria-labelledby="data-objects-title">
                <div className="data-storage-card-heading"><span className="data-storage-symbol"><StorageSymbol kind="objects" /></span><div><h2 id="data-objects-title">Cloudflare R2</h2></div></div>
                <div className="data-storage-metrics">
                    <StorageMetric label="Bucket storage" value={cloudflare?.state === 'ready' && cloudflare.storageBytes !== undefined ? formatBytes(cloudflare.storageBytes) : '—'} />
                    <StorageMetric label="Objects" value={cloudflare?.state === 'ready' ? cloudflare.objectCount?.toLocaleString() ?? '—' : '—'} />
                    <StorageMetric label="Class A · this month" value={cloudflare?.state === 'ready' ? cloudflare.classA?.toLocaleString() ?? '—' : '—'} />
                    <StorageMetric label="Class B · this month" value={cloudflare?.state === 'ready' ? cloudflare.classB?.toLocaleString() ?? '—' : '—'} />
                </div>
                {cloudflare?.state === 'ready' && <div className="data-usage-bars">
                    <UsageBar label="Storage / 10 GB free-tier reference" value={cloudflare.storageBytes} allowance={cloudflare.storageAllowanceBytes} />
                    <UsageBar label="Class A / monthly allowance" value={cloudflare.classA} allowance={cloudflare.classAAllowance} />
                    <UsageBar label="Class B / monthly allowance" value={cloudflare.classB} allowance={cloudflare.classBAllowance} />
                    {Boolean(cloudflare.otherOperations) && <p className="data-usage-note">{cloudflare.otherOperations?.toLocaleString()} unclassified operations excluded from A/B totals.</p>}
                </div>}
                {cloudflare?.state === 'not_configured' && <p className="data-usage-note">Connect Cloudflare Analytics to see bucket usage and monthly operation limits.</p>}
                {(cloudflare?.state === 'unavailable' || usage.error) && <p className="data-usage-note">Cloudflare Analytics unavailable. Check the token and account permissions.</p>}
            </section>
        </div>

        <section className="data-section" aria-labelledby="data-projects-title">
            <div className="data-section-head"><div><h2 id="data-projects-title">Project data</h2><p>Collections managed by Atlas, grouped by project.</p></div><span>{projectsWithStores ? `${projectsWithStores.length} ${projectsWithStores.length === 1 ? 'project' : 'projects'}` : '— projects'}</span></div>
            <div className="data-project-list">
                {projectsWithStores?.map(project => <ProjectStorageRow key={project.id} project={project} />)}
                {!projects.isLoading && !projects.error && projectsWithStores?.length === 0 && <p className="data-empty">No project data yet.</p>}
                {projects.error && <p className="data-empty">Projects unavailable. <button type="button" className="data-text-button" onClick={() => void projects.refetch()}>Retry</button></p>}
                {projects.isLoading && !projects.data && !projects.error && <SkeletonRows label="Loading project data" variant="list" rows={4} />}
            </div>
        </section>

        <section className="data-section" aria-labelledby="data-system-title">
            <div className="data-section-head"><div><h2 id="data-system-title">System data</h2><p>Database structures used internally by Atlas.</p></div></div>
            {postgres?.state === 'ready' ? <div className="data-table-wrap">
                <table className="data-storage-table">
                    <thead><tr><th scope="col">Table</th><th scope="col">Data</th><th scope="col">Indexes</th><th scope="col">Total</th></tr></thead>
                    <tbody>{postgres.tables?.map(table => <tr key={table.schema + '.' + table.name}>
                        <td>{table.schema + '.' + table.name}</td><td>{formatBytes(table.tableBytes)}</td>
                        <td>{formatBytes(table.indexBytes)}</td><td>{formatBytes(table.totalBytes)}</td>
                    </tr>)}</tbody>
                </table>
                {postgres.tables?.length === 0 && <p className="data-empty">No application tables found.</p>}
                <p className="data-usage-note">Largest {postgres.tables?.length ?? 0} tables by total size. Database size includes additional PostgreSQL storage.</p>
            </div> : <div className="data-information-row">
                <div><strong>PostgreSQL table usage</strong>{postgres?.state === 'unavailable' || usage.error ? <p>Unable to read database statistics.</p> : <SkeletonRows label="Loading database statistics" variant="table" rows={3} />}</div>
            </div>}
        </section>

        <section className="data-section" aria-labelledby="data-files-title">
            <div className="data-section-head"><div><h2 id="data-files-title">Object storage</h2><p>Files and media stored through Atlas.</p></div></div>
            <a className="data-file-row" href="#/portfolio?tab=media">
                <span className="data-file-icon" aria-hidden="true"><StorageSymbol kind="objects" /></span>
                <span className="data-file-copy"><strong>Portfolio media</strong><small>Images, PDFs and generated variants</small></span>
                <span className="data-file-side">{media.error ? 'Unavailable' : assets ? assets.length + (assets.length === 1 ? ' asset' : ' assets') : <Skeleton width={55} height={12} />}</span>
                <span className="data-store-arrow" aria-hidden="true">↗</span>
            </a>
        </section>
    </div>;
}
