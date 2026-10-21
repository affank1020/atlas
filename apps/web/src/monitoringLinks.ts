/** Hash URLs are part of Atlas' shareable operational state. */
export type MonitoringTab = 'overview' | 'activity' | 'logs';
export type MonitoringFilters = {
    projectId?: string; workspaceId?: string; checkoutId?: string; storeId?: string; nodeId?: string;
    operation?: string; category?: string; client?: string; outcome?: string; search?: string;
    from?: string; to?: string; offset?: string; source?: 'stdout' | 'stderr' | 'journal'; lines?: string;
};
export type MonitoringRoute = { tab: MonitoringTab; filters: MonitoringFilters };
const keys: (keyof MonitoringFilters)[] = ['projectId','workspaceId','checkoutId','storeId','nodeId','operation','category','client','outcome','search','from','to','offset','source','lines'];
export function monitoringHash(tab: MonitoringTab, filters: MonitoringFilters = {}) {
    const params = new URLSearchParams({ tab });
    for (const key of keys) if (filters[key]) params.set(key, filters[key]!);
    return '#/monitoring?' + params.toString();
}
export function parseMonitoringHash(hash: string): MonitoringRoute {
    const [path, query = ''] = hash.replace(/^#/, '').split('?', 2);
    const params = new URLSearchParams(query);
    const tab: MonitoringTab = path === '/activity' ? 'activity'
        : params.get('tab') === 'activity' ? 'activity'
        : params.get('tab') === 'logs' ? 'logs' : 'overview';
    const filters: MonitoringFilters = {};
    for (const key of keys) {
        const value = params.get(key);
        if (!value) continue;
        if (key === 'source') { if (value === 'stdout' || value === 'stderr' || value === 'journal') filters.source = value; continue; }
        if (key === 'lines') { if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 200) filters.lines = String(Number(value)); continue; }
        filters[key] = value;
    }
    return { tab, filters };
}
