import { SkeletonRows } from './Skeletons';
import { useEffect, useRef, useState } from 'react';
import { callTool, IS_MOCK_MODE } from './api';
import type { AuditEvent } from './types';
import { ActivityRows } from './ActivityFeed';
import { MonitoringOverview } from './Workspace';
import { monitoringHash, parseMonitoringHash, type MonitoringFilters, type MonitoringRoute, type MonitoringTab } from './monitoringLinks';
import './activity.css';

type ActivityPage = { items: AuditEvent[]; total: number; offset: number; limit: number };
type ProjectWorkspace = { id: string; name: string };
type ProjectWorkspaceDirectory = { projectId: string; items: ProjectWorkspace[]; unavailable: boolean };
const LIMIT = 30;
const ACTIVITY_LIVE_POLL_MS = 30_000;
export function localDateTimeValue(instant?: string) {
    if (!instant) return '';
    const date = new Date(instant);
    if (Number.isNaN(date.getTime())) return '';
    const two = (value: number) => String(value).padStart(2, '0');
    return [date.getFullYear(), two(date.getMonth() + 1), two(date.getDate())].join('-') + 'T' + [two(date.getHours()), two(date.getMinutes())].join(':');
}
const CATEGORIES = ['','core','view','node','workspace','files','backup','git','dev','unity'];
function ActivityPanel({ filters, projectId, refreshVersion = 0 }: {
    filters: MonitoringFilters; projectId?: string; refreshVersion?: number;
}) {
    const [page, setPage] = useState<ActivityPage>();
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [refresh, setRefresh] = useState(0);
    const [lastUpdated, setLastUpdated] = useState<string>();
    const live = filters.live === '1';
    const [search, setSearch] = useState(filters.search ?? '');
    const [draft, setDraft] = useState<MonitoringFilters>(filters);
    const [workspaceDirectory, setWorkspaceDirectory] = useState<ProjectWorkspaceDirectory>();
    useEffect(() => {
        if (!projectId) return;
        const controller = new AbortController();
        setWorkspaceDirectory(undefined);
        // The Project-only name lookup is display metadata. Filtering remains server-side by workspaceId.
        void callTool<ProjectWorkspace[]>('list_project_workspaces',
            { projectId, includeArchived: true }, controller.signal)
            .then(items => {
                if (!controller.signal.aborted) setWorkspaceDirectory({ projectId,
                    items: items.filter(item => typeof item.id === 'string' && typeof item.name === 'string'),
                    unavailable: false });
            })
            .catch(() => {
                if (!controller.signal.aborted) setWorkspaceDirectory({ projectId, items: [], unavailable: true });
            });
        return () => controller.abort();
    }, [projectId, refreshVersion]);
    const scopedWorkspaces = workspaceDirectory?.projectId === projectId ? workspaceDirectory : undefined;
    const workspaceNames = Object.fromEntries(
        (scopedWorkspaces?.items ?? []).map(({ id, name }) => [id, name]));
    const liveRef = useRef(live);
    liveRef.current = live;
    // The reader survives a live-mode toggle; only scope/manual refresh owns
    // network cancellation and clearing the previously displayed page.
    const activeReader = useRef<{
        read: () => void; inFlight: boolean; lastSettledAt?: number; consecutiveFailures: number;
    } | null>(null);
    const schedulePoll = useRef<() => void>(() => {});
    useEffect(() => setSearch(filters.search ?? ''), [filters.search]);
    useEffect(() => setDraft(filters), [JSON.stringify(filters)]);
    const offset = Math.max(0, Math.min(10000, Number(filters.offset) || 0));
    const navigate = (next: MonitoringFilters) => {
        // Project Activity is an immutable Project scope; URL filters may refine but not replace it.
        const href = monitoringHash('activity', projectId ? { ...next, projectId } : next);
        location.hash = projectId
            ? href.replace('#/monitoring?', `#/projects/${encodeURIComponent(projectId)}/activity?`)
            : href;
    };
    const setFilter = (key: keyof MonitoringFilters, value: string) => {
        const next = { ...filters, [key]: value || undefined, offset: undefined };
        navigate(next);
    };
    const scopeInput = Object.fromEntries(Object.entries(filters)
        .filter(([key, value]) => key !== 'offset' && key !== 'live' && value));
    const scopeKey = JSON.stringify(scopeInput);
    useEffect(() => {
        const controller = new AbortController();
        const reader = { read: () => {}, inFlight: false, lastSettledAt: undefined as number | undefined, consecutiveFailures: 0 };
        activeReader.current = reader;
        setPage(undefined); setError(''); setLastUpdated(undefined);
        // Scope changes and manual Refresh are the only reasons to clear data.
        const input = JSON.parse(scopeKey) as Record<string, unknown>;
        reader.read = () => {
            if (controller.signal.aborted || reader.inFlight ||
                (liveRef.current && document.visibilityState === 'hidden')) return;
            reader.inFlight = true;
            setLoading(true); setError('');
            void callTool<ActivityPage>('query_monitoring_activity',
                { ...input, offset, limit: LIMIT, groupOperations: true, safeDetails: true }, controller.signal)
                .then(value => {
                    if (!controller.signal.aborted) { reader.consecutiveFailures = 0; setPage(value); setLastUpdated(new Date().toLocaleTimeString()); }
                })
                .catch(e => { if (!controller.signal.aborted) { reader.consecutiveFailures = Math.min(reader.consecutiveFailures + 1, 4); setError((e as Error).message); } })
                .finally(() => {
                    reader.inFlight = false;
                    if (controller.signal.aborted) return;
                    reader.lastSettledAt = Date.now();
                    setLoading(false);
                    schedulePoll.current();
                });
        };
        if (!liveRef.current || document.visibilityState !== 'hidden') reader.read();
        else setLoading(false);
        return () => {
            controller.abort();
            if (activeReader.current === reader) activeReader.current = null;
        };
    }, [scopeKey, offset, refresh, refreshVersion]);

    useEffect(() => {
        // Starting or stopping live mode never clears the settled page, aborts
        // an existing manual read, or starts an unsolicited replacement query.
        if (!live) {
            schedulePoll.current = () => {};
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = undefined;
            if (document.visibilityState === 'hidden') return;
            const reader = activeReader.current;
            if (!reader || reader.inFlight) return;
            const remaining = reader.lastSettledAt === undefined ? 0
                : Math.max(0, ACTIVITY_LIVE_POLL_MS * 2 ** reader.consecutiveFailures - (Date.now() - reader.lastSettledAt));
            if (remaining === 0) reader.read();
            else timer = setTimeout(() => activeReader.current?.read(), remaining);
        };
        schedulePoll.current = schedule;
        document.addEventListener('visibilitychange', schedule);
        schedule();
        return () => {
            if (timer) clearTimeout(timer);
            document.removeEventListener('visibilitychange', schedule);
            if (schedulePoll.current === schedule) schedulePoll.current = () => {};
        };
    }, [live, scopeKey, offset, refresh, refreshVersion]);
    const operationCount = page ? new Set(page.items.map(event => {
        const details = event.resulting && typeof event.resulting === 'object' ? event.resulting as Record<string, unknown> : {};
        const attempt = typeof details.attemptId === 'string' ? details.attemptId : '';
        return event.operation.startsWith('workspace.') && attempt
            ? `attempt:${event.projectId ?? ''}:${event.workspaceId ?? ''}:${attempt}` : event.id;
    })).size : 0;
    const changePage = (next: number) => { navigate({
        ...filters, offset: String(next), live: next > 0 ? undefined : filters.live,
    }); };
    const advancedKeys: (keyof MonitoringFilters)[] = [
        'projectId', 'logicalWorkspaceId', 'workspaceId', 'checkoutId', 'nodeId',
        'storeId', 'client', 'operation', 'from', 'to',
    ];
    const advancedCount = advancedKeys.filter(key =>
        Boolean(filters[key]) && !(key === 'projectId' && projectId)).length;
    // Open a newly selected technical scope even when a same-tab Activity link
    // reuses this component. Do not override a manual collapse when unrelated
    // filters or the current scope's page/refresh change.
    const advancedScopeKey = advancedKeys
        .filter(key => Boolean(filters[key]) && !(key === 'projectId' && projectId))
        .map(key => [key, filters[key]]);
    const advancedScopeSignature = JSON.stringify(advancedScopeKey);
    const [advancedOpen, setAdvancedOpen] = useState(Boolean(projectId || advancedCount));
    const previousAdvancedScope = useRef(advancedScopeSignature);
    useEffect(() => {
        if (previousAdvancedScope.current === advancedScopeSignature) return;
        previousAdvancedScope.current = advancedScopeSignature;
        if (advancedScopeKey.length > 0) setAdvancedOpen(true);
    }, [advancedScopeSignature]);
    const hasActiveFilters = Object.entries(filters).some(([key, value]) =>
        Boolean(value) && key !== 'live' && key !== 'offset' && !(key === 'projectId' && projectId))
        || search !== (filters.search ?? '')
        || advancedKeys.some(key => (draft[key] ?? '') !== (filters[key] ?? ''));
    return <section className="panel activity-panel" aria-label={projectId ? 'Project activity' : 'Monitoring activity'}>
        <div className="panel-head"><div><p className="eyebrow">Immutable Atlas audit history</p><h2>{projectId ? 'Project activity' : 'Activity'}</h2></div><div className="actions">
            {projectId && <a className="monitoring-project-link" href={monitoringHash('activity', filters)}>Open in Monitoring →</a>}
            <button type="button" className="ghost" aria-pressed={live}
                onClick={() => navigate({
                    ...filters, live: live ? undefined : '1', offset: undefined,
                })}>{live ? 'Stop live updates' : 'Start live updates'}</button>
            <button className="ghost" disabled={loading} onClick={() => setRefresh(x => x + 1)}>Refresh</button>
        </div></div>
        <div className="monitoring-primary-filters" role="group" aria-label="Common activity filters">
            <form className="monitoring-search" onSubmit={e => { e.preventDefault(); setFilter('search', search.trim()); }}>
                <label>Search<input aria-label="Search activity" value={search} onChange={e => setSearch(e.target.value)} maxLength={200} placeholder="Find an operation" /></label>
                <button type="submit">Apply</button>
            </form>
            <label>Category<select aria-label="Category" value={filters.category ?? ''} onChange={e => setFilter('category', e.target.value)}>{CATEGORIES.map(x => <option key={x} value={x}>{x || 'All categories'}</option>)}</select></label>
            <label>Outcome<select aria-label="Outcome" value={filters.outcome ?? ''} onChange={e => setFilter('outcome', e.target.value)}>{['','failed','pending','completed'].map(x => <option key={x} value={x}>{x || 'All outcomes'}</option>)}</select></label>
            <button type="button" className="ghost" disabled={!hasActiveFilters}
                onClick={() => { setSearch(''); setDraft(projectId ? { projectId } : {});
                    navigate({ live: filters.live }); }}>Reset filters</button>
        </div>
        <details className="monitoring-advanced-filters" open={advancedOpen}
            onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
            <summary>Scope and time filters{advancedCount ? ' · ' + advancedCount + ' active' : ''}</summary>
            <div className="activity-filters monitoring-filters">
                {projectId && <label>Workspace
                    <select aria-label="Workspace" value={filters.workspaceId ?? ''}
                        onChange={e => setFilter('workspaceId', e.target.value)}>
                        <option value="">All workspaces</option>
                        {(scopedWorkspaces?.items ?? []).map(workspace =>
                            <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.id.slice(0, 8)})</option>)}
                        {filters.workspaceId && !scopedWorkspaces?.items.some(item => item.id === filters.workspaceId) &&
                            <option value={filters.workspaceId}>Workspace {filters.workspaceId}</option>}
                    </select>
                </label>}
                {([
                    ['projectId', 'Project ID'], ['logicalWorkspaceId', 'Logical Workspace ID'], ['workspaceId', 'Workspace ID'], ['checkoutId', 'Checkout ID'],
                    ['nodeId', 'Node ID'], ['storeId', 'Store ID'], ['client', 'Client'], ['operation', 'Operation'],
                ] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={label} readOnly={key === 'projectId' && !!projectId} value={draft[key] ?? ''} onChange={e => setDraft(previous => ({ ...previous, [key]: e.target.value }))} placeholder="All" /></label>)}
                <label>From<input aria-label="From" type="datetime-local" value={localDateTimeValue(filters.from)} onChange={e => setFilter('from', e.target.value ? new Date(e.target.value).toISOString() : '')} /></label>
                <label>To<input aria-label="To" type="datetime-local" value={localDateTimeValue(filters.to)} onChange={e => setFilter('to', e.target.value ? new Date(e.target.value).toISOString() : '')} /></label>
                <button type="button" className="ghost" onClick={() => navigate({ ...draft, offset: undefined })}>Apply filters</button>
            </div>
        </details>
        {projectId && scopedWorkspaces?.unavailable && <p role="status" className="activity-footnote">
            Workspace names unavailable. You can still filter by Workspace ID.
        </p>}
        {loading && !page && !error && <SkeletonRows label="Loading audit history" variant="activity" rows={5} />}
        {error && <p role="alert" className="activity-error">Audit history unavailable: {error}</p>}
        {page && <><div className="activity-scroll"><ActivityRows events={page.items} names={workspaceNames} scopeLinks />{page.items.length === 0 && <p className="empty">No events match these filters.</p>}</div>
            <div className="monitoring-pagination"><span>{page.total && operationCount ? `${page.offset + 1}–${page.offset + operationCount} of ${page.total} operations` : page.total ? `No operations on this page · ${page.total} total` : '0 operations'} · Filtered on the server</span><div className="actions"><button className="ghost" disabled={page.offset === 0} onClick={() => changePage(Math.max(0, page.offset - page.limit))}>Previous</button><button className="ghost" disabled={page.offset + operationCount >= page.total || page.offset >= 10000} onClick={() => changePage(page.offset + page.limit)}>Next</button></div></div></>}
        <p className="activity-footnote" role="status">{live
            ? 'Live updates on · at most one read every 30 seconds after completion · failures back off up to 8 minutes · paused in hidden tabs'
            : 'Live updates off · manual refresh only'}{lastUpdated ? ` · Last updated ${lastUpdated}` : ''}</p>
        <p className="activity-footnote">Recorded events only. A pending request is not proof of a failed operation; audit retention and runtime logs are separate.</p>
    </section>;
}
/** Project Activity reuses the full server-filtered Monitoring reader, never the legacy polling feed. */
export function ProjectActivityPanel({ projectId, refreshVersion = 0 }: { projectId: string; refreshVersion?: number }) {
    const filters = { ...parseMonitoringHash(location.hash).filters, projectId };
    return <ActivityPanel filters={filters} projectId={projectId} refreshVersion={refreshVersion} />;
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
    source: 'atlas-server-process' | 'atlas-server-history'; available: boolean;
    startedAt?: string; retention: 'current-process' | 'best-effort';
    retentionDays?: number; coverage?: 'incomplete-possible'; droppedSinceStart?: number;
    queuedForWrite?: number; writePaused?: boolean;
    events: ServerDiagnosticEvent[]; truncated: boolean; nextCursor?: string;
};
function ServerDiagnosticsPanel({ filters }: { filters: MonitoringFilters }) {
    const history = filters.history === '1';
    const parsed = Number(filters.lines);
    const limit = Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 30;
    const [result, setResult] = useState<ServerDiagnosticResponse>();
    const [settledPage, setSettledPage] = useState<{ scope: string; cursor?: string; refresh: number }>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState('');
    const [refresh, setRefresh] = useState(0);
    // Cursor stacks belong to one source and page size. Changing either resets
    // pagination immediately (without fetching a stale prior-source cursor).
    const pageScope = `${history ? 'history' : 'process'}:${limit}`;
    const [pages, setPages] = useState<{ scope: string; cursors: Array<string | undefined>; index: number }>(
        { scope: '', cursors: [undefined], index: 0 });
    const currentPage = pages.scope === pageScope ? pages
        : { scope: pageScope, cursors: [undefined], index: 0 };
    // Persist the reset, not just a derived fallback. Otherwise switching
    // history -> process -> history can revive an earlier history cursor.
    useEffect(() => {
        setPages({ scope: pageScope, cursors: [undefined], index: 0 });
    }, [pageScope]);
    const cursor = history ? currentPage.cursors[currentPage.index] : undefined;
    useEffect(() => {
        const controller = new AbortController();
        setResult(undefined); setError(''); setBusy(true);
        void callTool<ServerDiagnosticResponse>(history ? 'read_server_diagnostic_history' : 'read_server_diagnostics',
            history && cursor ? { limit, cursor } : { limit }, controller.signal)
            .then(value => { if (!controller.signal.aborted) {
                setResult(value); setSettledPage({ scope: pageScope, cursor, refresh });
            } })
            .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
            .finally(() => { if (!controller.signal.aborted) setBusy(false); });
        return () => controller.abort();
    }, [limit, refresh, history, cursor]);
    // A bookmark/source switch must never briefly render rows from the other source.
    const visible = settledPage?.scope === pageScope && settledPage.cursor === cursor
        && settledPage.refresh === refresh
        && result?.source === (history ? 'atlas-server-history' : 'atlas-server-process')
        ? result : undefined;
    const events = visible?.events.filter(event => (event.code + ' ' + event.message).toLowerCase().includes(search.toLowerCase())) ?? [];
    const output = events.map(event => event.at + ' [' + event.level + '] ' + event.message).join('\n');
    return <section className="panel activity-panel" aria-label="Server diagnostics">
        <div className="panel-head"><div><p className="eyebrow">{history ? 'Best-effort retained fixed codes' : 'Current server process · fixed event codes'}</p><h2>Atlas Server diagnostics</h2></div>
            <button type="button" className="ghost" disabled={busy} onClick={() => setRefresh(x => x + 1)}>{busy ? 'Reading…' : 'Refresh diagnostics'}</button></div>
        <div className="activity-filters">
            <label>Source<select aria-label="Diagnostic source" value={history ? 'history' : 'process'}
                onChange={e => location.hash = monitoringHash('logs', { ...filters, target: 'server',
                    history: e.target.value === 'history' ? '1' : undefined })}>
                <option value="process">Current process</option>
                <option value="history">Retained Server events</option>
            </select></label>
            <label>Events<input type="number" aria-label="Diagnostic events" min={1} max={100} value={limit}
                onChange={e => { const next = Number(e.target.value); if (Number.isInteger(next) && next >= 1 && next <= 100)
                    location.hash = monitoringHash('logs', { target: 'server', history: filters.history, lines: String(next) }); }} /></label>
            <label>Search loaded events<input aria-label="Search diagnostics" value={search} onChange={e => setSearch(e.target.value)} /></label>
        </div>
        <p className="activity-footnote">{history
            ? 'PostgreSQL retains up to 14 days of fixed-code Server signals across restarts. Writes are best-effort, so missing events do not prove healthy operation. This is not Docker stdout/stderr, complete historical logs or an audit ledger.'
            : 'Only non-sensitive operational event codes from this Atlas Server process are shown. This is not Docker stdout/stderr or a multi-instance archive.'}</p>
        {busy && !visible && !error && <SkeletonRows label="Loading server diagnostics" variant="metrics" rows={3} />}
        {error && <p role="alert" className="activity-error">Server diagnostics unavailable: {error}</p>}
        {visible && !visible.available && <p className="empty">{history ? 'Retained Server diagnostics unavailable or disabled. Check database migration and connectivity.' : 'Server diagnostics are disabled on this deployment.'}</p>}
        {visible?.available && <div className="monitoring-log-result">
            <p>{history ? 'Available events from the last 14 days · coverage may be incomplete' : 'Since ' + (visible.startedAt ? new Date(visible.startedAt).toLocaleString() : 'this restart')}{visible.truncated ? ' · More events exist than the current limit' : ''}{history && visible.droppedSinceStart ? ' · ' + visible.droppedSinceStart + ' writes lost in this process' : ''}
                {history && visible.writePaused ? ' · Diagnostic writer backing off; recent history may be missing' : ''}</p>
            <div className="actions"><button className="ghost" onClick={() => void navigator.clipboard.writeText(output)}>Copy visible diagnostics</button></div>
            <pre>{output || (search ? '(no matching events in loaded diagnostics)' : '(no diagnostic events)')}</pre>
        </div>}
        {history && <div className="actions" aria-label="Diagnostic history pagination">
            <button type="button" className="ghost" disabled={busy || currentPage.index === 0}
                onClick={() => setPages({ ...currentPage, index: currentPage.index - 1 })}>Newer events</button>
            <span role="status">History page {currentPage.index + 1}</span>
            <button type="button" className="ghost" disabled={busy || !visible?.available || !visible.nextCursor}
                onClick={() => {
                    if (!visible?.nextCursor) return;
                    setPages({ scope: pageScope,
                        cursors: [...currentPage.cursors.slice(0, currentPage.index + 1), visible.nextCursor],
                        index: currentPage.index + 1 });
                }}>Older events</button>
            {visible?.available && visible.truncated && !visible.nextCursor &&
                <span>Older pages require an updated Atlas Server.</span>}
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
        <div className="monitoring-source-guide" role="group" aria-label="Log source boundaries">
            <div><strong>Node tails</strong><span>Approved stdout, stderr or Linux service journal. On-demand, bounded and not an archive.</span></div>
            <div><strong>Server signals</strong><span>Fixed-code diagnostics only: current process or best-effort retained history, not Docker logs.</span></div>
        </div>
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
    diagnostics?: { status: 'available' | 'unavailable' | 'disabled' | 'unknown';
        coverage: 'incomplete-possible'; retentionDays: number;
        droppedSinceStart: number | null; queuedForWrite: number | null; writePaused: boolean | null;
        retentionCleanup?: 'not-checked' | 'caught-up' | 'more-possible' | 'unavailable' | 'disabled' | 'unknown' };
    nodes: { available: boolean; summary: { total: number; healthy: number; stale: number;
        offline: number; unavailable: number; revoked: number; unknown: number }; items: HealthNode[] };
};

/** During a rolling deployment an older Server may report healthy without
 * probing diagnostic history. Never paint that unverified aggregate green.
 * A confirmed DB/Node failure retains its higher-priority degraded state. */
function displayedHealthOverall(snapshot: HealthSnapshot): HealthSnapshot['overall'] {
    if (snapshot.overall !== 'healthy') return snapshot.overall;
    const archive = snapshot.diagnostics;
    if (!archive || (archive.status !== 'available' && archive.status !== 'disabled')
        || archive.writePaused === true || (archive.droppedSinceStart ?? 0) > 0
        || (archive.status === 'available' && archive.retentionCleanup !== 'caught-up')) return 'unknown';
    return 'healthy';
}
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
    const badge = (status: string) => ['healthy', 'reachable', 'available', 'caught-up'].includes(status) ? 'success' : 'muted';
    const displayedOverall = snapshot ? displayedHealthOverall(snapshot) : 'unknown';
    return <section className="workspace-section" aria-label="Live operational health">
        <div className="section-heading"><h2>Live operational health</h2>
            <button className="ghost" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{busy ? 'Checking…' : 'Refresh health'}</button>
        </div>
        {busy && !snapshot && !error && <SkeletonRows label="Checking Server and Node health" variant="metrics" rows={3} />}
        {error && <p role="alert">Health snapshot unavailable: {error}</p>}
        {snapshot && <>
            <p><span aria-label="Overall health" className={`badge ${badge(displayedOverall)}`}>{displayedOverall}</span> · Checked {new Date(snapshot.checkedAt).toLocaleString()} · {IS_MOCK_MODE ? 'Simulated preview — no live health probes' : 'On-demand snapshot, not continuous monitoring'}</p>
            <div className="monitoring-health-summary" role="group" aria-label="Health signal summary">
                <div><strong>{snapshot.server.database.status}</strong><small>Database</small></div>
                <div><strong>{snapshot.diagnostics?.status ?? 'unknown'}</strong><small>Diagnostic archive</small></div>
                <div><strong>{snapshot.diagnostics?.retentionCleanup ?? 'unknown'}</strong><small>Physical expiry</small></div>
                <div><strong>{snapshot.nodes.available ? snapshot.nodes.summary.healthy + ' / ' + snapshot.nodes.summary.total : 'unknown'}</strong><small>Healthy Nodes</small></div>
            </div>
            <div className="workspace-row"><span className="row-copy"><strong>Atlas Server · database</strong>
                <small>{snapshot.server.database.status === 'reachable'
                    ? `Database query succeeded · ${snapshot.server.database.latencyMs ?? '—'} ms · Server uptime ${Math.floor(snapshot.server.uptimeSeconds / 60)} min`
                    : 'Database health query failed; Server process is responding'}</small></span>
                <span className={`badge ${badge(snapshot.server.status)}`}>{snapshot.server.database.status}</span>
            </div>
            <div className="workspace-row"><span className="row-copy"><strong>Server diagnostic archive</strong>
                <small>{!snapshot.diagnostics
                    ? 'Archive state unknown (older Server revision); check retained diagnostics'
                    : snapshot.diagnostics.status === 'disabled'
                        ? 'Fixed-code archive disabled by configuration; no history is being written'
                    : snapshot.diagnostics.status === 'unavailable' || snapshot.diagnostics.status === 'unknown'
                        ? 'Archive read not verified; history may be missing'
                    : `Read probe succeeded · ${snapshot.diagnostics.retentionDays}-day best-effort history`}</small>
                {snapshot.diagnostics && (snapshot.diagnostics.droppedSinceStart != null || snapshot.diagnostics.queuedForWrite != null) &&
                    <small role="status">
                        {snapshot.diagnostics.droppedSinceStart != null
                            ? `${snapshot.diagnostics.droppedSinceStart} dropped since restart`
                            : 'Dropped-write count unknown'}
                        {' · '}
                        {snapshot.diagnostics.queuedForWrite != null
                            ? `${snapshot.diagnostics.queuedForWrite} waiting to write`
                            : 'Pending-write count unknown'}
                    </small>}
                {snapshot.diagnostics?.writePaused && <small role="status">Archive writes are backing off after a failure; recent events may be missing.</small>}
                {snapshot.diagnostics?.status === 'available' && <small role="status">
                    {snapshot.diagnostics.retentionCleanup === 'caught-up'
                        ? 'Physical expiry sweep caught up at its last check (not a guarantee of ongoing retention).'
                        : snapshot.diagnostics.retentionCleanup === 'more-possible'
                            ? 'Expiry cleanup reached its bounded work budget; older rows may remain until a later sweep.'
                        : snapshot.diagnostics.retentionCleanup === 'unavailable'
                            ? 'Expiry cleanup failed; disk retention may be behind even though reads remain limited to 14 days.'
                        : 'Physical expiry has not been verified in this Server process.'}
                </small>}
                <small>Historical coverage is never guaranteed. <a href={monitoringHash('logs', { target: 'server', history: '1' })}>View retained diagnostics</a></small></span>
                <span className={`badge ${badge(snapshot.diagnostics?.status ?? 'unknown')}`}>{snapshot.diagnostics?.status ?? 'unknown'}</span>
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
