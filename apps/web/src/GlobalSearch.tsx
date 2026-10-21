import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { callTool } from './api';
import { ShellIcon } from './ShellIcon';
import './global-search.css';

export type SearchKind = 'project' | 'application' | 'view' | 'store' | 'record' | 'workspace' | 'node';
export type SearchHit = { id: string; kind: SearchKind; title: string; description: string; context: string; href: string; score: number; action?: { type: 'read_node_logs'; nodeId: string; source: 'stdout' | 'stderr'; lines: number } };
export type SearchResponse = { query: string; results: SearchHit[]; incomplete: string[] };

type Result = SearchHit & { source: 'atlas' | 'shortcut' };
const labels: Record<SearchKind, string> = {
    project: 'Projects', application: 'Applications', view: 'Views', store: 'Data stores',
    record: 'Records', workspace: 'Workspaces', node: 'Nodes',
};
const shortcuts: Result[] = [
    { id: 'shortcut-projects', kind: 'project', title: 'Browse projects', description: 'All Atlas projects', context: 'Navigate', href: '#/projects', score: 0, source: 'shortcut' },
    { id: 'shortcut-apps', kind: 'application', title: 'Find an application', description: 'Search launchable Atlas applications', context: 'Search', href: '#/applications', score: 0, source: 'shortcut' },
    { id: 'shortcut-data', kind: 'store', title: 'Explore data', description: 'PostgreSQL and object storage overview', context: 'Navigate', href: '#/data', score: 0, source: 'shortcut' },
    { id: 'shortcut-nodes', kind: 'node', title: 'Inspect node activity', description: 'Nodes, hosted workspaces and recent operations', context: 'Navigate', href: '#/nodes', score: 0, source: 'shortcut' },
    { id: 'shortcut-status', kind: 'node', title: 'Open monitoring', description: 'Server status and node connectivity', context: 'Navigate', href: '#/monitoring', score: 0, source: 'shortcut' },
    { id: 'shortcut-activity', kind: 'node', title: 'Review Atlas activity', description: 'Recent changes and operations', context: 'Navigate', href: '#/activity', score: 0, source: 'shortcut' },
    { id: 'shortcut-settings', kind: 'node', title: 'Open settings', description: 'Atlas preferences', context: 'Navigate', href: '#/settings', score: 0, source: 'shortcut' },
];
const promptExamples = ['Open the portfolio app', 'Show the last 100 error lines from my Mac node', 'Find Markov notes'];

function Icon({ kind }: { kind: SearchKind }) {
    if (kind === 'record' || kind === 'store') return <ShellIcon name="data" />;
    if (kind === 'application') return <ShellIcon name="projects" />;
    if (kind === 'project' || kind === 'workspace') return <ShellIcon name="projects" />;
    if (kind === 'view') return <ShellIcon name="views" />;
    return <ShellIcon name="nodes" />;
}
function isExternalWindow(hit: Result) { return hit.kind === 'application'; }

