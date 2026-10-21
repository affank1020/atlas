import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { R2ObjectStore, type ListedFileObject } from './file-storage.js';

const FILE_KEY = /^files-[a-f0-9]{32}-[a-f0-9]{64}$/;
export const AUDIT_DEFAULT_LIMIT = 2000;
export const AUDIT_MAX_LIMIT = 5000;
export const AUDIT_GRACE_MS = 24 * 60 * 60 * 1000;

export type InventorySource = 'local' | 'r2';
export type InventorySummary = {
    source: InventorySource;
    scanned: number;
    referenced: number;
    recentUnreferenced: number;
    candidateOrphans: number;
    candidateBytes: number;
    truncated: boolean;
    candidates: { key: string; bytes: number; modifiedAt: string }[];
};
export type FilesAudit = {
    mode: 'dry-run';
    measuredAt: string;
    graceHours: number;
    maxObjectsPerSource: number;
    noDeletion: true;
    local: InventorySummary;
    r2: InventorySummary | { state: 'not_configured' };
};

export async function scanLocalFiles(root: string, limit: number): Promise<{ objects: ListedFileObject[]; truncated: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) throw new Error('Invalid audit limit.');
    let stat;
    try { stat = await lstat(root); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { objects: [], truncated: false };
        throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Files audit root must be a real directory.');
    const objects: ListedFileObject[] = [];
    let truncated = false;
    const directory = await opendir(root);
    for await (const entry of directory) {
        if (!FILE_KEY.test(entry.name) || !entry.isFile()) continue;
        if (objects.length === limit) { truncated = true; break; }
        // Reject changed file types and never follow symlinks.
        const file = await lstat(path.join(root, entry.name));
        if (!file.isFile() || file.isSymbolicLink()) continue;
        objects.push({ key: entry.name, size: file.size, modifiedAt: file.mtime });
    }
    return { objects, truncated };
}

export async function scanR2Files(store: Pick<R2ObjectStore, 'listFilesPage'>, limit: number):
Promise<{ objects: ListedFileObject[]; truncated: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) throw new Error('Invalid audit limit.');
    const objects: ListedFileObject[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;
    // Fail closed on pathological pagination instead of issuing unbounded
    // Class A R2 LIST requests. A partial scan must not look complete.
    let pages = 0;
    const maxPages = Math.ceil(limit / 1000) + 1;
    do {
        if (++pages > maxPages) throw new Error('R2 inventory exceeded page budget.');
        const page = await store.listFilesPage(token, Math.min(1000, limit - objects.length));
        if (page.objects.length > Math.min(1000, limit - objects.length)) throw new Error('R2 inventory exceeded requested page size.');
        objects.push(...page.objects);
        token = page.nextToken;
        if (token) {
            if (tokens.has(token)) throw new Error('R2 returned repeated inventory continuation token.');
            tokens.add(token);
        }
        if (objects.length >= limit) return { objects, truncated: Boolean(token) };
    } while (token);
    return { objects, truncated: false };
}

/** A read-only snapshot; no file deletion, bucket mutations or retention jobs.
 * Suspected orphans are not proof of safe deletion while uploads can race. */
export async function auditAtlasFiles(input: {
    pool: Pick<Pool, 'query'>;
    localRoot: string;
    r2?: Pick<R2ObjectStore, 'listFilesPage'> | null;
    maxObjects?: number;
    now?: Date;
}): Promise<FilesAudit> {
    const limit = input.maxObjects ?? AUDIT_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_LIMIT) throw new Error('Invalid audit limit.');
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid audit timestamp.');
    const cutoff = now.getTime() - AUDIT_GRACE_MS;
    const summarize = async (source: InventorySource, inventory: { objects: ListedFileObject[]; truncated: boolean }):
    Promise<InventorySummary> => {
        const keys = inventory.objects.map(item => item.key);
        const committed = new Set<string>();
        for (let i = 0; i < keys.length; i += 250) {
            const batch = keys.slice(i, i + 250);
            const result = await input.pool.query<{ storage_key: string }>(
                'SELECT storage_key FROM atlas_files WHERE storage_key = ANY($1::text[])', [batch]);
            for (const row of result.rows) committed.add(row.storage_key);
        }
        let recentUnreferenced = 0;
        let candidateOrphans = 0;
        let candidateBytes = 0;
        const candidates: InventorySummary['candidates'] = [];
        for (const object of inventory.objects) {
            if (committed.has(object.key)) continue;
            if (object.modifiedAt.getTime() > cutoff) { recentUnreferenced++; continue; }
            candidateOrphans++;
            candidateBytes += object.size;
            if (candidates.length < 25)
                candidates.push({ key: object.key, bytes: object.size, modifiedAt: object.modifiedAt.toISOString() });
        }
        return { source, scanned: inventory.objects.length, referenced: inventory.objects.filter(x => committed.has(x.key)).length,
            recentUnreferenced, candidateOrphans, candidateBytes,
            truncated: inventory.truncated, candidates };
    };
    const localInventory = await scanLocalFiles(input.localRoot, limit);
    const local = await summarize('local', localInventory);
    const r2 = input.r2 ? await summarize('r2', await scanR2Files(input.r2, limit)) : { state: 'not_configured' as const };
    return { mode: 'dry-run', measuredAt: now.toISOString(), graceHours: AUDIT_GRACE_MS / 3_600_000,
        maxObjectsPerSource: limit, noDeletion: true, local, r2 };
}
