import { useCallback, useEffect, useState } from 'react';
import { callTool } from './api';

export type FypPageResult<T> = { items: T[]; page_cursor: string | null; next_cursor: string | null };

export function useFypRead<T>(name: string, input: Record<string, unknown> | null, interval?: number) {
    const key = input === null ? null : JSON.stringify(input);
    const [revision, setRevision] = useState(0);
    const [result, setResult] = useState<{ key: string; data?: T; error?: string }>();
    useEffect(() => {
        if (key === null) return;
        const controller = new AbortController();
        const parameters = JSON.parse(key) as Record<string, unknown>;
        let timer: number | undefined;
        const load = async () => {
            try {
                const data = await callTool<T>(name, parameters, controller.signal);
                if (!controller.signal.aborted) setResult({ key, data });
            } catch (failure) {
                if (!controller.signal.aborted) setResult(previous => ({ key,
                    data: previous?.key === key ? previous.data : undefined,
                    error: failure instanceof Error ? failure.message : String(failure) }));
            } finally {
                if (!controller.signal.aborted && interval) timer = window.setTimeout(load, interval);
            }
        };
        void load();
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [name, key, interval, revision]);
    const current = key === result?.key ? result : undefined;
    const refresh = useCallback(() => setRevision(value => value + 1), []);
    return { data: current?.data, error: current?.error, loading: key !== null && !current, refresh };
}

export function useFypPage<T>(name: string, scope: Record<string, unknown>, enabled: boolean, liveInterval?: number) {
    const scopeKey = JSON.stringify(scope);
    const [position, setPosition] = useState<{ key: string; cursors: string[] }>({ key: scopeKey, cursors: [] });
    const cursors = position.key === scopeKey ? position.cursors : [];
    const index = Math.max(0, cursors.length - 1);
    const cursor = cursors[index];
    const read = useFypRead<FypPageResult<T>>(name, enabled ? { ...scope, cursor } : null,
        cursors.length ? undefined : liveInterval);
    const next = read.data?.next_cursor;
    const first = read.data?.page_cursor;
    return { ...read, index, items: read.data?.items ?? [], hasNext: !!next, paginated: !!cursors.length || !!next,
        followingLatest: !cursors.length,
        previous: () => setPosition({ key: scopeKey, cursors: cursors.slice(0, -1) }),
        next: () => {
            if (next && first) setPosition({ key: scopeKey, cursors: [...(cursors.length ? cursors : [first]), next] });
        },
        restart: () => { setPosition({ key: scopeKey, cursors: [] }); read.refresh(); } };
}

type PageControls = Pick<ReturnType<typeof useFypPage>, 'index' | 'hasNext' | 'paginated' | 'loading' | 'previous' | 'next'>;

export function FypPagination({ label, page }: { label: string; page: PageControls }) {
    if (!page.paginated) return null;
    return <nav className="fyp-pagination" aria-label={label}>
        <button className="fg-button" type="button" disabled={!page.index || page.loading} onClick={page.previous}>Previous</button>
        <span role="status" aria-live="polite">{page.loading ? `Loading page ${page.index + 1}…` : `Page ${page.index + 1}`}</span>
        <button className="fg-button" type="button" disabled={!page.hasNext || page.loading} onClick={page.next}>Next</button>
    </nav>;
}

export function FypReadMessage({ label, read }: { label: string; read: { loading: boolean; error?: string; refresh: () => void } }) {
    if (read.error) return <div className="fyp-read-message" role="alert">
        <span>{label} could not be loaded. {read.error}</span>
        <button className="fg-button" type="button" onClick={read.refresh}>Retry</button>
    </div>;
    if (read.loading) return <p className="fg-muted" role="status">Loading {label.toLowerCase()}…</p>;
    return null;
}
