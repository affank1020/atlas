import { randomUUID } from "node:crypto";
import type { AtlasRepository } from "./repository.js";
import type { AtlasData, AuditEvent, AuditOperation } from "../types.js";
const now = () => new Date().toISOString();
/** Append snapshots inside the caller's unit of work, before its durable commit. */
export function appendAudit(data: AtlasData, operation: AuditOperation, client: string | undefined, projectId: string, storeId?: string, recordId?: string, previous?: unknown, resulting?: unknown, viewId?:string) { const event: AuditEvent = { id: randomUUID(), occurredAt: now(), client: client?.trim() || "unknown-client", operation, projectId, ...(storeId && { storeId }), ...(recordId && { recordId }), ...(viewId&&{viewId}), ...(previous !== undefined && { previous: structuredClone(previous) }), ...(resulting !== undefined && { resulting: structuredClone(resulting) }) }; data.auditEvents.push(event); }

/** Activity and history read this immutable source; neither owns separate event state. */
export class AuditService {
    constructor(readonly store: AtlasRepository) {}
    async history(input: { workspaceId?: string; projectId?: string; storeId?: string; recordId?: string; operation?: AuditOperation; limit?: number }) { const data = await this.store.snapshot(); const limit = Math.min(Math.max(input.limit ?? 50, 1), 200); return data.auditEvents.filter((x) => (!input.workspaceId || x.workspaceId === input.workspaceId) && (!input.projectId || x.projectId === input.projectId) && (!input.storeId || x.storeId === input.storeId) && (!input.recordId || x.recordId === input.recordId) && (!input.operation || x.operation === input.operation)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit); }
}
