import type { Pool } from 'pg';

// This is a deliberate, operator-invoked maintenance primitive, not a timer.
// Seven days is the minimum retention. Successful/archived Files and R2 objects
// are never touched by this maintenance operation.
export const NODE_TRANSFER_RETENTION_DAYS = 7;
export const NODE_TRANSFER_MAX_CLEANUP_BATCH = 100;
const RETENTION_MS = NODE_TRANSFER_RETENTION_DAYS * 24 * 60 * 60 * 1000;

type AggregateRow = { sessions: number; reserved_bytes: string; staged_bytes: string };
type SessionRow = { node_id: string; upload_id: string; byte_size: number };
export type TransferCleanupPreview = {
    mode: 'dry-run';
    cutoff: string;
    retentionDays: number;
    staleActiveSessions: number;
    staleReservedBytes: number;
    staleStagedBytes: number;
    staleFinalizingSessions: number;
    noDeletion: true;
};
export type TransferCleanupApplied = {
    mode: 'apply';
    cutoff: string;
    retentionDays: number;
    maxSessions: number;
    removedSessions: number;
    releasedReservedBytes: number;
    releasedStagedBytes: number;
    pendingFinalizingPreserved: true;
};

export const NODE_TRANSFER_APPLY_CONFIRMATION = 'DELETE_STALE_NODE_CHECKPOINTS';

/** Strict operator CLI parser. The default is ALWAYS non-mutating. */
export function parseNodeTransferMaintenanceArgs(args: string[]): {
    apply: boolean; maxSessions: number;
} {
    const apply = args.includes('--apply');
    const options = args.filter(x => /^--max-sessions=/.test(x));
    if (options.length > 1 || args.filter(x=>x==='--apply').length > 1 ||
        args.filter(x=>x==='--dry-run').length > 1)
        throw new Error('Duplicate Node staging maintenance arguments.');
    const confirmed = '--confirm=' + NODE_TRANSFER_APPLY_CONFIRMATION;
    const allowed = new Set(['--apply','--dry-run',confirmed,...options]);
    if (args.some(x=>!allowed.has(x)) || args.includes('--apply') && args.includes('--dry-run'))
        throw new Error('Invalid Node staging maintenance arguments.');
    if (apply !== args.includes(confirmed))
        throw new Error('Apply mode requires explicit --confirm=' + NODE_TRANSFER_APPLY_CONFIRMATION + '.');
    if (args.filter(x=>x===confirmed).length > 1)
        throw new Error('Duplicate Node staging maintenance confirmation.');
    const maxSessions = options.length ? Number(options[0]!.slice('--max-sessions='.length)) : 25;
    validateBatch(maxSessions);
    return { apply, maxSessions };
}

function cutoffAt(now: Date): Date {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid retention timestamp.');
    return new Date(now.getTime() - RETENTION_MS);
}
function validateBatch(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > NODE_TRANSFER_MAX_CLEANUP_BATCH)
        throw new Error('Node staging cleanup batch must contain between 1 and 100 sessions.');
}
function safeNumber(value: string | number): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid staging storage count.');
    return number;
}

/**
 * A read-only snapshot. "stale" means last successful checkpoint/write was
 * strictly more than seven days ago. Never consider finalizing sessions safe
 * to purge: a remote object PUT may already have committed despite an
 * ambiguous acknowledgement, and clients can retry their 10-minute claim.
 */
export async function previewNodeTransferCleanup(
    pool: Pick<Pool, 'query'>, now = new Date(),
): Promise<TransferCleanupPreview> {
    const cutoff = cutoffAt(now);
    const [summary, finalizing] = await Promise.all([
        pool.query<AggregateRow>(`
            SELECT COUNT(*)::int AS sessions,
                   COALESCE(SUM(s.byte_size),0)::text AS reserved_bytes,
                   COALESCE(SUM(COALESCE(parts.staged_bytes,0)),0)::text AS staged_bytes
              FROM node_file_transfer_sessions s
              LEFT JOIN LATERAL (
                SELECT SUM(p.byte_size) AS staged_bytes
                  FROM node_file_transfer_parts p
                 WHERE p.node_id=s.node_id AND p.upload_id=s.upload_id
              ) parts ON true
             WHERE s.status='active' AND s.updated_at < $1
        `, [cutoff]),
        pool.query<{ sessions: number }>(`
            SELECT COUNT(*)::int AS sessions FROM node_file_transfer_sessions
             WHERE status='finalizing' AND updated_at < $1
        `, [cutoff]),
    ]);
    const row = summary.rows[0]!;
    return {
        mode: 'dry-run',
        cutoff: cutoff.toISOString(),
        retentionDays: NODE_TRANSFER_RETENTION_DAYS,
        staleActiveSessions: safeNumber(row.sessions),
        staleReservedBytes: safeNumber(row.reserved_bytes),
        staleStagedBytes: safeNumber(row.staged_bytes),
        staleFinalizingSessions: safeNumber(finalizing.rows[0]!.sessions),
        noDeletion: true,
    };
}

/**
 * Explicitly invoked, bounded PostgreSQL-only deletion of abandoned *active*
 * sessions. FOR UPDATE SKIP LOCKED avoids waiting behind a write/finalizer;
 * all predicates are rechecked in the transaction that performs deletion.
 * The parts table's ON DELETE CASCADE removes only the checkpoint bytes.
 * An incomplete or failed transaction has no committed partial deletions.
 */
export async function expireNodeTransferCheckpoints(
    pool: Pool, options: { now?: Date; maxSessions?: number } = {},
): Promise<TransferCleanupApplied> {
    const maxSessions = options.maxSessions ?? 25;
    validateBatch(maxSessions);
    const cutoff = cutoffAt(options.now ?? new Date());
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const selected = await db.query<SessionRow>(`
            SELECT node_id,upload_id,byte_size FROM node_file_transfer_sessions
             WHERE status='active' AND updated_at < $1
             ORDER BY updated_at,node_id,upload_id
             FOR UPDATE SKIP LOCKED
             LIMIT $2
        `, [cutoff,maxSessions]);
        let staged = 0;
        if (selected.rows.length) {
            const nodes = selected.rows.map(row=>row.node_id);
            const uploads = selected.rows.map(row=>row.upload_id);
            const bytes = await db.query<{ bytes: string }>(`
                SELECT COALESCE(SUM(byte_size),0)::text AS bytes
                  FROM node_file_transfer_parts
                 WHERE (node_id,upload_id) IN (
                   SELECT * FROM UNNEST($1::uuid[],$2::uuid[])
                 )
            `, [nodes,uploads]);
            staged = safeNumber(bytes.rows[0]!.bytes);
            const removed = await db.query<{ node_id: string; upload_id: string }>(`
                DELETE FROM node_file_transfer_sessions
                 WHERE (node_id,upload_id) IN (
                   SELECT * FROM UNNEST($1::uuid[],$2::uuid[])
                 ) AND status='active' AND updated_at < $3
                 RETURNING node_id,upload_id
            `, [nodes,uploads,cutoff]);
            if (removed.rowCount !== selected.rows.length)
                throw new Error('Staging retention changed during deletion; rolling back.');
        }
        await db.query('COMMIT');
        return {
            mode: 'apply',cutoff:cutoff.toISOString(),retentionDays:NODE_TRANSFER_RETENTION_DAYS,
            maxSessions,removedSessions:selected.rows.length,
            releasedReservedBytes:selected.rows.reduce((n,row)=>n+Number(row.byte_size),0),
            releasedStagedBytes:staged,pendingFinalizingPreserved:true,
        };
    } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally { db.release(); }
}
