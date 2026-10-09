const API_BASE = (import.meta.env.VITE_ATLAS_API_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:3000" : window.location.origin)).replace(/\/$/, "");

class ToolRequestError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

export async function callTool<T>(name: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const timeoutMs = name === "workspace_run_dev_task" ? 660_000 : name === "ask_atlas" || name === "ask_portfolio" ? 240_000 : 30_000;
    let response: Response;
    try {
        response = await fetch(`${API_BASE}/api/tools/${name}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-atlas-client": "Atlas Web" },
            body: JSON.stringify(input),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") throw new Error(`Atlas timed out after ${timeoutMs / 1000} seconds at ${API_BASE}.`);
        throw new Error(`Atlas is unreachable at ${API_BASE}. Start the Atlas Server and try again.`);
    }
    const body = await response.json().catch(() => undefined) as { message?: string; error?: string } | undefined;
    if (!response.ok) throw new ToolRequestError(body?.message ?? body?.error ?? `Atlas returned HTTP ${response.status}.`, response.status);
    return body as T;
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
