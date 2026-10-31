import type { AuditEvent } from '../types.js';

/**
 * Safe *read projection* for Monitoring. The immutable audit record is never
 * modified; legacy history/revision endpoints retain their existing contract.
 * An explicit allowlist is safer than trying to redact arbitrary nested state.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const attempt = /^[A-Za-z0-9_-]{1,128}$/;
const operation = /^workspace[.][a-z][a-z0-9_]{0,90}$/;
const simpleName = /^[A-Za-z0-9_-]{1,80}$/;
const outcomes = new Set(['completed', 'pending', 'failed', 'failed_or_uncertain', 'error', 'editor_error', 'cancelled', 'timed_out']);

function safeMetadata(input: unknown, eventOperation: string): Record<string, string | number | boolean> | undefined {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const source = input as Record<string, unknown>;
    const output: Record<string, string | number | boolean> = {};
    const strings: Array<[string, RegExp]> = [
        ['attemptId', attempt], ['operation', operation],
        ['nodeId', uuid], ['previousNodeId', uuid], ['sourceNodeId', uuid], ['targetNodeId', uuid],
        ['task', simpleName], ['command', simpleName],
    ];
    for (const [key, pattern] of strings) {
        const value = source[key];
        if (typeof value === 'string' && pattern.test(value)) output[key] = value;
    }
    if (typeof source.outcome === 'string' && outcomes.has(source.outcome)) output.outcome = source.outcome;
    // Transport labels are meaningful only on trusted Node-control writers.
    // Other audit producers may store arbitrary fields with the same names:
    // never launder them into what looks like authenticated provenance.
    const nodeControl = eventOperation.startsWith('node.') || eventOperation === 'workspace.node_assigned';
    const updateOperation = ['node.update_intent_prepared', 'node.update_intent_cancelled',
        'node.update_intent_claimed', 'node.update_outcome_reported'].includes(eventOperation);
    if (nodeControl) {
        const fixed = {
            transport: ['http', 'mcp', 'server'],
            actorKind: ['transport', 'node-credential', 'enrolment-token'],
        } as const;
        for (const [key, allowed] of Object.entries(fixed)) {
            const value = source[key];
            if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) output[key] = value;
        }
    }
    if (updateOperation) {
        if (typeof source.intentId === 'string' && uuid.test(source.intentId)) output.intentId = source.intentId;
        const fixed = {
            status: ['requested', 'cancelled', 'expired', 'claimed', 'reconciled'],
            reportedState: ['activated', 'requires_reconciliation'],
        } as const;
        for (const [key, allowed] of Object.entries(fixed)) {
            const value = source[key];
            if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) output[key] = value;
        }
        for (const key of ['approved', 'executable', 'verified', 'clearsClaim'] as const) {
            if (typeof source[key] === 'boolean') output[key] = source[key];
        }
    }
    if (typeof source.durationMs === 'number' && Number.isFinite(source.durationMs)
        && source.durationMs >= 0 && source.durationMs <= 86_400_000) output.durationMs = source.durationMs;
    if (typeof source.exitCode === 'number' && Number.isInteger(source.exitCode)
        && source.exitCode >= -128 && source.exitCode <= 255) output.exitCode = source.exitCode;
    for (const key of ['success', 'timedOut', 'stdoutTruncated', 'stderrTruncated'] as const) {
        if (typeof source[key] === 'boolean') output[key] = source[key];
    }
    return Object.keys(output).length ? output : undefined;
}

export function projectMonitoringEvent(event: AuditEvent): AuditEvent {
    // Never copy before-state, and never forward arbitrary after-state such as
    // record fields, stdout/stderr, paths, errors or credential material.
    const { previous: _previous, resulting, ...safe } = event;
    const metadata = safeMetadata(resulting, event.operation);
    return metadata ? { ...safe, resulting: metadata } : safe;
}
