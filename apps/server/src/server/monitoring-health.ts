import { z } from 'zod';
import type { AtlasNode } from '../nodes/model.js';

const inputSchema = z.object({}).strict();
export type MonitoringHealthState = 'healthy' | 'degraded' | 'unknown';
export type NodeHealthState = 'healthy' | 'stale' | 'offline' | 'unavailable' | 'revoked' | 'unknown';
export type MonitoringHealth = {
    checkedAt: string;
    overall: MonitoringHealthState;
    server: { status: 'healthy' | 'degraded'; startedAt: string; uptimeSeconds: number;
        database: { status: 'reachable' | 'unavailable'; latencyMs?: number } };
    nodes: { available: boolean; summary: { total: number; healthy: number; stale: number; offline: number;
        unavailable: number; revoked: number; unknown: number };
        items: Array<{ id: string; name: string; platform: string; version: string | null;
            state: NodeHealthState; lastSeen: string | null; ageSeconds: number | null }> };
};

const STALE_MS = 90_000; // Gateway closes missed heartbeats after 45 s; allow scheduling jitter.
function state(node: AtlasNode, nowMs: number): { state: NodeHealthState; ageSeconds: number | null } {
    const seenMs = node.lastSeen === null ? NaN : Date.parse(node.lastSeen);
    const ageSeconds = Number.isFinite(seenMs) ? Math.max(0, Math.floor((nowMs - seenMs) / 1000)) : null;
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
    ) { this.startedAt = now().toISOString(); }

    async read(raw: unknown = {}): Promise<MonitoringHealth> {
        inputSchema.parse(raw);
        const checkedAt = this.now();
        const started = this.clock();
        let databaseLatencyMs: number | undefined;
        const probe = this.database.query({ text: 'SELECT 1', query_timeout: 2_000 })
            .then(result => { databaseLatencyMs = Math.max(0, Math.round(this.clock() - started)); return result; });
        const [db, directory] = await Promise.allSettled([probe, this.registry.list()]);
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
        const nodeIssue = summary.stale + summary.offline + summary.unavailable + summary.revoked > 0;
        const overall: MonitoringHealthState = database.status === 'unavailable' || nodeIssue
            ? 'degraded' : directory.status === 'rejected' || summary.unknown > 0 ? 'unknown' : 'healthy';
        return {
            checkedAt: checkedAt.toISOString(), overall,
            server: { status: database.status === 'reachable' ? 'healthy' : 'degraded',
                startedAt: this.startedAt, uptimeSeconds: Math.max(0, Math.floor((checkedAt.getTime() - Date.parse(this.startedAt)) / 1000)),
                database },
            nodes: { available: directory.status === 'fulfilled', summary, items },
        };
    }
}
