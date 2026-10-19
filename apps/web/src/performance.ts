import { useEffect, useRef } from 'react';

let routeKey: string | undefined;
let routeStart: number | undefined;
export function beginRoute(key: string) {
    if (routeKey !== key) { routeKey = key; routeStart = performance.now(); }
}

/** Inspect with performance.getEntriesByType('measure') in DevTools. No route IDs. */
export function useRouteTiming(kind: string, key: string, ready: boolean) {
    const state = useRef({ key, start: routeStart ?? performance.now(), measured: false });
    if (state.current.key !== key) state.current = { key, start: routeStart ?? performance.now(), measured: false };
    useEffect(() => {
        if (!ready || state.current.measured) return;
        state.current.measured = true;
        performance.measure(`atlas:route:${kind}`, { start: state.current.start, end: performance.now() });
    }, [kind, key, ready]);
}

export const diagnostics = { networkRequests: 0, cacheReuses: 0, queryStarts: 0 };
if (import.meta.env.DEV) Object.assign(window, { atlasPerformance: diagnostics });
