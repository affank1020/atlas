/** Opt-in durations only: never log arguments, SQL text, identifiers or payloads. */
export async function timed<T>(operation: string, run: () => Promise<T>): Promise<T> {
    if (process.env.ATLAS_PERFORMANCE !== '1') return run();
    const start = performance.now();
    let ok = false;
    try { const result = await run(); ok = true; return result; }
    finally { console.info(JSON.stringify({ component: 'atlas-performance', operation, durationMs: Math.round((performance.now() - start) * 100) / 100, ok })); }
}
