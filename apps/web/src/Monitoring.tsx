import { useEffect, useState } from 'react';
import { callTool } from './api';
import type { AuditEvent } from './types';
import { ActivityRows } from './ActivityFeed';
import { MonitoringOverview } from './Workspace';
import { monitoringHash, parseMonitoringHash, type MonitoringFilters, type MonitoringRoute, type MonitoringTab } from './monitoringLinks';
import './activity.css';

type ActivityPage = { items: AuditEvent[]; total: number; offset: number; limit: number };
const LIMIT = 30;
const CATEGORIES = ['','core','view','node','workspace','files','git','dev','unity'];
function ActivityPanel({ filters }: { filters: MonitoringFilters }) {
    const [page, setPage] = useState<ActivityPage>();
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [refresh, setRefresh] = useState(0);
    const [search, setSearch] = useState(filters.search ?? '');
    const [draft, setDraft] = useState<MonitoringFilters>(filters);
    useEffect(() => setSearch(filters.search ?? ''), [filters.search]);
    useEffect(() => setDraft(filters), [JSON.stringify(filters)]);
    const offset = Math.max(0, Math.min(10000, Number(filters.offset) || 0));
    const setFilter = (key: keyof MonitoringFilters, value: string) => {
        const next = { ...filters, [key]: value || undefined, offset: undefined };
        location.hash = monitoringHash('activity', next);
    };
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true); setError(''); setPage(undefined);
        const input = Object.fromEntries(Object.entries(filters).filter(([key, value]) => key !== 'offset' && value));
        void callTool<ActivityPage>('query_monitoring_activity', { ...input, offset, limit: LIMIT }, controller.signal)
            .then(value => { if (!controller.signal.aborted) setPage(value); })
            .catch(e => { if (!controller.signal.aborted) setError((e as Error).message); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [JSON.stringify(filters), offset, refresh]);
    const changePage = (next: number) => { location.hash = monitoringHash('activity', { ...filters, offset: String(next) }); };
    return <section className="panel activity-panel" aria-label="Monitoring activity">
        <div className="panel-head"><div><p className="eyebrow">Immutable Atlas audit history</p><h2>Activity</h2></div><div className="actions"><button className="ghost" disabled={loading} onClick={() => setRefresh(x => x + 1)}>Refresh</button></div></div>
        <div className="activity-filters monitoring-filters">
            {([
                ['projectId', 'Project ID'], ['workspaceId', 'Workspace ID'], ['checkoutId', 'Checkout ID'],
                ['nodeId', 'Node ID'], ['storeId', 'Store ID'], ['client', 'Client'], ['operation', 'Operation'],
            ] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={label} value={draft[key] ?? ''} onChange={e => setDraft(previous => ({ ...previous, [key]: e.target.value }))} placeholder="All" /></label>)}
            <button type="button" className="ghost" onClick={() => { location.hash = monitoringHash('activity', { ...draft, offset: undefined }); }}>Apply filters</button>
            <label>Category<select aria-label="Category" value={filters.category ?? ''} onChange={e => setFilter('category', e.target.value)}>{CATEGORIES.map(x => <option key={x} value={x}>{x || 'All categories'}</option>)}</select></label>
            <label>Outcome<select aria-label="Outcome" value={filters.outcome ?? ''} onChange={e => setFilter('outcome', e.target.value)}>{['','failed','pending','completed'].map(x => <option key={x} value={x}>{x || 'All outcomes'}</option>)}</select></label>
            <label>From<input aria-label="From" type="datetime-local" value={filters.from ? filters.from.slice(0, 16) : ''} onChange={e => setFilter('from', e.target.value ? new Date(e.target.value).toISOString() : '')} /></label>
            <label>To<input aria-label="To" type="datetime-local" value={filters.to ? filters.to.slice(0, 16) : ''} onChange={e => setFilter('to', e.target.value ? new Date(e.target.value).toISOString() : '')} /></label>
            <form className="monitoring-search" onSubmit={e => { e.preventDefault(); setFilter('search', search.trim()); }}><label>Search<input aria-label="Search activity" value={search} onChange={e => setSearch(e.target.value)} maxLength={200} /></label><button type="submit">Apply</button></form>
        </div>
        {loading && <p role="status" className="empty">Loading audit history…</p>}
        {error && <p role="alert" className="activity-error">Audit history unavailable: {error}</p>}
        {page && <><div className="activity-scroll"><ActivityRows events={page.items} />{page.items.length === 0 && <p className="empty">No events match these filters.</p>}</div>
            <div className="monitoring-pagination"><span>{page.total ? `${page.offset + 1}–${page.offset + page.items.length} of ${page.total}` : '0 events'} · Filtered on the server</span><div className="actions"><button className="ghost" disabled={page.offset === 0} onClick={() => changePage(Math.max(0, page.offset - page.limit))}>Previous</button><button className="ghost" disabled={page.offset + page.items.length >= page.total || page.offset >= 10000} onClick={() => changePage(page.offset + page.limit)}>Next</button></div></div></>}
        <p className="activity-footnote">Recorded events only. A pending request is not proof of a failed operation; audit retention and runtime logs are separate.</p>
    </section>;
}
type NodeLog = { source: string; available: boolean; lines: string[]; truncated: boolean };
type LogNode = { id: string; name: string; status: string; capabilities: string[] };
function LogsPanel({ filters }: { filters: MonitoringFilters }) {
    const [nodes, setNodes] = useState<LogNode[]>([]);
    const [error, setError] = useState('');
    const [result, setResult] = useState<NodeLog>();
    const [reading, setReading] = useState(false);
    const [source, setSource] = useState<'stdout' | 'stderr'>('stderr');
    useEffect(() => {
        const controller = new AbortController();
        void callTool<LogNode[]>('list_nodes', {}, controller.signal).then(setNodes).catch(e => setError((e as Error).message));
        return () => controller.abort();
    }, []);
    const selected = nodes.find(node => node.id === filters.nodeId);
    const read = async () => {
        if (!selected) return;
        setResult(undefined); setError(''); setReading(true);
        try { setResult(await callTool<NodeLog>('read_node_logs', { nodeId: selected.id, source, lines: 200 })); }
        catch (e) { setError((e as Error).message); } finally { setReading(false); }
    };
    return <section className="panel activity-panel" aria-label="Monitoring logs">
        <div className="panel-head"><div><p className="eyebrow">Bounded runtime tails</p><h2>Logs</h2></div><button className="ghost" disabled={!selected || reading || selected.status !== 'online'} onClick={() => void read()}>{reading ? 'Reading…' : 'Refresh logs'}</button></div>
        <div className="activity-filters"><label>Node source<select aria-label="Node source" value={filters.nodeId ?? ''} onChange={e => { setResult(undefined); location.hash = monitoringHash('logs', { nodeId: e.target.value }); }}><option value="">Select a Node</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.name} · {node.status}</option>)}</select></label><label>Stream<select aria-label="Log stream" value={source} onChange={e => { setSource(e.target.value as 'stdout' | 'stderr'); setResult(undefined); }}><option value="stderr">stderr</option><option value="stdout">stdout</option></select></label></div>
        {!selected && !error && <p className="empty">Select a Node to inspect its available logs. Server and Linux journal adapters are not yet connected.</p>}
        {selected?.status !== 'online' && selected && <p role="status" className="empty">Node is {selected.status}; live log reads are unavailable.</p>}
        {selected?.status === 'online' && !selected.capabilities.includes('node.logs') && <p className="empty">This Node does not expose approved log access.</p>}
        {error && <p role="alert" className="activity-error">{error}</p>}
        {result && <div className="monitoring-log-result">{!result.available ? <p>Log source unavailable.</p> : <><p>{result.truncated ? 'Bounded tail: earlier lines are not retained here.' : 'Latest available lines.'}</p><div className="actions"><button className="ghost" onClick={() => void navigator.clipboard.writeText(result.lines.join('\n'))}>Copy visible lines</button></div><pre>{result.lines.join('\n') || '(empty)'}</pre></>}</div>}
    </section>;
}
export function MonitoringPage() {
    const [route, setRoute] = useState<MonitoringRoute>(() => parseMonitoringHash(location.hash));
    useEffect(() => { const update = () => setRoute(parseMonitoringHash(location.hash)); addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []);
    const tabs: { key: MonitoringTab; title: string }[] = [{key:'overview',title:'Overview'},{key:'activity',title:'Activity'},{key:'logs',title:'Logs'}];
    return <div className="monitoring-page">
        <nav className="tabs project-nav" aria-label="Monitoring sections">{tabs.map(tab => <a key={tab.key} href={monitoringHash(tab.key, tab.key === route.tab ? route.filters : {})} aria-current={route.tab === tab.key ? 'page' : undefined} className={route.tab === tab.key ? 'active' : ''}>{tab.title}</a>)}</nav>
        {route.tab === 'overview' && <MonitoringOverview />}
        {route.tab === 'activity' && <><header className="page-head"><div><p className="eyebrow">Atlas Monitoring</p><h1>Activity</h1><p>Search and investigate structured operations across Atlas.</p></div></header><ActivityPanel filters={route.filters} /></>}
        {route.tab === 'logs' && <><header className="page-head"><div><p className="eyebrow">Atlas Monitoring</p><h1>Logs</h1><p>Read bounded technical output from approved Node sources.</p></div></header><LogsPanel filters={route.filters} /></>}
    </div>;
}
