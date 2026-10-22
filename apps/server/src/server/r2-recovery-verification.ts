import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ObjectNotFound, type R2StorageConfig } from './file-storage.js';

const FILE_KEY = /^files-[a-f0-9]{32}-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// PostgreSQL uuid permits values outside UUIDv1-v8, including nil UUIDs.
// Pagination must traverse ALL such rows even when metadata validation fails.
const CURSOR_UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export const R2_RECOVERY_DEFAULT_FILES = 3;
export const R2_RECOVERY_MAX_FILES = 10;
export const R2_RECOVERY_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const R2_RECOVERY_DEFAULT_CATALOG_RECORDS = 100;
export const R2_RECOVERY_MAX_CATALOG_RECORDS = 200;

export type RecoveryObjectStore = { getBounded(key: string, maxBytes: number): Promise<Buffer> };
type FileRow = { id: string; storage_key: string; checksum: string; byte_size: number | string };
export type RecoveryVerification = {
    mode: 'read-only';
    status: 'passed' | 'failed' | 'partial' | 'empty';
    checked: number; verifiedPrimary: number; verifiedBackup: number; verifiedBoth: number;
    primaryMissing: number; backupMissing: number; primaryCorrupt: number; backupCorrupt: number;
    invalidMetadata: number; bytesRead: number; maxFiles: number; remaining: boolean;
    entireCatalogChecked: boolean; noWrites: true; nextCursor?: string; failureFileIds: string[];
};

/** Deliberately separate recovery credentials and bucket from live storage.
 * Never fall back to primary when independent recovery is not configured. */
export function loadRecoveryR2Config(env: NodeJS.ProcessEnv, primary: R2StorageConfig | null): R2StorageConfig {
    if (!primary) throw new Error('R2 primary storage is not configured; recovery is not verified.');
    const values = [
        env.ATLAS_R2_RECOVERY_ENDPOINT?.trim() ?? '',
        env.ATLAS_R2_RECOVERY_BUCKET?.trim() ?? '',
        env.ATLAS_R2_RECOVERY_ACCESS_KEY_ID?.trim() ?? '',
        env.ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY?.trim() ?? '',
    ];
    if (values.some(value => !value))
        throw new Error('Independent R2 recovery endpoint, bucket and credentials must all be configured.');
    const backup = { endpoint: values[0]!, bucket: values[1]!,
        accessKeyId: values[2]!, secretAccessKey: values[3]! };
    // An alias of the source bucket would produce a false "backup verified".
    // Different buckets in the same account are not independent of account loss.
    if (new URL(primary.endpoint).origin === new URL(backup.endpoint).origin &&
        primary.bucket === backup.bucket)
        throw new Error('Recovery bucket must differ from the primary bucket.');
    // A different bucket alone is not a separate recovery credential.
    // Refuse even partial credential reuse; a compromised or revoked source
    // credential must not also authorize a supposed recovery copy.
    if (backup.accessKeyId === primary.accessKeyId ||
        backup.secretAccessKey === primary.secretAccessKey)
        throw new Error('Recovery R2 must use different access-key ID and secret credentials.');
    return backup;
}

export function parseRecoveryVerifyArgs(args: string[]): { maxFiles: number; cursor?: string } {
    const options = args.filter(value => value.startsWith('--max-files='));
    const cursors = args.filter(value => value.startsWith('--cursor='));
    if (options.length > 1 || cursors.length > 1 ||
        args.filter(x => x === '--dry-run').length !== 1 ||
        args.length !== 1 + options.length + cursors.length)
        throw new Error('Usage: --dry-run [--max-files=1..10] [--cursor=file-uuid]');
    const maxFiles = options.length ? Number(options[0]!.slice('--max-files='.length)) : R2_RECOVERY_DEFAULT_FILES;
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > R2_RECOVERY_MAX_FILES)
        throw new Error('Recovery verification checks 1 to 10 files per invocation.');
    const cursor = cursors[0]?.slice('--cursor='.length);
    if (cursor !== undefined && !CURSOR_UUID.test(cursor))
        throw new Error('Invalid R2 recovery cursor.');
    return { maxFiles, ...(cursor !== undefined ? { cursor } : {}) };
}

