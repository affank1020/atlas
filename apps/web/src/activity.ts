import type { AuditEvent } from './types';
export type ActivityCategory = 'core' | 'view' | 'node' | 'workspace' | 'files' | 'backup' | 'unity' | 'git' | 'dev' | 'error';
export type ActivityPresentation = {
    id: string; timestamp: string; client: string; projectId?: string; workspaceId?: string; workspaceName?: string;
    category: ActivityCategory; title: string; description?: string; status: 'pending' | 'completed' | 'failed';
    kind: 'inspection' | 'mutation' | 'execution' | 'failure'; attemptId?: string; details: Record<string, unknown>;
};
export const readable = (text: string) => text.replace(/[_.-]+/g, ' ').replace(/^\w/, x => x.toUpperCase());
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const lookup = <T,>(map: Record<string, T>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined;
const str = (value: unknown) => typeof value === 'string' ? value : undefined;
const unityLabels: Record<string, string> = {
    editor_play: 'Started Play Mode', editor_stop: 'Stopped Play Mode', editor_status: 'Checked Editor status',
    console: 'Read Unity console', console_status: 'Checked console status', capture_game_view: 'Captured Game View',
    capture_scene_view: 'Captured Scene View', get_component_properties: 'Read component properties',
    get_serialized_fields: 'Read serialized fields', get_performance_stats: 'Read performance stats',
};
// Adapter-specific labels live here; the feed consumes only ActivityPresentation.
const operations: Record<string, [ActivityCategory, string, ActivityPresentation['kind']]> = {
    created: ['workspace', 'Created workspace', 'mutation'], updated: ['workspace', 'Updated workspace', 'mutation'], archived: ['workspace', 'Archived workspace', 'mutation'],
    file_created: ['files', 'Created', 'mutation'], file_patched: ['files', 'Updated', 'mutation'], file_deleted: ['files', 'Deleted', 'mutation'],
    file_read: ['files', 'Read', 'inspection'], file_listed: ['files', 'Listed files', 'inspection'], files_searched: ['files', 'Searched files', 'inspection'],
    dev_invoked: ['dev', 'Ran development task', 'execution'], dev_tasks_listed: ['dev', 'Listed development tasks', 'inspection'], dev_tasks_configured: ['dev', 'Configured development tasks', 'mutation'],
    git_status: ['git', 'Checked Git status', 'inspection'], git_diff: ['git', 'Read Git diff', 'inspection'],
    unity_status: ['unity', 'Checked Unity connection', 'inspection'], unity_commands: ['unity', 'Inspected Unity commands', 'inspection'],
};
export function clientName(client: string) {
    return lookup({ chatgpt: 'ChatGPT', codex: 'Codex', claude: 'Claude' }, client.toLowerCase()) ?? client;
}
export function presentActivity(events: AuditEvent[], names: Record<string, string> = {}): ActivityPresentation[] {
    const historicalNames: Record<string, string> = {};
    for (const event of [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
        const data = object(event.resulting);
        const name = str(data.workspaceName) ?? (/^workspace\.(created|updated|archived)$/.test(event.operation) ? str(data.name) : undefined);
        if (event.workspaceId && name) historicalNames[event.workspaceId] = name;
    }
    names = { ...historicalNames, ...names };
    const groups = new Map<string, AuditEvent[]>();
    for (const event of new Map(events.map(e => [e.id, e])).values()) {
        const attempt = str(object(event.resulting).attemptId);
        const key = event.operation.startsWith('workspace.') && attempt
            ? `attempt:${event.projectId}:${event.workspaceId}:${attempt}` : event.id;
        groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    return [...groups].map(([id, group]): ActivityPresentation => {
        group.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
        // Failure evidence wins even if a later row reports success for the same attempt.
        const isFailure = (e: AuditEvent) => {
            const details = object(e.resulting);
            return e.operation.endsWith('_failed') ||
                ['failed','failed_or_uncertain','error','editor_error'].includes(str(details.outcome) ?? '') ||
                details.success === false;
        };
        const event = group.find(isFailure) ?? group.find(e => e.operation !== 'workspace.mutation_requested') ?? group[0];
        const data = { ...[...group].reverse().reduce<Record<string, unknown>>((merged, e) => ({ ...merged, ...object(e.resulting) }), {}), ...object(event.resulting) };
        const workspace = event.operation.startsWith('workspace.');
        const operation = workspace && ['workspace.mutation_requested', 'workspace.mutation_failed'].includes(event.operation)
            ? str(data.operation) ?? event.operation : event.operation;
        const suffix = operation.replace(/^workspace\./, '');
        const command = str(data.command); const path = str(data.path); const task = str(data.task); const durationMs = typeof data.durationMs === 'number' ? data.durationMs : undefined;
        const failed = event.operation.endsWith('_failed') || ['failed', 'failed_or_uncertain', 'editor_error', 'error'].includes(str(data.outcome) ?? '');
        const status = failed ? 'failed' : event.operation === 'workspace.mutation_requested' ? 'pending' : 'completed';
        let [category, title, kind] = (workspace ? lookup(operations, suffix) : undefined) ?? [workspace ? 'workspace' : event.operation.startsWith('view.') ? 'view' : event.operation.startsWith('node.') ? 'node' : event.operation.startsWith('files.') ? 'files' : event.operation.startsWith('backup.') ? 'backup' : 'core', readable(operation), workspace ? 'execution' : 'mutation'];
        if (suffix === 'unity_invoked') {
            category = 'unity'; title = command ? lookup(unityLabels, command) ?? readable(command) : 'Invoked Unity';
            kind = command && /^(get_|read_|list_|capture_|console|.*_status$)/.test(command) ? 'inspection' : 'execution';
        } else if (suffix === 'dev_invoked') { title = `${task ?? 'Development task'} · ${durationMs === undefined ? 'running' : `${(durationMs / 1000).toFixed(1)}s`}`; }
        else if (path && lookup(operations, suffix)?.[0] === 'files') title += ` ${path}`;
        else if (command) title += ` · ${readable(command)}`;
        if (status === 'pending') title = `Requested: ${title}`;
        const error = str(data.error) ?? str(object(data.error).message);
        const workspaceName = event.workspaceId ? lookup(names, event.workspaceId) ?? str(data.workspaceName) ?? (suffix === 'created' || suffix === 'updated' || suffix === 'archived' ? str(data.name) : undefined) ?? `Workspace ${event.workspaceId}` : undefined;
        return { id, timestamp: group[0].occurredAt, client: event.client || 'unknown-client', projectId: event.projectId,
            workspaceId: event.workspaceId, workspaceName, category, title, status, kind: failed ? 'failure' : kind,
            description: failed ? error ?? (suffix === 'dev_invoked' ? data.timedOut ? 'Task timed out.' : `Task exited with code ${data.exitCode ?? 'unknown'}.` : 'The operation failed; inspect the details or client response.') : undefined,
            attemptId: str(data.attemptId), details: { operation: event.operation, requestedOperation: operation,
                command, task, nodeId: data.nodeId, previousNodeId: data.previousNodeId, sourceNodeId: data.sourceNodeId, targetNodeId: data.targetNodeId,
                fileId: data.fileId, folderId: data.folderId, previousFolderId: data.previousFolderId,
                ownerKind: data.ownerKind, source: data.source, runId: data.runId,
                mode: data.mode, checked: data.checked, createdVerified: data.createdVerified,
                backupStatus: event.operation.startsWith('backup.') ? data.status : undefined,
                entireCatalogChecked: data.entireCatalogChecked, remaining: data.remaining,
                intentId: data.intentId, transport: data.transport, actorKind: data.actorKind, status: data.status,
                reportedState: data.reportedState, approved: data.approved, executable: data.executable,
                verified: data.verified, clearsClaim: data.clearsClaim, durationMs, exitCode: data.exitCode, timedOut: data.timedOut, success: data.success, stdoutTruncated: data.stdoutTruncated, stderrTruncated: data.stderrTruncated, attemptId: data.attemptId, workspace: workspaceName, workspaceId: event.workspaceId,
                projectId: event.projectId, storeId: event.storeId, recordId: event.recordId, viewId: event.viewId,
                client: event.client, outcome: data.outcome ?? status, path, error, timestamp: group[0].occurredAt,
                ...(event.id !== group[0].id && { evidenceTimestamp: event.occurredAt }),
                auditEventIds: group.map(e => e.id), previous: event.previous, resulting: event.resulting },
        };
    }).sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
}
/** Evidence labels for the safe Monitoring reader, never an authenticated-human identity. */
export type ActivityEvidenceRow = { label: string; value: string };
const evidenceUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const updateOperations = new Set([
    'node.update_intent_prepared', 'node.update_intent_cancelled',
    'node.update_intent_claimed', 'node.update_outcome_reported',
]);
const choice = (value: unknown, options: readonly string[]) =>
    typeof value === 'string' && options.includes(value) ? value : undefined;

/**
 * Separate verified server-side fields from arbitrary audit metadata.
 * The backend safeDetails allowlist is authoritative; this is only a defensive
 * presentation allowlist, not a new security boundary or a claim of identity.
 */
export function activityEvidence(item: ActivityPresentation): ActivityEvidenceRow[] {
    const details = item.details;
    const rows: ActivityEvidenceRow[] = [{ label: 'Recorded client', value: clientName(item.client) }];
    const operation = typeof details.operation === 'string' ? details.operation : '';
    const nodeControl = operation.startsWith('node.') || operation === 'workspace.node_assigned';
    const update = updateOperations.has(operation);
    const add = (label: string, value: string | undefined) => {
        if (value) rows.push({ label, value });
    };
    const safeId = (value: unknown) =>
        typeof value === 'string' && evidenceUuid.test(value) ? value.toLowerCase() : undefined;
    if (nodeControl) {
        add('Transport', choice(details.transport, ['http', 'mcp', 'server']));
        add('Credential class', choice(details.actorKind, ['transport', 'node-credential', 'enrolment-token']));
    }
    add('Node', safeId(details.nodeId));
    add('Previous Node', safeId(details.previousNodeId));
    add('Source Node', safeId(details.sourceNodeId));
    add('Target Node', safeId(details.targetNodeId));
    if (update) {
        add('Update intent', safeId(details.intentId));
        add('Intent state', choice(details.status, ['requested', 'cancelled', 'expired', 'claimed', 'reconciled']));
        add('Node-reported activation', choice(details.reportedState, ['activated', 'requires_reconciliation']));
        for (const [key, label] of [
            ['approved', 'Approved flag'], ['executable', 'Executable flag'],
            ['verified', 'Verification flag'], ['clearsClaim', 'Clears-claim flag'],
        ] as const) {
            if (typeof details[key] === 'boolean')
                rows.push({ label, value: details[key] ? 'true' : 'false' });
        }
    }
    if ((operation.startsWith('files.') && item.client === 'atlas-files-db')
        || (operation === 'backup.r2_seed_observed' && item.client === 'atlas-backup-cli')) {
        add('Recorded source', choice(details.source, ['database-trigger', 'operator-cli']));
    }
    if (operation === 'backup.r2_seed_observed' && item.client === 'atlas-backup-cli')
        add('Backup run', safeId(details.runId));
    return rows;
}

export function filterActivity(items: ActivityPresentation[], category: string, client = '', workspaceId = '') {
    return items.filter(item => (!client || clientName(item.client) === clientName(client)) && (!workspaceId || item.workspaceId === workspaceId) &&
        (!category || (category === 'error' ? item.status === 'failed' : category === 'workspace' ? !!item.workspaceId || item.category === 'workspace' : item.category === category)));
}
