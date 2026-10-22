import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ObjectNotFound } from './file-storage.js';
import {
    R2_RECOVERY_DEFAULT_FILES, R2_RECOVERY_MAX_FILES, R2_RECOVERY_MAX_FILE_BYTES,
} from './r2-recovery-verification.js';

// Reuse the verifier's strict, generated Atlas Files key contract. File IDs,
// not object keys, are the stable pagination cursor, even for invalid rows.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CURSOR_UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const FILE_KEY = /^files-[a-f0-9]{32}-[a-f0-9]{64}$/;
export const R2_SEED_CONFIRMATION = 'SEED_R2_RECOVERY';

type FileRow = { id: string; storage_key: string; checksum: string; byte_size: number | string };
export type SeedStore = {
    getBounded(key: string, maxBytes: number): Promise<Buffer>;
    putIfAbsent?(key: string, bytes: Buffer, mimeType: string): Promise<boolean>;
};
/** Match the live Files read precedence, but never fall back when the R2
 * source failed for anything other than an explicitly confirmed NoSuchKey.
 * Both stores must implement bounded reads, including local legacy files. */
export function createR2SeedPrimarySource(remote: Pick<SeedStore, 'getBounded'>,
    local: Pick<SeedStore, 'getBounded'>): Pick<SeedStore, 'getBounded'> {
    return {
        async getBounded(key: string, maxBytes: number): Promise<Buffer> {
            try { return await remote.getBounded(key, maxBytes); }
            catch (error) {
                if (!(error instanceof ObjectNotFound)) throw error;
                return local.getBounded(key, maxBytes);
            }
        },
    };
}

export type SeedOptions = { apply: boolean; maxFiles: number; cursor?: string };
export type SeedReport = {
    mode: 'dry-run' | 'apply';
    status: 'ready' | 'completed' | 'failed' | 'partial' | 'empty';
    checked: number; existingVerified: number; planned: number; createdVerified: number;
    racedVerified: number; invalidMetadata: number; primaryMissing: number;
    primaryCorrupt: number; backupCorrupt: number; bytesRead: number;
    bytesUploaded: number; writesAttempted: number; maxFiles: number;
    remaining: boolean; entireCatalogChecked: boolean; nextCursor?: string;
    failureFileIds: string[];
};

export function parseR2SeedArgs(args: string[]): SeedOptions {
    const apply = args.filter(a => a === '--apply');
    const dry = args.filter(a => a === '--dry-run');
    const confirmations = args.filter(a => a.startsWith('--confirm='));
    const limits = args.filter(a => a.startsWith('--max-files='));
    const cursors = args.filter(a => a.startsWith('--cursor='));
    if (apply.length > 1 || dry.length > 1 || confirmations.length > 1 ||
        limits.length > 1 || cursors.length > 1 ||
        apply.length + dry.length + confirmations.length + limits.length + cursors.length !== args.length ||
        (apply.length ? (dry.length !== 0 || confirmations[0] !== '--confirm=' + R2_SEED_CONFIRMATION)
            : confirmations.length !== 0))
        throw new Error('Usage: [--dry-run] [--max-files=1..10] [--cursor=file-uuid] OR --apply --confirm=SEED_R2_RECOVERY [--max-files=1..10] [--cursor=file-uuid]');
    const maxFiles = limits.length ? Number(limits[0]!.slice('--max-files='.length)) : R2_RECOVERY_DEFAULT_FILES;
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > R2_RECOVERY_MAX_FILES)
        throw new Error('Invalid R2 backup seed limit.');
    const cursor = cursors[0]?.slice('--cursor='.length);
    if (cursor !== undefined && !CURSOR_UUID.test(cursor))
        throw new Error('Invalid R2 backup seed cursor.');
    return { apply: apply.length === 1, maxFiles, ...(cursor ? { cursor } : {}) };
}

function valid(row: FileRow): boolean {
    const size = Number(row.byte_size);
    return UUID.test(row.id) && SHA256.test(row.checksum) && FILE_KEY.test(row.storage_key) &&
        Number.isSafeInteger(size) && size > 0 && size <= R2_RECOVERY_MAX_FILE_BYTES &&
        row.storage_key === 'files-' + row.id.replaceAll('-', '') + '-' + row.checksum;
}

function integrity(row: FileRow, bytes: Buffer): boolean {
    return bytes.length === Number(row.byte_size) &&
        createHash('sha256').update(bytes).digest('hex') === row.checksum;
}

