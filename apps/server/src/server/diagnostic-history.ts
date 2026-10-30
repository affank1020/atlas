import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { serverDiagnosticDescription, type ServerDiagnosticEvent } from './diagnostics.js';

// The archive stores only the already-allowlisted code, timestamp and random process ID.
// It is not a container log collector or a guaranteed audit trail. The queue is bounded,
// inserts never block tool dispatch, and failed writes are reported as missing coverage.
const inputSchema = z.object({ limit: z.number().int().min(1).max(100).default(30) }).strict();
const MAX_PENDING = 128;
const BATCH_SIZE = 32;
const BACKOFF_MS = 30_000;
const RETENTION_DAYS = 14;

type DiagnosticRow = { occurred_at: Date | string; code: string };
type DiagnosticDatabase = {
    query: (text: string, values?: unknown[]) => Promise<{ rows: DiagnosticRow[] }>;
};

export class ServerDiagnosticHistory {
    private readonly instanceId = randomUUID();
    private readonly pending: ServerDiagnosticEvent[] = [];
    private writing: Promise<void> | undefined;
    private pausedUntil = 0;
    private writesSincePrune = 0;
    private dropped = 0;
    private stopped = false;

    constructor(private readonly database: DiagnosticDatabase, private readonly enabled = true,
        private readonly clock: () => number = () => Date.now()) {}

    record(event: ServerDiagnosticEvent): void {
        if (!this.enabled || this.stopped) return;
        if (this.clock() < this.pausedUntil || this.pending.length >= MAX_PENDING) {
            this.dropped++;
            return;
        }
        this.pending.push(event);
        if (!this.writing) this.startWriting();
    }

    private startWriting(): void {
        const job = this.writePending();
        this.writing = job;
        void job.finally(() => {
            if (this.writing !== job) return;
            this.writing = undefined;
            if (this.pending.length) this.startWriting();
        });
    }

    private async writePending(): Promise<void> {
        while (this.pending.length) {
            const batch = this.pending.splice(0, BATCH_SIZE);
            try {
                await this.database.query(
                    'INSERT INTO atlas_server_diagnostic_events (occurred_at, instance_id, code) ' +
                    'SELECT * FROM UNNEST($1::timestamptz[], $2::uuid[], $3::text[])',
                    [batch.map(e => e.at), batch.map(() => this.instanceId), batch.map(e => e.code)],
                );
                this.writesSincePrune += batch.length;
                if (this.writesSincePrune >= 128) {
                    this.writesSincePrune = 0;
                    // Incremental deletion limits lock time and query pressure. The
                    // reader separately enforces the age window before returning rows.
                    await this.database.query(
                        'DELETE FROM atlas_server_diagnostic_events WHERE id IN ' +
                        '(SELECT id FROM atlas_server_diagnostic_events ' +
                        "WHERE occurred_at < NOW() - INTERVAL '14 days' ORDER BY occurred_at LIMIT 1000)",
                    ).catch(() => undefined);
                }
            } catch {
                this.dropped += batch.length + this.pending.length;
                this.pending.length = 0;
                this.pausedUntil = this.clock() + BACKOFF_MS;
                break;
            }
        }
    }

    async flush(): Promise<void> {
        await this.writing;
    }

    async close(): Promise<void> {
        this.stopped = true;
        await this.flush();
    }

    async read(raw: unknown = {}) {
        const { limit } = inputSchema.parse(raw);
        const baseline = {
            source: 'atlas-server-history' as const,
            retention: 'best-effort' as const,
            retentionDays: RETENTION_DAYS,
            // A prior process could have lost inserts. Only current-process
            // missed writes can be counted; never imply complete historical coverage.
            droppedSinceStart: this.dropped,
            coverage: 'incomplete-possible' as const,
        };
        if (!this.enabled) return { ...baseline, available: false, truncated: false, events: [] };
        try {
            const result = await this.database.query(
                'SELECT occurred_at, code FROM atlas_server_diagnostic_events ' +
                "WHERE occurred_at >= NOW() - INTERVAL '14 days' " +
                'ORDER BY occurred_at DESC, id DESC LIMIT $1',
                [limit + 1],
            );
            const events = result.rows.slice(0, limit).flatMap(row => {
                const description = serverDiagnosticDescription(row.code);
                if (!description) return [];
                const at = new Date(row.occurred_at);
                if (!Number.isFinite(at.getTime())) return [];
                return [{ at: at.toISOString(), code: row.code, ...description }];
            });
            return { ...baseline, available: true, truncated: result.rows.length > limit, events };
        } catch {
            // Never reveal connection strings, SQL or exception details.
            return { ...baseline, available: false, truncated: false, events: [] };
        }
    }
}