function validated(row: FileRow): boolean {
    const size = Number(row.byte_size);
    return UUID.test(row.id) && SHA256.test(row.checksum) && FILE_KEY.test(row.storage_key) &&
        Number.isSafeInteger(size) && size > 0 && size <= R2_RECOVERY_MAX_FILE_BYTES &&
        row.storage_key === 'files-' + row.id.replaceAll('-', '') + '-' + row.checksum;
}
type ObjectCheck = 'valid' | 'missing' | 'corrupt';
async function check(store: RecoveryObjectStore, row: FileRow): Promise<{ state: ObjectCheck; read: number }> {
    let contents: Buffer;
    try { contents = await store.getBounded(row.storage_key, R2_RECOVERY_MAX_FILE_BYTES); }
    catch (error) {
        if (error instanceof ObjectNotFound) return { state: 'missing', read: 0 };
        // Network/auth/rate limit/oversized or partial response: inconclusive,
        // NOT equivalent to a confirmed missing or corrupted backup.
        throw error;
    }
    if (contents.length !== Number(row.byte_size) ||
        createHash('sha256').update(contents).digest('hex') !== row.checksum)
        return { state: 'corrupt', read: contents.length };
    return { state: 'valid', read: contents.length };
}

/** Shared read-only verifier for already-selected immutable metadata rows.
 * Never asks object stores to PUT or DELETE. A missing primary copy still
 * counts as a source failure even if the recovery copy is intact. */
async function verifySelectedRows(rows: FileRow[], primaryStore: RecoveryObjectStore,
    recoveryStore: RecoveryObjectStore): Promise<{
    verifiedPrimary: number; verifiedBackup: number; verifiedBoth: number;
    primaryMissing: number; backupMissing: number; primaryCorrupt: number;
    backupCorrupt: number; invalidMetadata: number; bytesRead: number; failureFileIds: string[];
}> {
    const counters = {
        verifiedPrimary: 0, verifiedBackup: 0, verifiedBoth: 0,
        primaryMissing: 0, backupMissing: 0, primaryCorrupt: 0,
        backupCorrupt: 0, invalidMetadata: 0, bytesRead: 0, failureFileIds: [] as string[],
    };
    for (const row of rows) {
        if (!validated(row)) {
            counters.invalidMetadata++;
            if (counters.failureFileIds.length < 10) counters.failureFileIds.push(row.id);
            continue;
        }
        const primary = await check(primaryStore, row);
        const backup = await check(recoveryStore, row);
        counters.bytesRead += primary.read + backup.read;
        if (primary.state === 'valid') counters.verifiedPrimary++;
        else if (primary.state === 'missing') counters.primaryMissing++;
        else counters.primaryCorrupt++;
        if (backup.state === 'valid') counters.verifiedBackup++;
        else if (backup.state === 'missing') counters.backupMissing++;
        else counters.backupCorrupt++;
        if (primary.state === 'valid' && backup.state === 'valid') counters.verifiedBoth++;
        else if (counters.failureFileIds.length < 10) counters.failureFileIds.push(row.id);
    }
    return counters;
}

function hasRecoveryIssues(counters: {
    primaryMissing: number; backupMissing: number; primaryCorrupt: number;
    backupCorrupt: number; invalidMetadata: number;
}): boolean {
    return counters.primaryMissing + counters.backupMissing +
        counters.primaryCorrupt + counters.backupCorrupt + counters.invalidMetadata > 0;
}

export type RecoveryCatalogVerification = {
    mode: 'read-only'; status: 'passed' | 'failed' | 'partial' | 'empty';
    catalogScope: 'single-statement-metadata-snapshot';
    snapshotObservedAt: string;
    maxRecords: number; checked: number; truncated: boolean;
    verifiedPrimary: number; verifiedBackup: number; verifiedBoth: number;
    primaryMissing: number; backupMissing: number; primaryCorrupt: number;
    backupCorrupt: number; invalidMetadata: number; bytesRead: number;
    noWrites: true; failureFileIds: string[];
};

export function parseRecoveryCatalogArgs(args: string[]): { maxRecords: number } {
    const option = args.filter(x => x.startsWith('--max-records='));
    if (args.filter(x => x === '--dry-run').length !== 1 ||
        option.length > 1 || args.length !== 1 + option.length)
        throw new Error('Usage: --dry-run [--max-records=1..200]');
    const maxRecords = option.length ?
        Number(option[0]!.slice('--max-records='.length)) : R2_RECOVERY_DEFAULT_CATALOG_RECORDS;
    if (!Number.isInteger(maxRecords) || maxRecords < 1 ||
        maxRecords > R2_RECOVERY_MAX_CATALOG_RECORDS)
        throw new Error('Catalog verification record limit must be 1..200.');
    return { maxRecords };
}

