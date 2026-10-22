import { randomUUID } from "node:crypto";
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
        if (this.store.queryMonitoringActivity) return this.store.queryMonitoringActivity(query);
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
        return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
    }
    async history(input: { workspaceId?: string; projectId?: string; storeId?: string; recordId?: string; operation?: AuditOperation; limit?: number }) { const limit = Math.min(Math.max(input.limit ?? 50, 1), 200); if (this.store.readAudit) return this.store.readAudit({ ...input, limit }); const data = await this.store.snapshot(); return data.auditEvents.filter((x) => (!input.workspaceId || x.workspaceId === input.workspaceId) && (!input.projectId || x.projectId === input.projectId) && (!input.storeId || x.storeId === input.storeId) && (!input.recordId || x.recordId === input.recordId) && (!input.operation || x.operation === input.operation)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit); }
}
