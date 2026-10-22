import { randomUUID } from "node:crypto";
import { projectMonitoringEvent } from './monitoring-projection.js';
import type { AtlasRepository, MonitoringActivityQuery, MonitoringActivityPage } from "./repository.js";
import type { AtlasData, AuditEvent, AuditOperation } from "../types.js";
const now = () => new Date().toISOString();
/** Append snapshots inside the caller's unit of work, before its durable commit. */
export function appendAudit(data: AtlasData, operation: AuditOperation, client: string | undefined, projectId: string, storeId?: string, recordId?: string, previous?: unknown, resulting?: unknown, viewId?:string) { const event: AuditEvent = { id: randomUUID(), occurredAt: now(), client: client?.trim() || "unknown-client", operation, projectId, ...(storeId && { storeId }), ...(recordId && { recordId }), ...(viewId&&{viewId}), ...(previous !== undefined && { previous: structuredClone(previous) }), ...(resulting !== undefined && { resulting: structuredClone(resulting) }) }; data.auditEvents.push(event); }

/** Activity and history read this immutable source; neither owns separate event state. */
export class AuditService {
    constructor(readonly store: AtlasRepository) {}
    async monitoring(input: MonitoringActivityQuery): Promise<MonitoringActivityPage> {
        const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
        const offset = Math.min(Math.max(input.offset ?? 0, 0), 10000);
        const query = { ...input, limit, offset };
        const project = (page: MonitoringActivityPage): MonitoringActivityPage => input.safeDetails
            ? { ...page, items: page.items.map(projectMonitoringEvent) } : page;
        if (this.store.queryMonitoringActivity) return project(await this.store.queryMonitoringActivity(query));
        // A JSON fixture has no authoritative logical Workspace ↔ checkout map.
        // Reject rather than silently return unscoped or misleading activity.
        if (input.logicalWorkspaceId) throw new Error(
            'Logical Workspace activity requires PostgreSQL checkout associations.');
        // The JSON fixture adapter must keep the same filter semantics as PostgreSQL.
        const data = await this.store.snapshot();
        const category = (operation: string) => {
            if (operation.startsWith('view.')) return 'view';
            if (operation.startsWith('node.')) return 'node';
            if (operation.startsWith('workspace.git_')) return 'git';
            if (operation.startsWith('workspace.dev_')) return 'dev';
            if (operation.startsWith('workspace.unity_')) return 'unity';
            if (operation.startsWith('workspace.file_') || operation === 'workspace.files_searched') return 'files';
            if (operation.startsWith('workspace.')) return 'workspace';
            return 'core';
        };
        const failed = (event: AuditEvent) => {
            const details = event.resulting && typeof event.resulting === 'object' ? event.resulting as Record<string, unknown> : {};
            return event.operation.endsWith('_failed') || ['failed', 'failed_or_uncertain', 'error', 'editor_error'].includes(String(details.outcome ?? '')) || details.success === false;
        };

        if (input.groupOperations) {
            const key = (event: AuditEvent) => {
                const details = event.resulting && typeof event.resulting === 'object' ? event.resulting as Record<string, unknown> : {};
                const attempt = typeof details.attemptId === 'string' ? details.attemptId : '';
                return event.operation.startsWith('workspace.') && attempt
                    ? `attempt:${event.projectId ?? ''}:${event.workspaceId ?? ''}:${attempt}` : `event:${event.id}`;
            };
            const groups = new Map<string, AuditEvent[]>();
            // Scope the immutable source before grouping, but apply contextual
            // search/category/outcome filters only to fully correlated operations.
            for (const event of data.auditEvents) {
                if (input.projectId && event.projectId !== input.projectId) continue;
                if (input.workspaceId && event.workspaceId !== input.workspaceId) continue;
                if (input.checkoutId && event.workspaceId !== input.checkoutId) continue;
                if (input.client && event.client.toLowerCase() !== input.client.toLowerCase()) continue;
                const id = key(event);
                groups.set(id, [...(groups.get(id) ?? []), event]);
            }
            const operationName = (event: AuditEvent) => {
                const details = event.resulting && typeof event.resulting === 'object' ? event.resulting as Record<string, unknown> : {};
                const original = details.operation;
                return ['workspace.mutation_requested', 'workspace.mutation_failed'].includes(event.operation)
                    && typeof original === 'string' && /^workspace[.][a-z][a-z0-9_]*$/.test(original)
                    ? original : event.operation;
            };
            const matching = [...groups].filter(([, events]) => {
                const latest = [...events].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))[0];
                const any = (predicate: (event: AuditEvent, details: Record<string, unknown>) => boolean) =>
                    events.some(event => predicate(event, event.resulting && typeof event.resulting === 'object' ? event.resulting as Record<string, unknown> : {}));
                const groupFailed = events.some(failed);
                const outcome = groupFailed ? 'failed' : events.some(event => event.operation !== 'workspace.mutation_requested') ? 'completed' : 'pending';
                const search = input.search?.trim().toLowerCase();
                return (!input.outcome || input.outcome === outcome)
                    && (!input.from || latest.occurredAt >= input.from)
                    && (!input.to || latest.occurredAt <= input.to)
                    && (!input.storeId || any(event => event.storeId === input.storeId))
                    && (!input.recordId || any(event => event.recordId === input.recordId))
                    && (!input.nodeId || any((event, d) => d.nodeId === input.nodeId || d.previousNodeId === input.nodeId
                        || (['node.share.approved', 'node.share.revoked'].includes(event.operation)
                            && ([d.sourceNodeId, d.targetNodeId] as unknown[]).some(value => String(value ?? '').toLowerCase() === input.nodeId!.toLowerCase()))))
                    && (!input.operation || any(event => event.operation === input.operation || operationName(event) === input.operation))
                    && (!input.category || any(event => category(operationName(event)) === input.category))
                    && (!search || any((event, d) => [event.operation, event.client, d.error, d.task]
                        .some(value => String(value ?? '').toLowerCase().includes(search))));
            }).sort(([keyA, a], [keyB, b]) =>
                Math.max(...b.map(e => Date.parse(e.occurredAt))) - Math.max(...a.map(e => Date.parse(e.occurredAt)))
                || keyB.localeCompare(keyA));
            const page = matching.slice(offset, offset + limit);
            return project({ items: page.flatMap(([, events]) => {
                const representatives = new Map<string, AuditEvent>();
                for (const event of [...events].sort((a, b) =>
                    b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))) {
                    const kind = failed(event) ? 'failed' :
                        event.operation === 'workspace.mutation_requested' ? 'requested' : 'result';
                    if (!representatives.has(kind)) representatives.set(kind, event);
                }
                return [...representatives.values()].sort((a, b) =>
                    b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
            }), total: matching.length, offset, limit });
        }
        const items = data.auditEvents.filter(event => {
            const details = event.resulting && typeof event.resulting === 'object' ? event.resulting as Record<string, unknown> : {};
            const pending = event.operation === 'workspace.mutation_requested';
            const original = details.operation;
            const categorisedOperation =
                (pending || event.operation === 'workspace.mutation_failed')
                && typeof original === 'string'
                && /^workspace[.][a-z][a-z0-9_]*$/.test(original)
                    ? original : event.operation;
            const outcome = failed(event) ? 'failed' : pending ? 'pending' : 'completed';
            const search = String(input.search ?? '').toLowerCase();
            return (!input.projectId || event.projectId === input.projectId)
                && (!input.workspaceId || event.workspaceId === input.workspaceId)
                && (!input.checkoutId || event.workspaceId === input.checkoutId)
                && (!input.storeId || event.storeId === input.storeId)
                && (!input.recordId || event.recordId === input.recordId)
                && (!input.nodeId || details.nodeId === input.nodeId || details.previousNodeId === input.nodeId
                    || (['node.share.approved', 'node.share.revoked'].includes(event.operation)
                        && (String(details.sourceNodeId ?? '').toLowerCase() === input.nodeId.toLowerCase()
                            || String(details.targetNodeId ?? '').toLowerCase() === input.nodeId.toLowerCase())))
                && (!input.operation || event.operation === input.operation)
                && (!input.category || category(categorisedOperation) === input.category)
                && (!input.client || event.client.toLowerCase() === input.client.toLowerCase())
                && (!input.outcome || outcome === input.outcome)
                && (!input.from || event.occurredAt >= input.from)
                && (!input.to || event.occurredAt <= input.to)
                && (!search || [event.operation, event.client, details.error, details.task].some(value => String(value ?? '').toLowerCase().includes(search)));
        }).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
        return project({ items: items.slice(offset, offset + limit), total: items.length, offset, limit });
    }
    async history(input: { workspaceId?: string; projectId?: string; storeId?: string; recordId?: string; operation?: AuditOperation; limit?: number }) { const limit = Math.min(Math.max(input.limit ?? 50, 1), 200); if (this.store.readAudit) return this.store.readAudit({ ...input, limit }); const data = await this.store.snapshot(); return data.auditEvents.filter((x) => (!input.workspaceId || x.workspaceId === input.workspaceId) && (!input.projectId || x.projectId === input.projectId) && (!input.storeId || x.storeId === input.storeId) && (!input.recordId || x.recordId === input.recordId) && (!input.operation || x.operation === input.operation)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit); }
}