/** Full-catalog verification for a single PostgreSQL statement snapshot.
 * A single, bounded SELECT captures committed File metadata before any remote
 * reads. This prevents pagination drift under concurrent inserts/removals and
 * avoids keeping a DB transaction open through slow R2 reads. Objects added
 * after the SELECT are explicitly outside this report's scope.
 *
 * A cap hit is *partial*, never proof of a complete catalog. This checks
 * both primary and recovery object bytes but does not restore PostgreSQL,
 * validate an offsite DB snapshot or prove a coordinated Files/DB cutover. */
export async function verifyR2RecoveryCatalog(input: {
    database: Pick<Pool, 'query'>; primary: RecoveryObjectStore; backup: RecoveryObjectStore;
    maxRecords?: number;
}): Promise<RecoveryCatalogVerification> {
    const maxRecords = input.maxRecords ?? R2_RECOVERY_DEFAULT_CATALOG_RECORDS;
    if (!Number.isInteger(maxRecords) || maxRecords < 1 ||
        maxRecords > R2_RECOVERY_MAX_CATALOG_RECORDS)
        throw new Error('Catalog verification record limit must be 1..200.');
    const query = await input.database.query<FileRow>(
        'SELECT id,storage_key,checksum,byte_size FROM atlas_files ORDER BY id ASC LIMIT $1',
        [maxRecords + 1],
    );
    if (query.rows.length > maxRecords + 1)
        throw new Error('R2 catalog query exceeded the requested bound.');
    // This is an observation timestamp, not a PostgreSQL transaction LSN.
    const snapshotObservedAt = new Date().toISOString();
    const truncated = query.rows.length > maxRecords;
    const selected = query.rows.slice(0, maxRecords);
    const counters = await verifySelectedRows(selected, input.primary, input.backup);
    return {
        mode: 'read-only',
        status: hasRecoveryIssues(counters) ? 'failed' :
            selected.length === 0 ? 'empty' : truncated ? 'partial' : 'passed',
        catalogScope: 'single-statement-metadata-snapshot', snapshotObservedAt,
        maxRecords, checked: selected.length, truncated, ...counters, noWrites: true,
    };
}

/** Operator-only, bounded, byte-verified restore simulation. SELECT + S3 GET
 * only. A sampled run is never proof that unsampled files or DB snapshots are
 * recoverable. No data is ever written to source or recovery storage. */
export async function verifyR2Recovery(input: {
    database: Pick<Pool, 'query'>; primary: RecoveryObjectStore; backup: RecoveryObjectStore;
    maxFiles?: number; cursor?: string;
}): Promise<RecoveryVerification> {
    const maxFiles = input.maxFiles ?? R2_RECOVERY_DEFAULT_FILES;
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > R2_RECOVERY_MAX_FILES)
        throw new Error('Invalid R2 recovery verification limit.');
    if (input.cursor !== undefined && !CURSOR_UUID.test(input.cursor))
        throw new Error('Invalid R2 recovery cursor.');

    const query = await input.database.query<FileRow>(
        'SELECT id,storage_key,checksum,byte_size FROM atlas_files ' +
        // Stable UUID primary-key pagination is independent of storage_key.
        // The schema allows empty, malformed or arbitrarily long object keys;
        // none can become an unusable cursor or silently hide later records.
        'WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id ASC LIMIT $2',
        [input.cursor ?? null,maxFiles+1]);
    if (query.rows.length > maxFiles+1) throw new Error('Recovery metadata query exceeded its bound.');
    const rows = query.rows.slice(0,maxFiles);
    const remaining = query.rows.length > maxFiles;
    const counters = await verifySelectedRows(rows, input.primary, input.backup);
    const entireCatalogChecked = input.cursor === undefined && !remaining;
    const result: RecoveryVerification = {
        mode: 'read-only', status: hasRecoveryIssues(counters) ? 'failed' :
            rows.length === 0 && entireCatalogChecked ? 'empty' :
            entireCatalogChecked ? 'passed' : 'partial',
        checked: rows.length, ...counters, maxFiles, remaining, entireCatalogChecked, noWrites: true,
    };
    if (rows.length && remaining) result.nextCursor = rows[rows.length - 1]!.id;
    return result;
}
