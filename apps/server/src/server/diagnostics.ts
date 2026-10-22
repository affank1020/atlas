import { z } from 'zod';

/**
 * Only fixed, non-sensitive operational facts enter this ring.
 * NEVER pass exception messages, request arguments, credentials, URLs, paths
 * or request identifiers into a diagnostic entry.
 */
export type ServerDiagnosticCode = 'server_initialised' | 'tool_request_failed' | 'background_task_failed';
export type ServerDiagnosticEvent = { at: string; code: ServerDiagnosticCode; level: 'info' | 'warning' };
const MAX_EVENTS = 200;
const readSchema = z.object({ limit: z.number().int().min(1).max(100).default(30) }).strict();
const label: Record<ServerDiagnosticCode, { level: 'info' | 'warning'; message: string }> = {
    server_initialised: { level: 'info', message: 'Server runtime initialised' },
    tool_request_failed: { level: 'warning', message: 'Application operation failed (inspect Activity for scoped details)' },
    background_task_failed: { level: 'warning', message: 'Background operation failed' },
};

export class ServerDiagnostics {
    private readonly entries: ServerDiagnosticEvent[] = [];
    private readonly startedAt: string;
    private discarded = 0;
    constructor(private readonly enabled = true, private readonly now: () => Date = () => new Date()) {
        this.startedAt = now().toISOString();
    }
    record(code: ServerDiagnosticCode): void {
        if (!this.enabled) return;
        const event: ServerDiagnosticEvent = { at: this.now().toISOString(), code, level: label[code].level };
        this.entries.push(event);
        if (this.entries.length > MAX_EVENTS) { this.entries.shift(); this.discarded++; }
    }
    read(raw: unknown = {}) {
        const { limit } = readSchema.parse(raw);
        return {
            source: 'atlas-server-process' as const,
            available: this.enabled,
            startedAt: this.startedAt,
            // Old container stdout/stderr, other replicas and previous process
            // lifetimes are explicitly not covered by this in-memory source.
            retention: 'current-process' as const,
            events: this.enabled ? this.entries.slice(-limit).reverse().map(event => ({
                ...event, message: label[event.code].message,
            })) : [],
            truncated: this.enabled && (this.discarded > 0 || this.entries.length > limit),
        };
    }
}
