import { useEffect, useState } from 'react';
import { callTool } from './api';
import { clientName, presentActivity } from './activity';
import type { AuditEvent } from './types';
import { monitoringHash, type MonitoringFilters } from './monitoringLinks';
import './activity.css';

type ActivityPage = { items: AuditEvent[]; total: number; limit: number; offset: number };

/** Reusable, bounded previews. Every detail view belongs to Monitoring. */
export function RecentActivityPreview({
    title = 'Recent activity', filters, refreshVersion = 0, count = 5, compact = false,
}: { title?: string; filters: MonitoringFilters; refreshVersion?: number; count?: number; compact?: boolean }) {
    const [page, setPage] = useState<ActivityPage>();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    // A single read on mount/scope refresh; do not multiply the old 5s polling across cards.
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true); setError(''); setPage(undefined);
        void callTool<ActivityPage>('query_monitoring_activity', { ...filters, limit: Math.min(Math.max(count, 1), 10), offset: 0 }, controller.signal)
            .then(result => { if (!controller.signal.aborted) setPage(result); })
            .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [JSON.stringify(filters), refreshVersion, count]);
    const events = presentActivity(page?.items ?? []).slice(0, count);
    return <section className={compact ? 'monitoring-preview monitoring-preview-compact' : 'panel monitoring-preview'} aria-label={title}>
        <header className="monitoring-preview-head"><h3>{title}</h3><a href={monitoringHash('activity', filters)}>View all <span aria-hidden="true">↗</span></a></header>
        {loading && <p className="monitoring-preview-empty" role="status">Loading activity…</p>}
        {error && <p className="monitoring-preview-empty" role="alert">Activity unavailable: {error}</p>}
        {page && events.length === 0 && <p className="monitoring-preview-empty">No recorded activity for this scope.</p>}
        {!!events.length && <ol className="monitoring-preview-list">{events.map(item => <li key={item.id} className={item.status === 'failed' ? 'monitoring-preview-failed' : ''}>
            <span className="monitoring-preview-copy"><strong>{item.title}</strong><small>{clientName(item.client)} · {item.status}</small></span>
            <time dateTime={item.timestamp} title={item.timestamp}>{new Date(item.timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</time>
        </li>)}</ol>}
    </section>;
}
