import { z } from 'zod';
import type { AtlasNode } from '../nodes/model.js';

const inputSchema = z.object({}).strict();
export type MonitoringHealthState = 'healthy' | 'degraded' | 'unknown';
export type NodeHealthState = 'healthy' | 'stale' | 'offline' | 'unavailable' | 'revoked' | 'unknown';
export type DiagnosticArchiveState = 'available' | 'unavailable' | 'disabled' | 'unknown';
export type DiagnosticArchiveHealth = {
    status: DiagnosticArchiveState;
    coverage: 'incomplete-possible';
    retentionDays: 14;
    droppedSinceStart: number | null;
    queuedForWrite: number | null;
    writePaused: boolean | null;
};
export type MonitoringHealth = {
    checkedAt: string;
    overall: MonitoringHealthState;
    server: { status: 'healthy' | 'degraded'; startedAt: string; uptimeSeconds: number;
        database: { status: 'reachable' | 'unavailable'; latencyMs?: number } };
    diagnostics: DiagnosticArchiveHealth;
    nodes: { available: boolean; summary: { total: number; healthy: number; stale: number; offline: number;
        unavailable: number; revoked: number; unknown: number };
        items: Array<{ id: string; name: string; platform: string; version: string | null;
            state: NodeHealthState; lastSeen: string | null; ageSeconds: number | null }> };
};

const HEALTH_DEADLINE_MS = 2_200;
// Presentation deadline is independent of pg's query / connection timeouts.
// The dedicated health pool also bounds real pool acquisition and SQL execution,
// so a timed-out read does not leave indefinite queued database work behind.
function withinDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Health source deadline exceeded')), timeoutMs);
    });
    return Promise.race([task, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

const STALE_MS = 90_000; // Gateway closes missed heartbeats after 45 s; allow scheduling jitter.
function state(node: AtlasNode, nowMs: number): { state: NodeHealthState; ageSeconds: number | null } {
    const seenMs = node.lastSeen === null ? NaN : Date.parse(node.lastSeen);
    // Allow slight clock skew, but far-future heartbeats are not evidence of connectivity.
    const ageSeconds = Number.isFinite(seenMs) && seenMs <= nowMs + 30_000
        ? Math.max(0, Math.floor((nowMs - seenMs) / 1000)) : null;
    if (node.credentialState === 'revoked') return { state: 'revoked', ageSeconds };
    if (node.status === 'offline') return { state: 'offline', ageSeconds };
    if (node.status !== 'online') return { state: 'unavailable', ageSeconds };
    if (ageSeconds === null) return { state: 'unknown', ageSeconds };
    return { state: ageSeconds * 1000 > STALE_MS ? 'stale' : 'healthy', ageSeconds };
}

/** Read-only operational snapshot. Never returns exceptions, SQL details, connection strings or Node metadata. */
export class MonitoringHealthService {
    private readonly startedAt: string;
    constructor(
        private readonly database: { query: (sql: { text: string; query_timeout: number }) => Promise<unknown> },
        private readonly registry: { list: () => Promise<AtlasNode[]> },
        private readonly now: () => Date = () => new Date(),
        private readonly clock: () => number = () => performance.now(),
        private readonly deadlineMs = HEALTH_DEADLINE_MS,
        private readonly archive?: { status(): Promise<{
            state: 'available' | 'unavailable' | 'disabled';
            coverage: 'incomplete-possible'; retentionDays: 14;
            droppedSinceStart: number; pending: number; writePaused: boolean;
        }> },
    ) { this.startedAt = now().toISOString(); }

    async read(raw: unknown = {}): Promise<MonitoringHealth> {
        inputSchema.parse(raw);
        const checkedAt = this.now();
        const started = this.clock();
        let databaseLatencyMs: number | undefined;
        const probe = withinDeadline(
            this.database.query({ text: 'SELECT 1', query_timeout: 1_500 })
                .then(result => { databaseLatencyMs = Math.max(0, Math.round(this.clock() - started)); return result; }),
            this.deadlineMs,
        );
        // Do not await an unbounded Node directory promise during an incident.
        // In production the dedicated pool separately limits acquisition & query
        // lifetime; this deadline guarantees a conservative snapshot response.
        const directoryRead = withinDeadline(Promise.resolve().then(() => this.registry.list()), this.deadlineMs);
        const archiveRead = this.archive
            ? withinDeadline(Promise.resolve().then(() => this.archive!.status()), this.deadlineMs)
            : Promise.resolve({
                state: 'disabled' as const, coverage: 'incomplete-possible' as const,
                retentionDays: 14 as const, droppedSinceStart: 0, pending: 0, writePaused: false,
            });
        const [db, directory, archive] = await Promise.allSettled([probe, directoryRead, archiveRead]);
        const database = db.status === 'fulfilled'
            ? { status: 'reachable' as const, latencyMs: databaseLatencyMs ?? 0 }
            : { status: 'unavailable' as const };
        const items = directory.status === 'fulfilled'
            ? directory.value.map(node => ({
                id: node.id, name: node.name, platform: node.platform, version: node.version,
                lastSeen: node.lastSeen, ...state(node, checkedAt.getTime()),
            })) : [];
        const summary = { total: items.length, healthy: 0, stale: 0, offline: 0,
            unavailable: 0, revoked: 0, unknown: 0 };
        for (const node of items) summary[node.state]++;
        const diagnostics: DiagnosticArchiveHealth = archive.status === 'fulfilled'
            ? {
                status: archive.value.state, coverage: 'incomplete-possible', retentionDays: 14,
                droppedSinceStart: archive.value.droppedSinceStart,
                queuedForWrite: archive.value.pending,
                writePaused: archive.value.writePaused,
            }
            : {
                status: 'unknown', coverage: 'incomplete-possible', retentionDays: 14,
                droppedSinceStart: null, queuedForWrite: null, writePaused: null,
            };
        const nodeIssue = summary.stale + summary.offline + summary.unavailable + summary.revoked > 0;
        const overall: MonitoringHealthState = database.status === 'unavailable' || nodeIssue
            ? 'degraded' : directory.status === 'rejected' || summary.unknown > 0
                || diagnostics.status === 'unavailable' || diagnostics.status === 'unknown'
                || diagnostics.writePaused === true || (diagnostics.droppedSinceStart ?? 0) > 0
                ? 'unknown' : 'healthy';
        return {
            checkedAt: checkedAt.toISOString(), overall,
            server: { status: database.status === 'reachable' ? 'healthy' : 'degraded',
                startedAt: this.startedAt, uptimeSeconds: Math.max(0, Math.floor((checkedAt.getTime() - Date.parse(this.startedAt)) / 1000)),
                database },
            diagnostics,
            nodes: { available: directory.status === 'fulfilled', summary, items },
        };
    }
}
