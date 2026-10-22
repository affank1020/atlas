import { useEffect, useRef, useState } from 'react';
import { callTool, IS_MOCK_MODE } from './api';
import type { AuditEvent } from './types';
import { ActivityRows } from './ActivityFeed';
import { MonitoringOverview } from './Workspace';
import { monitoringHash, parseMonitoringHash, type MonitoringFilters, type MonitoringRoute, type MonitoringTab } from './monitoringLinks';
import './activity.css';

type ActivityPage = { items: AuditEvent[]; total: number; offset: number; limit: number };
const LIMIT = 30;
export function localDateTimeValue(instant?: string) {
    if (!instant) return '';
    const date = new Date(instant);
    if (Number.isNaN(date.getTime())) return '';
    const two = (value: number) => String(value).padStart(2, '0');
    return [date.getFullYear(), two(date.getMonth() + 1), two(date.getDate())].join('-') + 'T' + [two(date.getHours()), two(date.getMinutes())].join(':');
}
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
        void callTool<ActivityPage>('query_monitoring_activity', { ...input, offset, limit: LIMIT, groupOperations: true }, controller.signal)
            .then(value => { if (!controller.signal.aborted) setPage(value); })
            .catch(e => { if (!controller.signal.aborted) setError((e as Error).message); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [JSON.stringify(filters), offset, refresh]);
    const operationCount = page ? new Set(page.items.map(event => {
        const details = event.resulting && typeof event.resulting === 'object' ? event.resulting as Record<string, unknown> : {};
        const attempt = typeof details.attemptId === 'string' ? details.attemptId : '';
        return event.operation.startsWith('workspace.') && attempt
            ? `attempt:${event.projectId ?? ''}:${event.workspaceId ?? ''}:${attempt}` : event.id;
    })).size : 0;
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
            <label>From<input aria-label="From" type="datetime-local" value={localDateTimeValue(filters.from)} onChange={e => setFilter('from', e.target.value ? new Date(e.target.value).toISOString() : '')} /></label>
            <label>To<input aria-label="To" type="datetime-local" value={localDateTimeValue(filters.to)} onChange={e => setFilter('to', e.target.value ? new Date(e.target.value).toISOString() : '')} /></label>
            <form className="monitoring-search" onSubmit={e => { e.preventDefault(); setFilter('search', search.trim()); }}><label>Search<input aria-label="Search activity" value={search} onChange={e => setSearch(e.target.value)} maxLength={200} /></label><button type="submit">Apply</button></form>
        </div>
        {loading && <p role="status" className="empty">Loading audit history…</p>}
        {error && <p role="alert" className="activity-error">Audit history unavailable: {error}</p>}
        {page && <><div className="activity-scroll"><ActivityRows events={page.items} />{page.items.length === 0 && <p className="empty">No events match these filters.</p>}</div>
            <div className="monitoring-pagination"><span>{page.total && operationCount ? `${page.offset + 1}–${page.offset + operationCount} of ${page.total} operations` : page.total ? `No operations on this page · ${page.total} total` : '0 operations'} · Filtered on the server</span><div className="actions"><button className="ghost" disabled={page.offset === 0} onClick={() => changePage(Math.max(0, page.offset - page.limit))}>Previous</button><button className="ghost" disabled={page.offset + operationCount >= page.total || page.offset >= 10000} onClick={() => changePage(page.offset + page.limit)}>Next</button></div></div></>}
        <p className="activity-footnote">Recorded events only. A pending request is not proof of a failed operation; audit retention and runtime logs are separate.</p>
    </section>;
}
type NodeLog = { source: string; available: boolean; lines: string[]; truncated: boolean };
type LogNode = { id: string; name: string; platform?: string; status: string; capabilities: string[] };
type ScopedLog = { nodeId: string; source: 'stdout' | 'stderr' | 'journal'; count: number; output: NodeLog };
function NodeLogsPanel({ filters }: { filters: MonitoringFilters }) {
    const [nodes, setNodes] = useState<LogNode[]>([]);
    const [error, setError] = useState('');
    const [result, setResult] = useState<ScopedLog>();
    const [reading, setReading] = useState(false);
    const [tailSearch, setTailSearch] = useState('');
    const active = useRef<AbortController | null>(null);
    const generation = useRef(0);
    const lines = filters.lines && /^\d+$/.test(filters.lines) && Number(filters.lines) >= 1 && Number(filters.lines) <= 200
        ? Number(filters.lines) : 200;
    const nodeId = filters.nodeId ?? '';
    const selected = nodes.find(node => node.id === nodeId);
    const source: 'stdout' | 'stderr' | 'journal' = selected?.platform === 'linux' ? 'journal'
        : filters.source === 'stdout' ? 'stdout' : 'stderr';
    const cancel = () => {
        generation.current++;
        active.current?.abort();
        active.current = null;
        setReading(false);
        setResult(undefined);
        setError('');
    };
    // Invalidate an outstanding request on scope changes or unmount, including
    // selections changed by a bookmarked URL rather than by the local controls.
    useEffect(() => () => {
        generation.current++;
        active.current?.abort();
        active.current = null;
    }, [nodeId, source, lines]);
    useEffect(() => {
        const controller = new AbortController();
        void callTool<LogNode[]>('list_nodes', {}, controller.signal)
            .then(value => { if (!controller.signal.aborted) setNodes(value); })
            .catch(e => { if (!controller.signal.aborted) setError((e as Error).message); });
        return () => controller.abort();
    }, []);
    const setSelection = (next: MonitoringFilters) => {
        cancel();
        location.hash = monitoringHash('logs', next);
    };
    const read = async () => {
        if (!selected || selected.status !== 'online' || !selected.capabilities.includes('node.logs')) return;
        cancel();
        const controller = new AbortController();
        active.current = controller;
        const id = ++generation.current;
        const scope = { nodeId: selected.id, source, lines };
        setReading(true);
        try {
            const output = await callTool<NodeLog>('read_node_logs', scope, controller.signal);
            if (!controller.signal.aborted && id === generation.current) setResult({ nodeId: scope.nodeId, source, count: lines, output });
        } catch (cause) {
            if (!controller.signal.aborted && id === generation.current)
                setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            if (id === generation.current) { setReading(false); active.current = null; }
        }
    };
    // Also guard the render itself: async completion can never label A's data as B's.
    const visible = result?.nodeId === nodeId && result.source === source && result.count === lines ? result.output : undefined;
    const visibleLines = visible?.lines.filter(line => line.toLowerCase().includes(tailSearch.trim().toLowerCase())) ?? [];
    return <section className="panel activity-panel" aria-label="Monitoring logs">
        <div className="panel-head"><div><p className="eyebrow">Bounded runtime tails</p><h2>Logs</h2></div><button className="ghost" disabled={!selected || reading || selected.status !== 'online' || !selected.capabilities.includes('node.logs')} onClick={() => void read()}>{reading ? 'Reading…' : 'Refresh logs'}</button></div>
        <div className="activity-filters">
            <label>Node source<select aria-label="Node source" value={nodeId} onChange={e => { const next = nodes.find(node => node.id === e.target.value); setSelection({ ...filters, nodeId: next?.id, source: next?.platform === 'linux' ? 'journal' : filters.source === 'journal' ? undefined : filters.source }); }}><option value="">Select a Node</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.name} · {node.status}</option>)}</select></label>
            <label>Stream{selected?.platform === 'linux'
                ? <select aria-label="Log stream" value="journal" disabled><option value="journal">systemd · atlas-node.service</option></select>
                : <select aria-label="Log stream" value={source} onChange={e => setSelection({ ...filters, source: e.target.value as 'stdout' | 'stderr' })}><option value="stderr">stderr</option><option value="stdout">stdout</option></select>}</label>
            <label>Lines<input type="number" aria-label="Log lines" min={1} max={200} value={lines} onChange={e => { const next = Number(e.target.value); if (Number.isInteger(next) && next >= 1 && next <= 200) setSelection({ ...filters, lines: String(next) }); }} /></label>
        </div>
        <div className="activity-filters"><label>Search loaded lines<input aria-label="Search loaded log lines" value={tailSearch} onChange={e => setTailSearch(e.target.value)} placeholder="Filter the bounded tail" /></label></div>
        {!selected && !error && <p className="empty">Select a Node to inspect its approved log tail, or choose Atlas Server diagnostics above.</p>}
        {selected?.status !== 'online' && selected && <p role="status" className="empty">Node is {selected.status}; live log reads are unavailable.</p>}
        {selected?.status === 'online' && !selected.capabilities.includes('node.logs') && <p className="empty">This Node does not expose approved log access.</p>}
        {error && <p role="alert" className="activity-error">{error}</p>}
        {visible && <div className="monitoring-log-result">{!visible.available ? <p>Log source unavailable{source === 'journal' ? ' (journal access may be restricted for this service account)' : ''}.</p> : <><p>{visible.truncated ? 'Bounded tail: earlier lines are not retained here.' : 'Latest available lines.'}</p><div className="actions"><button className="ghost" onClick={() => void navigator.clipboard.writeText(visibleLines.join('\n'))}>Copy visible lines</button></div><pre>{visibleLines.join('\n') || (tailSearch.trim() ? '(no matching lines in loaded tail)' : '(empty)')}</pre></>}</div>}
    </section>;
}

