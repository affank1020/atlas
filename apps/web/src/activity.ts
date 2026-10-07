import type { AuditEvent } from './types';
export type ActivityCategory = 'core' | 'view' | 'workspace' | 'files' | 'unity' | 'git' | 'dev' | 'error';
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
        const event = group.find(e => e.operation !== 'workspace.mutation_requested') ?? group[0];
        const data = { ...[...group].reverse().reduce<Record<string, unknown>>((merged, e) => ({ ...merged, ...object(e.resulting) }), {}), ...object(event.resulting) };
        const workspace = event.operation.startsWith('workspace.');
        const operation = workspace && ['workspace.mutation_requested', 'workspace.mutation_failed'].includes(event.operation)
            ? str(data.operation) ?? event.operation : event.operation;
        const suffix = operation.replace(/^workspace\./, '');
        const command = str(data.command); const path = str(data.path); const task = str(data.task); const durationMs = typeof data.durationMs === 'number' ? data.durationMs : undefined;
        const failed = event.operation.endsWith('_failed') || ['failed', 'failed_or_uncertain', 'editor_error', 'error'].includes(str(data.outcome) ?? '');
        const status = failed ? 'failed' : event.operation === 'workspace.mutation_requested' ? 'pending' : 'completed';
        let [category, title, kind] = (workspace ? lookup(operations, suffix) : undefined) ?? [workspace ? 'workspace' : event.operation.startsWith('view.') ? 'view' : 'core', readable(operation), workspace ? 'execution' : 'mutation'];
        if (suffix === 'unity_invoked') {
            category = 'unity'; title = command ? lookup(unityLabels, command) ?? readable(command) : 'Invoked Unity';
            kind = command && /^(get_|read_|list_|capture_|console|.*_status$)/.test(command) ? 'inspection' : 'execution';
        } else if (suffix === 'dev_invoked') { title = `${task ?? 'Development task'} · ${durationMs === undefined ? 'running' : `${(durationMs / 1000).toFixed(1)}s`}`; }
        else if (path && lookup(operations, suffix)?.[0] === 'files') title += ` ${path}`;
        else if (command) title += ` · ${readable(command)}`;
        if (status === 'pending') title = `Requested: ${title}`;
        const error = str(data.error) ?? str(object(data.error).message);
        const workspaceName = event.workspaceId ? lookup(names, event.workspaceId) ?? str(data.workspaceName) ?? (suffix === 'created' || suffix === 'updated' || suffix === 'archived' ? str(data.name) : undefined) ?? 'Unknown workspace' : undefined;
        return { id, timestamp: event.occurredAt, client: event.client || 'unknown-client', projectId: event.projectId,
            workspaceId: event.workspaceId, workspaceName, category, title, status, kind: failed ? 'failure' : kind,
            description: failed ? error ?? (suffix === 'dev_invoked' ? data.timedOut ? 'Task timed out.' : `Task exited with code ${data.exitCode ?? 'unknown'}.` : 'The operation failed; inspect the details or client response.') : undefined,
            attemptId: str(data.attemptId), details: { operation: event.operation, requestedOperation: operation,
                command, task, nodeId: data.nodeId, durationMs, exitCode: data.exitCode, timedOut: data.timedOut, success: data.success, stdoutTruncated: data.stdoutTruncated, stderrTruncated: data.stderrTruncated, attemptId: data.attemptId, workspace: workspaceName, workspaceId: event.workspaceId,
                projectId: event.projectId, storeId: event.storeId, recordId: event.recordId, viewId: event.viewId,
                client: event.client, outcome: data.outcome ?? status, path, error, timestamp: event.occurredAt,
                auditEventIds: group.map(e => e.id), previous: event.previous, resulting: event.resulting },
        };
    }).sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
}
export function filterActivity(items: ActivityPresentation[], category: string, client = '', workspaceId = '') {
    return items.filter(item => (!client || clientName(item.client) === clientName(client)) && (!workspaceId || item.workspaceId === workspaceId) &&
        (!category || (category === 'error' ? item.status === 'failed' : category === 'workspace' ? !!item.workspaceId || item.category === 'workspace' : item.category === category)));
}
