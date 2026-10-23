import { monitoringHash } from './monitoringLinks';
import './StoreActivityLink.css';

/** Read-only navigation to server-filtered Activity, not the full Store revision API. */
export function StoreActivityLink({ projectId, storeId, label = 'Store activity in Monitoring' }: {
    projectId: string; storeId: string; label?: string;
}) {
    return <a className="ghost store-activity-link" href={monitoringHash('activity', { projectId, storeId })}>
        {label} →
    </a>;
}
