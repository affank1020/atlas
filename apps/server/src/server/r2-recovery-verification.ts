import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ObjectNotFound, type R2StorageConfig } from './file-storage.js';

const FILE_KEY = /^files-[a-f0-9]{32}-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const R2_RECOVERY_DEFAULT_FILES = 3;
export const R2_RECOVERY_MAX_FILES = 10;
export const R2_RECOVERY_MAX_FILE_BYTES = 25 * 1024 * 1024;

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
        throw new Error('Usage: --dry-run [--max-files=1..10] [--cursor=files-...]');
    const maxFiles = options.length ? Number(options[0]!.slice('--max-files='.length)) : R2_RECOVERY_DEFAULT_FILES;
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > R2_RECOVERY_MAX_FILES)
        throw new Error('Recovery verification checks 1 to 10 files per invocation.');
    const cursor = cursors[0]?.slice('--cursor='.length);
    if (cursor !== undefined && cursor !== '' && !FILE_KEY.test(cursor))
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
    if (input.cursor !== undefined && input.cursor !== '' && !FILE_KEY.test(input.cursor))
        throw new Error('Invalid R2 recovery cursor.');

    const query = await input.database.query<FileRow>(
        'SELECT id,storage_key,checksum,byte_size FROM atlas_files ' +
        // NULL means an uncursored complete-catalogue start, including
        // schema-allowed empty keys. An explicitly supplied empty cursor
        // resumes *after* the empty-key record if it filled the first page;
        // it must not restart the initial scan or claim full coverage.
        'WHERE ($1::text IS NULL OR storage_key > $1) ORDER BY storage_key ASC LIMIT $2',
        [input.cursor ?? null,maxFiles+1]);
    if (query.rows.length > maxFiles+1) throw new Error('Recovery metadata query exceeded its bound.');
    const rows = query.rows.slice(0,maxFiles);
    const remaining = query.rows.length > maxFiles;
    const result: RecoveryVerification = {
        mode: 'read-only',status: 'partial',checked: 0, verifiedPrimary: 0,
        verifiedBackup: 0,verifiedBoth: 0,primaryMissing: 0,backupMissing: 0,
        primaryCorrupt: 0,backupCorrupt: 0,invalidMetadata: 0,bytesRead: 0,
        maxFiles,remaining,entireCatalogChecked: input.cursor === undefined && !remaining,
        noWrites: true,failureFileIds: [],
    };
    for (const row of rows) {
        result.checked++;
        if (!validated(row)) {
            result.invalidMetadata++;
            if (result.failureFileIds.length < 10) result.failureFileIds.push(row.id);
            continue;
        }
        const primary = await check(input.primary,row);
        const backup = await check(input.backup,row);
        result.bytesRead += primary.read + backup.read;
        if (primary.state === 'valid') result.verifiedPrimary++;
        else if (primary.state === 'missing') result.primaryMissing++;
        else result.primaryCorrupt++;
        if (backup.state === 'valid') result.verifiedBackup++;
        else if (backup.state === 'missing') result.backupMissing++;
        else result.backupCorrupt++;
        if (primary.state === 'valid' && backup.state === 'valid') result.verifiedBoth++;
        else if (result.failureFileIds.length < 10) result.failureFileIds.push(row.id);
    }
    if (rows.length && remaining) result.nextCursor = rows[rows.length-1]!.storage_key;
    const issues = result.primaryMissing + result.backupMissing + result.primaryCorrupt +
        result.backupCorrupt + result.invalidMetadata;
    result.status = issues ? 'failed' : result.checked === 0 && result.entireCatalogChecked ? 'empty' :
        result.entireCatalogChecked ? 'passed' : 'partial';
    return result;
}
