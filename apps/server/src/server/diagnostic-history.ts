import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { serverDiagnosticDescription, type ServerDiagnosticEvent } from './diagnostics.js';

// The archive stores only the already-allowlisted code, timestamp and random process ID.
// It is not a container log collector or a guaranteed audit trail. The queue is bounded,
// inserts never block tool dispatch, and failed writes are reported as missing coverage.
const inputSchema = z.object({
    limit: z.number().int().min(1).max(100).default(30),
    cursor: z.string().min(1).max(160).optional(),
}).strict();
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[1-9]\d{0,18}$/;
const MAX_PG_BIGINT = 9223372036854775807n;

/** Opaque continuation is strictly validated, but is not a security credential.
 * The timestamp is kept at PostgreSQL microsecond precision so equal-millisecond
 * events do not disappear between pages. All cursor components become SQL values. */
function cursorFor(row: DiagnosticRow): string {
    const at = row.cursor_at;
    const id = String(row.id ?? '');
    if (typeof at !== 'string' || !CURSOR_AT.test(at) || !Number.isFinite(Date.parse(at))
        || !CURSOR_ID.test(id) || BigInt(id) > MAX_PG_BIGINT)
        throw new Error('Invalid diagnostic history continuation row.');
    return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}
function parseCursor(cursor: string): [string, string] {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(cursor))
        throw new Error('Invalid diagnostic history cursor.');
    try {
        const encoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const payload: unknown = JSON.parse(encoded);
        if (!Array.isArray(payload) || payload.length !== 2 ||
            typeof payload[0] !== 'string' || typeof payload[1] !== 'string')
            throw new Error('Invalid cursor');
        const [at, id] = payload;
        if (!CURSOR_AT.test(at) || !Number.isFinite(Date.parse(at)) ||
            !CURSOR_ID.test(id) || BigInt(id) > MAX_PG_BIGINT ||
            Buffer.from(JSON.stringify([at, id])).toString('base64url') !== cursor)
            throw new Error('Invalid cursor');
        return [at, id];
    } catch {
        throw new Error('Invalid diagnostic history cursor.');
    }
}
const MAX_PENDING = 128;
const BATCH_SIZE = 32;
const BACKOFF_MS = 30_000;
const RETENTION_DAYS = 14;

