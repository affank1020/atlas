import type { AuditEvent } from '../types.js';

/**
 * The Monitoring UI needs only operational markers, not stored before/after
 * snapshots. This opt-in, bounded projection keeps the immutable audit source
 * and legacy history contracts unchanged.
 *
 * Treat EVERY value inside resulting as untrusted. No recursive traversal,
 * arbitrary keys, raw errors, stdout, paths or structured snapshots.
 */
const reference = /^[a-zA-Z0-9._:-]{1,80}$/;
const action = /^[a-z][a-z0-9_]{0,63}$/;
const workspaceOperation = /^workspace\.[a-z][a-z0-9_]{0,63}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowedOutcomes = new Set(['completed', 'pending', 'failed', 'failed_or_uncertain', 'error', 'editor_error', 'success']);
const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function safeValue(key: string, value: unknown): string | number | boolean | undefined {
    switch (key) {
        case 'attemptId': return typeof value === 'string' && reference.test(value) ? value : undefined;
        case 'nodeId': case 'previousNodeId': case 'sourceNodeId': case 'targetNodeId':
            return typeof value === 'string' && uuid.test(value) ? value : undefined;
        case 'operation': return typeof value === 'string' && workspaceOperation.test(value) ? value : undefined;
        case 'task': case 'command': return typeof value === 'string' && action.test(value) ? value : undefined;
        case 'outcome': return typeof value === 'string' && allowedOutcomes.has(value) ? value : undefined;
        case 'durationMs': return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86400000 ? value : undefined;
        case 'exitCode': return typeof value === 'number' && Number.isInteger(value) && value >= -255 && value <= 255 ? value : undefined;
        case 'timedOut': case 'success': case 'stdoutTruncated': case 'stderrTruncated':
            return typeof value === 'boolean' ? value : undefined;
        default: return undefined;
    }
}
const safeKeys = ['attemptId', 'nodeId', 'previousNodeId', 'sourceNodeId', 'targetNodeId',
    'operation', 'task', 'command', 'outcome', 'durationMs', 'exitCode',
    'timedOut', 'success', 'stdoutTruncated', 'stderrTruncated'] as const;

export function projectMonitoringEvent(event: AuditEvent): AuditEvent {
    const source = record(event.resulting);
    const resulting: Record<string, string | number | boolean> = {};
    for (const key of safeKeys) {
        const sanitized = safeValue(key, source[key]);
        if (sanitized !== undefined) resulting[key] = sanitized;
    }
    // Explicit top-level projection. Never spread an arbitrary audit event,
    // including its previous/resulting snapshots or future added fields.
    return {
        id: event.id, occurredAt: event.occurredAt, client: event.client,
        operation: event.operation, ...(event.projectId && { projectId: event.projectId }),
        ...(event.storeId && { storeId: event.storeId }),
        ...(event.recordId && { recordId: event.recordId }),
        ...(event.viewId && { viewId: event.viewId }),
        ...(event.workspaceId && { workspaceId: event.workspaceId }),
        resulting,
    };
}