export function GlobalSearch({ onClose }: { onClose: () => void }) {
    const [query, setQuery] = useState('');
    const [response, setResponse] = useState<SearchResponse | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [active, setActive] = useState(0);
    const [logView, setLogView] = useState<{ hit: Result; lines: string[]; available: boolean; truncated: boolean; loading: boolean; error: string } | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const linksRef = useRef<Array<HTMLAnchorElement | HTMLButtonElement | null>>([]);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        inputRef.current?.focus();
        const oldOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = oldOverflow; previous?.focus(); };
    }, []);
    useEffect(() => {
        setLogView(null);
        const value = query.trim();
        if (!value) { setResponse(null); setBusy(false); setError(''); return; }
        let alive = true;
        const controller = new AbortController();
        setBusy(true); setError('');
        const timer = window.setTimeout(() => {
            void callTool<SearchResponse>('search_everything', { query: value, limit: 45 }, controller.signal)
                .then(data => { if (alive) { setResponse(data); setActive(0); } })
                .catch(error => { if (alive && !controller.signal.aborted) { setError(error instanceof Error ? error.message : String(error)); setResponse(null); } })
                .finally(() => { if (alive) setBusy(false); });
        }, 330);
        return () => { alive = false; window.clearTimeout(timer); controller.abort(); };
    }, [query]);
    const results: Result[] = useMemo(() => {
        if (!query.trim()) return shortcuts.filter(item => item.id !== 'shortcut-apps').map(item => item);
        if (response?.query !== query.trim()) return [];
        return response.results.map(item => ({ ...item, source: 'atlas' as const }));
    }, [query, response]);
    const groups = useMemo(() => {
        const by: Array<{ label: string; results: Result[] }> = [];
        for (const hit of results) {
            const label = hit.source === 'shortcut' ? 'Quick navigation' : labels[hit.kind];
            const existing = by.find(group => group.label === label);
            if (existing) existing.results.push(hit);
            else by.push({ label, results: [hit] });
        }
        return by;
    }, [results]);
    const navResults = groups.flatMap(group => group.results);
    async function readLogs(hit: Result) {
        if (!hit.action) return;
        const action = hit.action;
        setLogView({ hit, lines: [], available: true, truncated: false, loading: true, error: '' });
        try {
            const response = await callTool<{ source: string; lines: string[]; available: boolean; truncated: boolean }>('read_node_logs', { nodeId: action.nodeId, source: action.source, lines: action.lines });
            setLogView(current => current?.hit.id === hit.id ? { ...current, ...response, loading: false, error: '' } : current);
        } catch (error) {
            setLogView(current => current?.hit.id === hit.id ? { ...current, loading: false, error: error instanceof Error ? error.message : String(error) } : current);
        }
    }
    const ready = !query.trim() || response?.query === query.trim();
    function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
        if (event.key === 'ArrowDown' && navResults.length) { event.preventDefault(); setActive(index => (index + 1) % navResults.length); return; }
        if (event.key === 'ArrowUp' && navResults.length) { event.preventDefault(); setActive(index => (index + navResults.length - 1) % navResults.length); return; }
        if (event.key === 'Enter' && navResults.length && event.target === inputRef.current) { event.preventDefault(); linksRef.current[active]?.click(); return; }
        if (event.key === 'Tab') {
            const panel = panelRef.current;
            if (!panel) return;
            const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled])'));
            if (!focusable.length) return;
            if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable[focusable.length - 1].focus(); }
            else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0].focus(); }
        }
    }
    let idx = 0;
    return <div className="global-search-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
        <div className="global-search-panel" role="dialog" aria-modal="true" aria-label="Search Atlas" ref={panelRef} onKeyDown={onKeyDown}>
            <div className="global-search-input-row">
                <ShellIcon name="search" />
                <input ref={inputRef} aria-label="Search or describe an action" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
                    autoComplete="off" spellCheck={false} placeholder="What do you want to do in Atlas?" />
                {busy && <span className="global-search-spinner" role="status" aria-label="Searching" />}
                <button className="global-search-close" onClick={onClose} aria-label="Close search">Esc</button>
            </div>
            <div className="global-search-content">
                {logView && <section className="global-search-log-view" aria-label="Node logs">
                    <header className="global-search-log-head">
                        <div><strong>{logView.hit.title}</strong><small>Read-only · {logView.hit.action?.source} · requested {logView.hit.action?.lines} lines</small></div>
                        <div className="global-search-log-actions">
                            <button type="button" onClick={() => void readLogs(logView.hit)} disabled={logView.loading}>Refresh</button>
                            <button type="button" onClick={() => setLogView(null)}>Back</button>
                        </div>
                    </header>
                    {logView.loading && <p role="status" className="global-search-feedback">Reading Node logs…</p>}
                    {logView.error && <p role="alert" className="global-search-feedback">Unable to read logs: {logView.error}</p>}
                    {!logView.loading && !logView.error && (logView.available ? <>
                        {logView.truncated && <p className="global-search-feedback">Showing the bounded tail of the available log file.</p>}
                        <pre className="global-search-log-output">{logView.lines.join('\n') || 'Log is empty.'}</pre>
                    </> : <p className="global-search-feedback">No Atlas log file exists for this stream yet.</p>)}
                </section>}
                {!logView && !query.trim() && <div className="global-search-prompts">
                    <div className="global-search-section-label">Try asking</div>
                    {promptExamples.map(example => <button key={example} onClick={() => setQuery(example)}>{example}<span aria-hidden="true">↗</span></button>)}
                </div>}
                {!logView && error && <p className="global-search-feedback" role="alert">Search is unavailable: {error}</p>}
                {!logView && ready && !error && navResults.length === 0 && <p className="global-search-feedback">No matches yet. Try a project, application, node or record name.</p>}
                {!logView && groups.map(group => <section key={group.label} className="global-search-group">
                    <h2 className="global-search-section-label">{group.label}</h2>
                    {group.results.map(hit => {
                        const index = idx++;
                        const inner = <>
                            <span className="global-search-result-icon"><Icon kind={hit.kind} /></span>
                            <span className="global-search-result-copy"><strong>{hit.title}</strong><small>{hit.context}{hit.description ? ' · ' + hit.description : ''}</small></span>
                            <span className="global-search-open" aria-hidden="true">{hit.action ? '↳' : '↗'}</span>
                        </>;
                        const className = 'global-search-result' + (index === active ? ' selected' : '');
                        return hit.action
                            ? <button key={hit.kind + hit.id + hit.href} type="button"
                                ref={element => { linksRef.current[index] = element; }}
                                className={className} aria-current={index === active ? 'true' : undefined}
                                onMouseEnter={() => setActive(index)} onClick={() => void readLogs(hit)}>{inner}</button>
                            : <a key={hit.kind + hit.id + hit.href}
                                ref={element => { linksRef.current[index] = element; }}
                                className={className} aria-current={index === active ? 'true' : undefined}
                                href={hit.href} target={isExternalWindow(hit) ? '_blank' : undefined}
                                rel={isExternalWindow(hit) ? 'noopener noreferrer' : undefined}
                                onMouseEnter={() => setActive(index)} onClick={onClose}>{inner}</a>;
                    })}
                </section>)}
                {!logView && response?.query === query.trim() && response.incomplete?.length > 0 && <p className="global-search-feedback" role="status">
                    Some sources could not be searched: {response.incomplete.join(', ')}.
                </p>}
                {!logView && /\blogs?\b/i.test(query) && !navResults.some(hit => hit.action) && <p className="global-search-feedback">Atlas Node log access is unavailable for this Node. Update its Node package to enable approved log access.</p>}
            </div>
            <footer className="global-search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>esc</kbd> Close</span></footer>
        </div>
    </div>;
}
