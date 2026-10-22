import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ObjectAlreadyExists, ObjectNotFound } from './file-storage.js';
import {
    assertRecoveryFileCursor, validatedRecoveryFileMetadata,
    R2_RECOVERY_MAX_FILE_BYTES, type FileRow,
} from './r2-recovery-verification.js';

export const R2_BACKUP_SEED_DEFAULT_FILES = 2;
export const R2_BACKUP_SEED_MAX_FILES = 5;
export const R2_BACKUP_SEED_CONFIRMATION = 'CREATE_INDEPENDENT_R2_BACKUP_COPIES';

type SeedRow = FileRow & { mime_type: string };
export type SeedStore = {
    getBounded(key: string, maxBytes: number): Promise<Buffer>;
};
export type SeedDestination = SeedStore & {
    /** Atomic PutObject with signed If-None-Match:*. Never an upsert. */
    putIfAbsent(key: string, bytes: Buffer, mimeType: string): Promise<void>;
};
export type SeedPage = {
    rows: SeedRow[]; remaining: boolean; nextCursor?: string;
};
export type SeedPreview = {
    mode: 'dry-run'; planned: number; invalidMetadata: number;
    maxFiles: number; remaining: boolean; nextCursor?: string;
    noObjectRequests: true; noWrites: true;
};
export type SeedApplied = {
    mode: 'apply'; checked: number; created: number; verifiedExisting: number;
    maxFiles: number; remaining: boolean; nextCursor?: string;
    appendOnly: true; noDeletes: true;
};

export function parseR2BackupSeedArgs(args: string[]): {
    apply: boolean; maxFiles: number; cursor?: string;
} {
    const apply = args.includes('--apply');
    const maxArgs = args.filter(x=>x.startsWith('--max-files='));
    const cursorArgs = args.filter(x=>x.startsWith('--cursor='));
    const confirmation = '--confirm=' + R2_BACKUP_SEED_CONFIRMATION;
    if (maxArgs.length > 1 || cursorArgs.length > 1 ||
        args.filter(x=>x==='--apply').length > 1 ||
        args.filter(x=>x==='--dry-run').length > 1 ||
        args.filter(x=>x===confirmation).length > 1 ||
        (apply && args.includes('--dry-run')) ||
        args.some(x=>!['--apply','--dry-run',confirmation,...maxArgs,...cursorArgs].includes(x)))
        throw new Error('Invalid R2 backup seeding arguments.');
    if (apply !== args.includes(confirmation))
        throw new Error('Write mode requires --confirm=' + R2_BACKUP_SEED_CONFIRMATION);
    const maxFiles = maxArgs.length
        ? Number(maxArgs[0]!.slice('--max-files='.length))
        : R2_BACKUP_SEED_DEFAULT_FILES;
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > R2_BACKUP_SEED_MAX_FILES)
        throw new Error('R2 backup seed is limited to 1–5 files per run.');
    const cursor = cursorArgs[0]?.slice('--cursor='.length);
    assertRecoveryFileCursor(cursor);
    return { apply, maxFiles, ...(cursor === undefined ? {} : { cursor }) };
}

/** Bounded, read-only PostgreSQL keyset scan. Validity of object keys is
 * checked after selection; malformed metadata must not block pagination.
 */
export async function selectR2BackupSeedPage(
    database: Pick<Pool,'query'>, options: {maxFiles?:number;cursor?:string} = {},
): Promise<SeedPage> {
    const maxFiles=options.maxFiles ?? R2_BACKUP_SEED_DEFAULT_FILES;
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > R2_BACKUP_SEED_MAX_FILES)
        throw new Error('Invalid R2 backup seeding batch size.');
    assertRecoveryFileCursor(options.cursor);
    const result=await database.query<SeedRow>(
        'SELECT id,storage_key,checksum,byte_size,mime_type FROM atlas_files ' +
        'WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id ASC LIMIT $2',
        [options.cursor ?? null,maxFiles+1],
    );
    if (result.rows.length > maxFiles+1) throw new Error('R2 backup seed metadata exceeded requested bound.');
    const rows=result.rows.slice(0,maxFiles);
    return {
        rows,remaining:result.rows.length > maxFiles,
        ...(result.rows.length > maxFiles && rows.length ?
            {nextCursor:rows[rows.length-1]!.id} : {}),
    };
}

