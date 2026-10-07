import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { callTool } from './api';
import type { AuditEvent } from './types';
import { clientName, filterActivity, presentActivity, readable } from './activity';
import './activity.css';

type WorkspaceName = { id: string; name: string };
export function ActivityRows({ events, names = {} }: { events: AuditEvent[]; names?: Record<string, string> }) {
    return <>{presentActivity(events, names).map(item => <ActivityRow key={item.id} item={item} />)}</>;
}
function ActivityRow({ item }: { item: ReturnType<typeof presentActivity>[number] }) {
    return <details className={`activity-item activity-${item.status}`} data-activity-id={item.id}>
        <summary><div className="activity-action"><small>{clientName(item.client)} · {readable(item.category)}{item.workspaceName && ` · ${item.workspaceName}`}</small><strong>{item.title}</strong>{item.description && <span className="activity-error">{item.description}</span>}</div><div className="activity-state"><span>{readable(item.status)}</span><small>{readable(item.kind)}</small><time dateTime={item.timestamp} title={item.timestamp}>{new Date(item.timestamp).toLocaleString()}</time></div></summary>
        <div className="activity-details"><dl>{Object.entries(item.details).filter(([, value]) => value !== undefined).map(([key, value]) => <div key={key}><dt>{readable(key.replace(/([a-z])([A-Z])/g, '$1 $2'))}</dt><dd>{typeof value === 'object' ? <pre>{JSON.stringify(value, null, 2)}</pre> : String(value)}</dd></div>)}</dl></div>
    </details>;
}

export function ActivityFeed({ projectId, title = 'Recent activity' }: { projectId?: string; title?: string }) {
    // Scope changes remount the reader so late responses cannot leak between projects.
    return <ActivityReader key={projectId ?? 'all'} projectId={projectId} title={title} />;
}
function ActivityReader({ projectId, title }: { projectId?: string; title: string }) {
    const [workspaceId, setWorkspaceId] = useState('');
    const [category, setCategory] = useState(''); const [client, setClient] = useState('');
    const [events, setEvents] = useState<AuditEvent[]>([]); const [names, setNames] = useState<Record<string, string>>({});
    const [error, setError] = useState(''); const [loaded, setLoaded] = useState(false); const [updated, setUpdated] = useState('');
    const viewport = useRef<HTMLDivElement>(null);
    const anchor = useRef<{ id: string; offset: number } | null>(null);
    const namesLoaded = useRef(new Map<string, number>());
    useEffect(() => {
        let disposed = false; let timer: ReturnType<typeof setTimeout>;
        const controller = new AbortController();
        async function refresh() {
            if (document.visibilityState === 'hidden') { timer = setTimeout(refresh, 5000); return; }
            try {
                const next = await callTool<AuditEvent[]>('get_recent_activity', { ...(projectId && { projectId }), ...(workspaceId && { workspaceId }), limit: 200 }, controller.signal);
                if (disposed) return;
                const container = viewport.current;
                const visible = container && container.scrollTop > 0 ? [...container.querySelectorAll<HTMLElement>('[data-activity-id]')].find(el => el.offsetTop >= container.scrollTop) : undefined;
                anchor.current = visible && container ? { id: visible.dataset.activityId!, offset: visible.offsetTop - container.scrollTop } : null;
                setEvents(next); setError(''); setLoaded(true); setUpdated(new Date().toLocaleTimeString());
                const projects = projectId ? [projectId] : [...new Set(next.map(e => e.projectId).filter((id): id is string => !!id))];
                await Promise.allSettled(projects.filter(id => Date.now() - (namesLoaded.current.get(id) ?? 0) > 60_000).map(async id => {
                    const workspaces = await callTool<WorkspaceName[]>('list_project_workspaces', { projectId: id, includeArchived: true }, controller.signal);
                    if (disposed) return;
                    namesLoaded.current.set(id, Date.now());
                    setNames(previous => ({ ...previous, ...Object.fromEntries(workspaces.map(w => [w.id, w.name])) }));
                }));
            } catch (e) { if (!disposed) setError((e as Error).message); }
            if (!disposed) timer = setTimeout(refresh, 5000);
        }
        setEvents([]); setLoaded(false); setError(''); setUpdated('');
        void refresh();
        return () => { disposed = true; clearTimeout(timer); controller.abort(); };
    }, [projectId, workspaceId]);
    useLayoutEffect(() => {
        const container = viewport.current; const saved = anchor.current;
        if (container && saved) {
            const row = [...container.querySelectorAll<HTMLElement>('[data-activity-id]')].find(el => el.dataset.activityId === saved.id);
            if (row) container.scrollTop = row.offsetTop - saved.offset;
        }
        anchor.current = null;
    }, [events]);
    const items = presentActivity(events, names);
    const visible = filterActivity(items, category, client, workspaceId);
    const workspaceOptions = { ...names, ...Object.fromEntries(items.filter(i => i.workspaceId).map(i => [i.workspaceId!, i.workspaceName!])) };
    return <section className="panel activity-panel" aria-label={title}>
        <div className="panel-head"><div><p className="eyebrow">Workspace Activity · Core · Views</p><h2>{title}</h2></div><small role="status">{updated ? `Auto-refresh · Updated ${updated}` : 'Loading activity…'}</small></div>
        <div className="activity-filters">
            <label>Category<select value={category} onChange={e => setCategory(e.target.value)}>{[['', 'All'], ['workspace', 'Workspace'], ['files', 'Files'], ['unity', 'Unity'], ['git', 'Git'], ['dev', 'Development'], ['error', 'Errors'], ['core', 'Core'], ['view', 'Views']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Client<select value={client} onChange={e => setClient(e.target.value)}><option value="">All clients</option>{[...new Set([...items.map(i => clientName(i.client)), ...(client ? [client] : [])])].sort().map(c => <option key={c} value={c}>{clientName(c)}</option>)}</select></label>
            <label>Workspace<select value={workspaceId} onChange={e => { setWorkspaceId(e.target.value); setClient(''); }}><option value="">All workspaces</option>{Object.entries(workspaceOptions).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        </div>
        {error && <p className="activity-error" role="alert">Activity could not refresh: {error}. Retrying automatically.</p>}
        <div className="activity-scroll" ref={viewport}>{visible.map(item => <ActivityRow key={item.id} item={item} />)}{loaded && visible.length === 0 && <p className="empty">No activity matches these filters.</p>}</div>
        <p className="activity-footnote">Latest 200 audit events in this scope · Paired requests and results are grouped · Expand an action for details</p>
    </section>;
}
