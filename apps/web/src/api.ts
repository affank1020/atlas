const API_BASE = (import.meta.env.VITE_ATLAS_API_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:3000" : window.location.origin)).replace(/\/$/, "");

class ToolRequestError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

export type ToolMutation = { name: string; input: Record<string, unknown> };
const mutationListeners = new Set<(mutation: ToolMutation) => void>();
const MUTATION = /^(create_|update_|archive_|delete_|save_|publish_|unpublish_|bulk_|patch_|upsert_|configure_|execute_view_action$)/;
let toolRequestCount = 0;

/** Counts actual HTTP tool requests, including failed attempts. */
export const getToolRequestCount = () => toolRequestCount;

/** Low-level transport. RTK Query owns caching for migrated reads. */
export async function callTool<T>(name: string, input: Record<string, unknown> = {}, signal?: AbortSignal, notifyMutation = true): Promise<T> {
    const timeoutMs = name === "workspace_run_dev_task" ? 660_000 : ["football_validate_python", "football_validate_editor_gates", "football_validate_physics_smoke"].includes(name) ? 210_000 : name === "ask_atlas" || name === "ask_portfolio" ? 240_000 : name === "football_index_policy" ? 70_000 : 30_000;
    let response: Response;
    try {
        toolRequestCount++;
        response = await fetch(`${API_BASE}/api/tools/${name}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-atlas-client": "Atlas Web" },
            body: JSON.stringify(input),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") throw new Error(`Atlas timed out after ${timeoutMs / 1000} seconds at ${API_BASE}.`);
        if (signal?.aborted) throw error;
        throw new Error(`Atlas is unreachable at ${API_BASE}. Start the Atlas Server and try again.`);
    }
    const body = await response.json().catch(() => undefined) as { message?: string; error?: string } | undefined;
    if (!response.ok) throw new ToolRequestError(body?.message ?? body?.error ?? `Atlas returned HTTP ${response.status}.`, response.status);
    if (notifyMutation && MUTATION.test(name)) mutationListeners.forEach(listener => listener({ name, input }));
    return body as T;
}

/** Lets direct, not-yet-migrated writes invalidate the matching RTK queries. */
export function onToolMutation(listener: (mutation: ToolMutation) => void): () => void {
    mutationListeners.add(listener);
    return () => { mutationListeners.delete(listener); };
}

export async function callAskAgent<T>(name: "ask_atlas" | "ask_portfolio", input: Record<string, unknown>, model: string): Promise<{ response: T; modelFieldAccepted: boolean }> {
    try {
        return { response: await callTool<T>(name, { ...input, model }), modelFieldAccepted: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unsupportedModelField = (error instanceof ToolRequestError && [400, 422].includes(error.status)) &&
            (/model/i.test(message) && /(unknown|unrecognized|unexpected|unsupported|additional|invalid)/i.test(message));
        if (!unsupportedModelField) throw error;
        return { response: await callTool<T>(name, input), modelFieldAccepted: false };
    }
}

export const callAskAtlas = <T>(input: Record<string, unknown>, model: string) => callAskAgent<T>("ask_atlas", input, model);
export { API_BASE };