function metadataValid(row: SeedRow): boolean {
    return validatedRecoveryFileMetadata(row) && typeof row.mime_type === 'string' &&
        row.mime_type.length <= 120 &&
        /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(row.mime_type);
}

export async function previewR2BackupSeed(
    database: Pick<Pool,'query'>,options: {maxFiles?:number;cursor?:string} = {},
): Promise<SeedPreview> {
    const page=await selectR2BackupSeedPage(database,options);
    return {
        mode:'dry-run',planned:page.rows.length,
        invalidMetadata:page.rows.filter(row=>!metadataValid(row)).length,
        maxFiles:options.maxFiles ?? R2_BACKUP_SEED_DEFAULT_FILES,
        remaining:page.remaining,...(page.nextCursor ? {nextCursor:page.nextCursor}:{}),
        noObjectRequests:true,noWrites:true,
    };
}

function verifyBytes(bytes:Buffer,row:SeedRow):void {
    if (bytes.length !== Number(row.byte_size) ||
        createHash('sha256').update(bytes).digest('hex') !== row.checksum)
        throw new Error('R2 backup seed encountered bytes mismatching committed Files metadata.');
}

/** Explicit manual append-only seeding. It can create at most 5 backup
 * objects, never overwrites or deletes existing recovery data. Each object
 * is independently checked on the source and on the backup after a write.
 * If a request fails after a prior object committed, rerun: the existing
 * object must pass SHA-256 and byte-size verification before being accepted.
 */
export async function seedIndependentR2Backup(input: {
    database: Pick<Pool,'query'>;
    primary: SeedStore; destination: SeedDestination;
    maxFiles?:number; cursor?:string;
}): Promise<SeedApplied> {
    const page=await selectR2BackupSeedPage(input.database,input);
    // Fail before ANY PUT when a selected file has invalid metadata.
    // Operator must repair or explicitly investigate corruption, not skip it.
    if (page.rows.some(row=>!metadataValid(row)))
        throw new Error('Cannot seed recovery bucket: Files catalogue has invalid metadata.');
    let created=0,verifiedExisting=0;
    for(const row of page.rows) {
        // Always validate source against committed DB bytes before trusting
        // a missing or existing recovery copy; never replicate corrupt data.
        const source=await input.primary.getBounded(row.storage_key,R2_RECOVERY_MAX_FILE_BYTES);
        verifyBytes(source,row);
        let exists=false;
        try {
            const backup=await input.destination.getBounded(row.storage_key,R2_RECOVERY_MAX_FILE_BYTES);
            verifyBytes(backup,row);
            exists=true;
        } catch(error) {
            if (!(error instanceof ObjectNotFound)) throw error;
        }
        if (exists) {verifiedExisting++;continue;}
        let wrote=false;
        try {
            // Atomic S3 create-only write. Conditional header is SigV4-signed.
            // A preflight GET alone cannot protect against another writer.
            await input.destination.putIfAbsent(row.storage_key,source,row.mime_type);
            wrote=true;
        } catch(error) {
            // A concurrent creator or ambiguous prior write may have
            // installed an object. Verify it instead of overwriting it.
            if (!(error instanceof ObjectAlreadyExists)) throw error;
        }
        const verified=await input.destination.getBounded(row.storage_key,R2_RECOVERY_MAX_FILE_BYTES);
        verifyBytes(verified,row);
        if (wrote) created++; else verifiedExisting++;
    }
    return {
        mode:'apply',checked:page.rows.length,created,verifiedExisting,
        maxFiles:input.maxFiles ?? R2_BACKUP_SEED_DEFAULT_FILES,
        remaining:page.remaining,...(page.nextCursor ? {nextCursor:page.nextCursor}:{}),
        appendOnly:true,noDeletes:true,
    };
}