async function read(store: SeedStore, row: FileRow): Promise<Buffer | null> {
    try { return await store.getBounded(row.storage_key, R2_RECOVERY_MAX_FILE_BYTES); }
    catch (error) {
        if (error instanceof ObjectNotFound) return null;
        // Auth, network, timeout or truncated reads are inconclusive, never absence.
        throw error;
    }
}

/** Bounded, append-only R2 backup seeding. Only committed file metadata is
 * considered; archived Files remain recoverable. No DB changes or deletions.
 * Conditional PUT is the final atomic exclusion guard, not a HEAD/GET race. */
export async function seedR2Backup(input: {
    database: Pick<Pool, 'query'>; primary: SeedStore; backup: SeedStore;
    apply?: boolean; maxFiles?: number; cursor?: string;
}): Promise<SeedReport> {
    const apply = input.apply === true;
    const maxFiles = input.maxFiles ?? R2_RECOVERY_DEFAULT_FILES;
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > R2_RECOVERY_MAX_FILES)
        throw new Error('Invalid R2 backup seed limit.');
    if (input.cursor !== undefined && !CURSOR_UUID.test(input.cursor))
        throw new Error('Invalid R2 backup seed cursor.');
    if (apply && !input.backup.putIfAbsent)
        throw new Error('R2 recovery store does not support atomic create-only writes.');

    const rowsResult = await input.database.query<FileRow>(
        'SELECT id,storage_key,checksum,byte_size FROM atlas_files ' +
        'WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id ASC LIMIT $2',
        [input.cursor ?? null, maxFiles + 1],
    );
    if (rowsResult.rows.length > maxFiles + 1)
        throw new Error('R2 seed metadata query exceeded its bound.');
    const rows = rowsResult.rows.slice(0, maxFiles);
    const remaining = rowsResult.rows.length > maxFiles;
    const report: SeedReport = {
        mode: apply ? 'apply' : 'dry-run', status: 'partial', checked: 0,
        existingVerified: 0, planned: 0, createdVerified: 0, racedVerified: 0,
        invalidMetadata: 0, primaryMissing: 0, primaryCorrupt: 0, backupCorrupt: 0,
        bytesRead: 0, bytesUploaded: 0, writesAttempted: 0, maxFiles, remaining,
        entireCatalogChecked: input.cursor === undefined && !remaining,
        failureFileIds: [],
    };
    const failed = (row: FileRow) => {
        if (report.failureFileIds.length < R2_RECOVERY_MAX_FILES)
            report.failureFileIds.push(row.id);
    };

    for (const row of rows) {
        report.checked++;
        if (!valid(row)) {
            report.invalidMetadata++;
            failed(row);
            continue;
        }

        const backup = await read(input.backup, row);
        if (backup !== null) {
            report.bytesRead += backup.length;
            if (integrity(row, backup)) report.existingVerified++;
            else { report.backupCorrupt++; failed(row); }
            // Never write over an existing object, even when it is corrupt.
            continue;
        }

        const source = await read(input.primary, row);
        if (source === null) {
            report.primaryMissing++;
            failed(row);
            continue;
        }
        report.bytesRead += source.length;
        if (!integrity(row, source)) {
            report.primaryCorrupt++;
            failed(row);
            continue;
        }
        if (!apply) { report.planned++; continue; }

        report.writesAttempted++;
        // A concurrent backup seed may win between GET and PUT. This signed
        // conditional PUT is atomic on R2: 412 means we must re-read and hash.
        const created = await input.backup.putIfAbsent!(row.storage_key, source, 'application/octet-stream');
        const committed = await read(input.backup, row);
        if (committed === null)
            throw new Error('R2 seed PUT outcome inconclusive; backup object is not readable.');
        report.bytesRead += committed.length;
        if (!integrity(row, committed)) {
            report.backupCorrupt++;
            failed(row);
        } else if (created) {
            report.createdVerified++;
            report.bytesUploaded += source.length;
        } else report.racedVerified++;
    }

    if (rows.length && remaining) report.nextCursor = rows[rows.length - 1]!.id;
    const issues = report.invalidMetadata + report.primaryMissing +
        report.primaryCorrupt + report.backupCorrupt;
    report.status = issues ? 'failed' : rows.length === 0 && report.entireCatalogChecked
        ? 'empty' : !report.entireCatalogChecked ? 'partial' : apply ? 'completed' : 'ready';
    return report;
}