type DiagnosticRow = { occurred_at: Date | string; code: string; id?: string | number; cursor_at?: string };
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
    private sweepTimer?: ReturnType<typeof setInterval>;
    private sweeping?: Promise<void>;

    constructor(private readonly database: DiagnosticDatabase, private readonly enabled = true,
        private readonly clock: () => number = () => Date.now()) {
        if (enabled) {
            // Read filtering is immediate; physical expiry also runs on quiet
            // installations even when no diagnostic events arrive for weeks.
            this.sweepTimer = setInterval(() => {
                if (this.stopped || this.sweeping) return;
                const job = this.pruneExpired(10);
                this.sweeping = job;
                void job.finally(() => { if (this.sweeping === job) this.sweeping = undefined; });
            }, 86_400_000);
            this.sweepTimer.unref();
        }
    }

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
                    // Small opportunistic batch; a separate daily sweep handles
                    // quiet processes where this threshold is never reached.
                    await this.pruneExpired(1);
                }
            } catch {
                this.dropped += batch.length + this.pending.length;
                this.pending.length = 0;
                this.pausedUntil = this.clock() + BACKOFF_MS;
                break;
            }
        }
    }

    private async pruneExpired(maxBatches: number): Promise<void> {
        try {
            for (let attempt = 0; attempt < maxBatches; attempt++) {
                const removed = await this.database.query(
                    'DELETE FROM atlas_server_diagnostic_events WHERE id IN ' +
                    '(SELECT id FROM atlas_server_diagnostic_events ' +
                    "WHERE occurred_at < NOW() - INTERVAL '14 days' ORDER BY occurred_at LIMIT 1000) " +
                    'RETURNING id',
                );
                if (removed.rows.length < 1000) break;
            }
        } catch {
            // A failed cleanup must not affect tool dispatch; readers still
            // enforce the 14-day window even when physical expiry is delayed.
        }
    }

    async flush(): Promise<void> {
        await this.writing;
    }

    async close(): Promise<void> {
        this.stopped = true;
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        await this.flush();
        await this.sweeping;
    }

    /** Fixed-table availability probe: not a proof of complete historical coverage.
     * A responsive Server/primary DB can still have missing archive migration,
     * blocked diagnostic-pool access, write backoff or dropped async events.
     * Never disclose exception messages, SQL, code payloads or process IDs. */
    async status(): Promise<{
        source: 'atlas-server-history'; state: 'available' | 'unavailable' | 'disabled';
        coverage: 'incomplete-possible'; retentionDays: 14;
        droppedSinceStart: number; pending: number; writePaused: boolean;
    }> {
        // A read can be queued behind a failing INSERT on the one-connection
        // diagnostic pool. Sample counters *after* the probe settles so a
        // dropped write completed during the probe cannot look healthy.
        const snapshot = () => ({
            source: 'atlas-server-history' as const,
            coverage: 'incomplete-possible' as const,
            retentionDays: RETENTION_DAYS as 14,
            droppedSinceStart: this.dropped,
            pending: this.pending.length,
            writePaused: this.clock() < this.pausedUntil,
        });
        if (!this.enabled) return { ...snapshot(), state: 'disabled' as const };
        try {
            await this.database.query('SELECT 1 FROM atlas_server_diagnostic_events LIMIT 1');
            return { ...snapshot(), state: 'available' as const };
        } catch {
            return { ...snapshot(), state: 'unavailable' as const };
        }
    }

    async read(raw: unknown = {}) {
        const { limit, cursor } = inputSchema.parse(raw);
        const boundary = cursor ? parseCursor(cursor) : undefined;
        // Archive reads share the writer pool. Sample current loss/backoff
        // telemetry after the read settles, including when the read fails.
        const snapshot = () => ({
            source: 'atlas-server-history' as const,
            retention: 'best-effort' as const,
            retentionDays: RETENTION_DAYS,
            // Prior process losses remain unknowable.
            droppedSinceStart: this.dropped,
            queuedForWrite: this.pending.length,
            writePaused: this.clock() < this.pausedUntil,
            coverage: 'incomplete-possible' as const,
        });
        if (!this.enabled) return { ...snapshot(), available: false, truncated: false, events: [], nextCursor: undefined };
        try {
            const result = await this.database.query(
                "SELECT occurred_at, code, id, " +
                "to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cursor_at " +
                'FROM atlas_server_diagnostic_events ' +
                "WHERE occurred_at >= NOW() - INTERVAL '14 days' " +
                "AND occurred_at <= NOW() + INTERVAL '30 seconds' " +
                'AND ($2::timestamptz IS NULL OR (occurred_at, id) < ($2::timestamptz, $3::bigint)) ' +
                'ORDER BY occurred_at DESC, id DESC LIMIT $1',
                [limit + 1, boundary?.[0] ?? null, boundary?.[1] ?? null],
            );
            const page = result.rows.slice(0, limit);
            // Only an actual extra row proves that another bounded page exists.
            // A continuation is returned only after the page is fully formed.
            const truncated = result.rows.length > limit;
            const nextCursor = truncated && page.length ? cursorFor(page[page.length - 1]!) : undefined;
            const events = page.flatMap(row => {
                const description = serverDiagnosticDescription(row.code);
                if (!description) return [];
                const at = new Date(row.occurred_at);
                if (!Number.isFinite(at.getTime())) return [];
                return [{ at: at.toISOString(), code: row.code, ...description }];
            });
            return { ...snapshot(), available: true, truncated, nextCursor, events };
        } catch {
            // Never reveal connection strings, SQL or exception details.
            return { ...snapshot(), available: false, truncated: false, nextCursor: undefined, events: [] };
        }
    }
}
