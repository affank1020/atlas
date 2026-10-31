import { useEffect, useState } from 'react';
import { callTool } from './api';
import { ActivityRows } from './ActivityFeed';
import { monitoringHash, type MonitoringFilters } from './monitoringLinks';
import type { AuditEvent } from './types';
import './activity.css';
import { SkeletonRows } from './Skeleton';

type ActivityPage = { items: AuditEvent[]; total: number; offset: number; limit: number };
type ActivityScope = Pick<MonitoringFilters, 'projectId' | 'nodeId' | 'logicalWorkspaceId' | 'checkoutId' | 'storeId'>;
type Props = ActivityScope & { title?: string; refreshVersion?: number };
const PREVIEW_LIMIT = 5;

/** A bounded, manual-refresh entry point into the full Monitoring Activity reader. */
export function ActivityPreview(props: Props) {
    // A different scope must never show an old scope's cached rows, even for
    // a moment while the replacement request is pending.
    const key = JSON.stringify([props.projectId, props.nodeId, props.logicalWorkspaceId,
        props.checkoutId, props.storeId]);
    return <ScopedActivityPreview key={key} {...props} />;
}

function ScopedActivityPreview({
    projectId, nodeId, logicalWorkspaceId, checkoutId, storeId,
    title = 'Recent activity', refreshVersion = 0,
}: Props) {
    const [page, setPage] = useState<ActivityPage>();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [refresh, setRefresh] = useState(0);
    const [updated, setUpdated] = useState('');

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError('');
        // The preview always queries a bounded, server-filtered operation page.
        // Only the dedicated Monitoring reader exposes full filtering/pagination.
        void callTool<ActivityPage>('query_monitoring_activity', {
            ...(projectId && { projectId }),
            ...(nodeId && { nodeId }),
            ...(logicalWorkspaceId && { logicalWorkspaceId }),
            ...(checkoutId && { checkoutId }),
            ...(storeId && { storeId }),
            offset: 0, limit: PREVIEW_LIMIT, groupOperations: true, safeDetails: true,
        }, controller.signal)
            .then(result => {
                if (controller.signal.aborted) return;
                setPage(result);
                setUpdated(new Date().toLocaleTimeString());
            })
            .catch(cause => {
                if (!controller.signal.aborted) setError((cause as Error).message);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [projectId, nodeId, logicalWorkspaceId, checkoutId, storeId, refreshVersion, refresh]);

    const fullActivity = monitoringHash('activity', {
        ...(projectId && { projectId }), ...(nodeId && { nodeId }),
        ...(logicalWorkspaceId && { logicalWorkspaceId }),
        ...(checkoutId && { checkoutId }), ...(storeId && { storeId }),
    });
    return <section className="panel activity-preview" aria-label={title}>
        <div className="panel-head">
            <div><p className="eyebrow">Atlas Monitoring · Latest operations</p><h2>{title}</h2></div>
            <div className="actions">
                <button type="button" className="ghost" disabled={loading}
                    onClick={() => setRefresh(value => value + 1)}>Refresh activity</button>
                <a href={fullActivity}>View all activity →</a>
            </div>
        </div>
        {loading && !page && !error && <SkeletonRows count={5} variant="activity" label="Loading recent activity" />}
        {loading && page && <p className="activity-preview-note" role="status">Refreshing recent activity…</p>}
        {error && <p className="activity-preview-note activity-error" role="alert">Recent activity unavailable: {error}</p>}
        {page && <div className="activity-preview-rows">
            <ActivityRows events={page.items} />
            {page.items.length === 0 && <p className="activity-preview-note">No recent activity in this scope.</p>}
        </div>}
        {page && <p className="activity-footnote">
            {page.total} {page.total === 1 ? 'operation' : 'operations'} in this scope ·
            Showing up to {PREVIEW_LIMIT} latest · Manual refresh only
            {updated && ` · Updated ${updated}`}
        </p>}
    </section>;
}