type ServerDiagnosticEvent = { at: string; code: string; level: 'info' | 'warning'; message: string };
type ServerDiagnosticResponse = {
    source: 'atlas-server-process'; available: boolean; startedAt: string; retention: 'current-process';
    events: ServerDiagnosticEvent[]; truncated: boolean;
};
function ServerDiagnosticsPanel({ filters }: { filters: MonitoringFilters }) {
    const parsed = Number(filters.lines);
    const limit = Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 30;
    const [result, setResult] = useState<ServerDiagnosticResponse>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState('');
    const [refresh, setRefresh] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setResult(undefined); setError(''); setBusy(true);
        void callTool<ServerDiagnosticResponse>('read_server_diagnostics', { limit }, controller.signal)
            .then(value => { if (!controller.signal.aborted) setResult(value); })
            .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
            .finally(() => { if (!controller.signal.aborted) setBusy(false); });
        return () => controller.abort();
    }, [limit, refresh]);
    const events = result?.events.filter(event => (event.code + ' ' + event.message).toLowerCase().includes(search.toLowerCase())) ?? [];
    const output = events.map(event => event.at + ' [' + event.level + '] ' + event.message).join('\n');
    return <section className="panel activity-panel" aria-label="Server diagnostics">
        <div className="panel-head"><div><p className="eyebrow">Current server process · fixed event codes</p><h2>Atlas Server diagnostics</h2></div>
            <button type="button" className="ghost" disabled={busy} onClick={() => setRefresh(x => x + 1)}>{busy ? 'Reading…' : 'Refresh diagnostics'}</button></div>
        <div className="activity-filters">
            <label>Events<input type="number" aria-label="Diagnostic events" min={1} max={100} value={limit}
                onChange={e => { const next = Number(e.target.value); if (Number.isInteger(next) && next >= 1 && next <= 100)
                    location.hash = monitoringHash('logs', { target: 'server', lines: String(next) }); }} /></label>
            <label>Search loaded events<input aria-label="Search diagnostics" value={search} onChange={e => setSearch(e.target.value)} /></label>
        </div>
        <p className="activity-footnote">Only non-sensitive operational event codes from this Atlas Server process are shown. This is not Docker stdout/stderr, historical logs or a multi-instance archive.</p>
        {busy && <p role="status" className="empty">Loading server diagnostics…</p>}
        {error && <p role="alert" className="activity-error">Server diagnostics unavailable: {error}</p>}
        {result && !result.available && <p className="empty">Server diagnostics are disabled on this deployment.</p>}
        {result?.available && <div className="monitoring-log-result">
            <p>Since {new Date(result.startedAt).toLocaleString()}{result.truncated ? ' · Earlier events have been discarded or excluded by the limit' : ''}</p>
            <div className="actions"><button className="ghost" onClick={() => void navigator.clipboard.writeText(output)}>Copy visible diagnostics</button></div>
            <pre>{output || (search ? '(no matching events in loaded diagnostics)' : '(no diagnostic events)')}</pre>
        </div>}
    </section>;
}
function LogsPanel({ filters }: { filters: MonitoringFilters }) {
    const target = filters.target === 'server' ? 'server' : 'node';
    return <>
        <div className="activity-filters"><label>Log target<select aria-label="Log target" value={target}
            onChange={e => location.hash = monitoringHash('logs',
                e.target.value === 'server' ? { target: 'server' } : { target: 'node' })}>
            <option value="node">Connected Node</option><option value="server">Atlas Server diagnostics</option>
        </select></label></div>
        {target === 'server' ? <ServerDiagnosticsPanel filters={filters} /> : <NodeLogsPanel filters={filters} />}
    </>;
}
type HealthNode = {
    id: string; name: string; platform: string; state: 'healthy' | 'stale' | 'offline' | 'unavailable' | 'revoked' | 'unknown';
    lastSeen: string | null; ageSeconds: number | null; version: string | null;
};
type HealthSnapshot = {
    checkedAt: string; overall: 'healthy' | 'degraded' | 'unknown';
    server: { status: 'healthy' | 'degraded'; uptimeSeconds: number; startedAt: string;
        database: { status: 'reachable' | 'unavailable'; latencyMs?: number } };
    nodes: { available: boolean; summary: { total: number; healthy: number; stale: number;
        offline: number; unavailable: number; revoked: number; unknown: number }; items: HealthNode[] };
};
function MonitoringHealthPanel() {
    const [snapshot, setSnapshot] = useState<HealthSnapshot>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [refresh, setRefresh] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setBusy(true);
        setError(undefined);
        void callTool<HealthSnapshot>('get_monitoring_health', {}, controller.signal)
            .then(value => { if (!controller.signal.aborted) setSnapshot(value); })
            .catch(reason => { if (!controller.signal.aborted) {
                setSnapshot(undefined); setError(reason instanceof Error ? reason.message : 'Health check unavailable.');
            } })
            .finally(() => { if (!controller.signal.aborted) setBusy(false); });
        return () => controller.abort();
    }, [refresh]);
    const badge = (status: string) => status === 'healthy' || status === 'reachable' ? 'success' : 'muted';
    return <section className="workspace-section" aria-label="Live operational health">
        <div className="section-heading"><h2>Live operational health</h2>
            <button className="ghost" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{busy ? 'Checking…' : 'Refresh health'}</button>
        </div>
        {busy && !snapshot && <p role="status">Checking Server and Node health…</p>}
        {error && <p role="alert">Health snapshot unavailable: {error}</p>}
        {snapshot && <>
            <p><span className={`badge ${badge(snapshot.overall)}`}>{snapshot.overall}</span> · Checked {new Date(snapshot.checkedAt).toLocaleString()} · {IS_MOCK_MODE ? 'Simulated preview — no live health probes' : 'On-demand snapshot, not continuous monitoring'}</p>
            <div className="workspace-row"><span className="row-copy"><strong>Atlas Server · database</strong>
                <small>{snapshot.server.database.status === 'reachable'
                    ? `Database query succeeded · ${snapshot.server.database.latencyMs ?? '—'} ms · Server uptime ${Math.floor(snapshot.server.uptimeSeconds / 60)} min`
                    : 'Database health query failed; Server process is responding'}</small></span>
                <span className={`badge ${badge(snapshot.server.status)}`}>{snapshot.server.database.status}</span>
            </div>
            {!snapshot.nodes.available && <p role="status">Node registry could not be checked. Node health is unknown.</p>}
            {snapshot.nodes.available && <>
                <p>{snapshot.nodes.summary.healthy} healthy · {snapshot.nodes.summary.total} registered Nodes
                    {snapshot.nodes.summary.stale + snapshot.nodes.summary.offline + snapshot.nodes.summary.unavailable + snapshot.nodes.summary.revoked > 0
                        ? ' · Some Nodes need attention' : ''}</p>
                {snapshot.nodes.items.map(node =>
                    <a key={node.id} className="workspace-row" href="#/nodes"><span className="row-copy">
                        <strong>{node.name}</strong><small>{node.platform || 'Unknown platform'} · {node.lastSeen
                            ? `Last heartbeat ${new Date(node.lastSeen).toLocaleString()} · ${node.ageSeconds ?? '—'} s ago`
                            : 'No heartbeat timestamp available'}</small></span>
                        <span className={`badge ${badge(node.state)}`}>{node.state}</span></a>)}
                {snapshot.nodes.items.length === 0 && <p>No Nodes registered. <a href="#/nodes">Connect a Node →</a></p>}
            </>}
        </>}
    </section>;
}

export function MonitoringPage() {
    const [route, setRoute] = useState<MonitoringRoute>(() => parseMonitoringHash(location.hash));
    useEffect(() => { const update = () => setRoute(parseMonitoringHash(location.hash)); addEventListener('hashchange', update); return () => removeEventListener('hashchange', update); }, []);
    const tabs: { key: MonitoringTab; title: string }[] = [{key:'overview',title:'Overview'},{key:'activity',title:'Activity'},{key:'logs',title:'Logs'}];
    return <div className="monitoring-page">
        <nav className="tabs project-nav" aria-label="Monitoring sections">{tabs.map(tab => <a key={tab.key} href={monitoringHash(tab.key, tab.key === route.tab ? route.filters : {})} aria-current={route.tab === tab.key ? 'page' : undefined} className={route.tab === tab.key ? 'active' : ''}>{tab.title}</a>)}</nav>
        {route.tab === 'overview' && <><MonitoringOverview /><MonitoringHealthPanel /></>}
        {route.tab === 'activity' && <><header className="page-head"><div><p className="eyebrow">Atlas Monitoring</p><h1>Activity</h1><p>Search and investigate structured operations across Atlas.</p></div></header><ActivityPanel filters={route.filters} /></>}
        {route.tab === 'logs' && <><header className="page-head"><div><p className="eyebrow">Atlas Monitoring</p><h1>Logs</h1><p>Inspect approved Node tails and bounded Atlas Server diagnostics.</p></div></header><LogsPanel filters={route.filters} /></>}
    </div>;
}
