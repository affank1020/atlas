import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ObjectNotFound, type ObjectStore } from "./file-storage.js";
import {
    copyProjectKeys, encodeKeyCopyCursor, inspectProjectKeyCopyRow,
    type BoundedCopyStore, type ProjectKeyCopyRow, type KeyCopyReport,
} from "./project-key-migration.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_OBJECTS = 1000;
const MAX_BATCH = 5;
const MAX_BYTES = 25 * 1024 * 1024;
export const CAPTURE_PROJECT_KEY_MANIFEST = "CAPTURE_PROJECT_KEY_MANIFEST";

export type SnapshotItem = { ordinal: number; row: ProjectKeyCopyRow; target: string };
export type ProjectKeyRun = {
    id: string; projectId: string; manifestSha256: string; objectCount: number;
    capturedAt: string; items: SnapshotItem[];
};
export type KeyCopyLedgerStatus = {
    runId: string; projectId: string; manifestSha256: string; objectCount: number;
    receipts: number; nextOrdinal: number; currentCatalogMatches: boolean;
    /** Receipt counts alone never imply independent disaster recovery. */
    allCopied: boolean;
};
export type AdvanceKeyRunResult = {
    status: "dry-run" | "copied" | "all-copied";
    runId: string; checked: number; newlyReceipted: number;
    nextOrdinal: number; copiedCount: number;
    copy: KeyCopyReport | null;
};
export type AuditKeyRunResult = {
    runId: string; checked: number; verified: number; missingReceipts: number;
    status: "passed-page" | "incomplete"; nextOrdinal?: number; remaining: boolean;
};

function hash(bytes: Buffer | string) { return createHash("sha256").update(bytes).digest("hex"); }
function verify(bytes: Buffer, size: number, digest: string): boolean {
    return bytes.length === size && hash(bytes) === digest;
}
function projectId(value: string): string {
    if (typeof value !== "string" || !UUID.test(value))
        throw new Error("Invalid Project key ledger Project ID.");
    return value;
}
function runId(value: string): string {
    if (typeof value !== "string" || !UUID.test(value))
        throw new Error("Invalid Project key ledger run ID.");
    return value;
}

/** Consistent, bounded catalogue read from one PostgreSQL statement. An
 * existing manifest is compared against a fresh statement before EVERY batch;
 * a changed catalogue fails closed rather than moving the checkpoint. */
export async function readProjectKeySnapshot(database: Pick<Pool, "query">,
    project: string): Promise<{ items: SnapshotItem[]; sha256: string }> {
    projectId(project);
    const result = await database.query<ProjectKeyCopyRow>(
        "SELECT project_id,source,file_id,variant,storage_key,checksum,byte_size,mime_type,status " +
        "FROM atlas_project_storage_objects WHERE project_id=$1::text " +
        "ORDER BY source,file_id::text,variant LIMIT $2", [project, MAX_OBJECTS + 1]);
    if (result.rows.length > MAX_OBJECTS)
        throw new Error("Project catalogue exceeds bounded manifest capacity.");
    const targets = new Set<string>(), identities = new Set<string>();
    const items = result.rows.map((row, ordinal) => {
        if (row.project_id !== project) throw new Error("Cross-Project storage entry in catalogue.");
        const { target } = inspectProjectKeyCopyRow(row);
        const identity = JSON.stringify([row.source, row.file_id, row.variant]);
        if (targets.has(target) || identities.has(identity))
            throw new Error("Duplicate Project storage identity or destination key.");
        targets.add(target); identities.add(identity);
        return { ordinal, row: { ...row, byte_size: Number(row.byte_size) }, target };
    });
    // JSON property order is fixed because the explicit array provides the
    // canonical field order and number normalization.
    const canonical = items.map(item => [
        item.row.project_id,item.row.source,item.row.file_id,item.row.variant,
        item.row.storage_key,item.target,item.row.checksum,Number(item.row.byte_size),
        item.row.mime_type,item.row.status,
    ]);
    return { items, sha256: hash(JSON.stringify(canonical)) };
}

type RunRow = {
    id: string; project_id: string; manifest_sha256: string;
    object_count: number; captured_at: Date;
};
type ManifestRow = {
    ordinal: number; source: ProjectKeyCopyRow["source"]; file_id: string;
    variant: string; source_key: string; target_key: string;
    checksum: string | null; byte_size: string; mime_type: string; status: string;
};

async function loadProjectKeyRun(database: Pick<Pool,"query">, id: string): Promise<ProjectKeyRun> {
    runId(id);
    const result = await database.query<RunRow>(
        "SELECT id,project_id,manifest_sha256,object_count,captured_at " +
        "FROM atlas_project_key_runs WHERE id=$1", [id]);
    if (result.rows.length !== 1) throw new Error("Project key run does not exist.");
    const header = result.rows[0]!;
    const metadata = await database.query<ManifestRow>(
        "SELECT ordinal,source,file_id,variant,source_key,target_key,checksum,byte_size,mime_type,status " +
        "FROM atlas_project_key_manifest WHERE run_id=$1 ORDER BY ordinal", [id]);
    if (metadata.rows.length !== header.object_count || !metadata.rows.length || metadata.rows.length > MAX_OBJECTS)
        throw new Error("Project key manifest is incomplete.");
    const items = metadata.rows.map((saved, ordinal): SnapshotItem => {
        if (saved.ordinal !== ordinal) throw new Error("Project key manifest has a missing position.");
        const row: ProjectKeyCopyRow = {
            project_id: header.project_id, source: saved.source, file_id: saved.file_id,
            variant: saved.variant, storage_key: saved.source_key, checksum: saved.checksum,
            byte_size: saved.byte_size, mime_type: saved.mime_type, status: saved.status,
        };
        const { target } = inspectProjectKeyCopyRow(row);
        if (target !== saved.target_key) throw new Error("Project key manifest destination mismatch.");
        return { ordinal, row: { ...row, byte_size: Number(row.byte_size) }, target };
    });
    const canonical = items.map(item => [
        item.row.project_id,item.row.source,item.row.file_id,item.row.variant,
        item.row.storage_key,item.target,item.row.checksum,Number(item.row.byte_size),
        item.row.mime_type,item.row.status,
    ]);
    if (hash(JSON.stringify(canonical)) !== header.manifest_sha256)
        throw new Error("Project key manifest fingerprint mismatch.");
    return { id, projectId: header.project_id, manifestSha256: header.manifest_sha256,
        objectCount: header.object_count, capturedAt: new Date(header.captured_at).toISOString(), items };
}

async function checkedCurrent(database: Pick<Pool,"query">, run: ProjectKeyRun): Promise<void> {
    const current = await readProjectKeySnapshot(database,run.projectId);
    if (current.sha256 !== run.manifestSha256 || current.items.length !== run.objectCount)
        throw new Error("Project catalogue changed since capture; create a new manifest before continuing.");
}

/** Operator initiated, write-only to the new ledger tables. No object read or
 * write occurs during capture. A repeatable read transaction snapshots the
 * view and makes all manifest rows visible atomically or none of them. */
export async function captureProjectKeyRun(pool: Pick<Pool,"connect">,
    project: string): Promise<ProjectKeyRun> {
    projectId(project);
    const client = await pool.connect();
    const id = randomUUID();
    let begun = false;
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        begun = true;
        const snapshot = await readProjectKeySnapshot(client,project);
        if (snapshot.items.length === 0) throw new Error("Cannot capture an empty Project catalogue.");
        await client.query(
            "INSERT INTO atlas_project_key_runs(id,project_id,manifest_sha256,object_count) VALUES($1,$2,$3,$4)",
            [id,project,snapshot.sha256,snapshot.items.length]);
        for (const item of snapshot.items) {
            const row = item.row;
            await client.query(
                "INSERT INTO atlas_project_key_manifest " +
                "(run_id,ordinal,source,file_id,variant,source_key,target_key,checksum,byte_size,mime_type,status) " +
                "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
                [id,item.ordinal,row.source,row.file_id,row.variant,row.storage_key,item.target,
                 row.checksum,Number(row.byte_size),row.mime_type,row.status]);
        }
        await client.query("COMMIT");
        begun = false;
        return { id, projectId: project, manifestSha256: snapshot.sha256,
            objectCount: snapshot.items.length, capturedAt: new Date().toISOString(), items: snapshot.items };
    } catch (error) {
        if (begun) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally { client.release(); }
}

async function receipts(database: Pick<Pool,"query">, id: string) {
    const res = await database.query<{ordinal:number; sha256:string; byte_size:string}>(
        "SELECT ordinal,sha256,byte_size FROM atlas_project_key_receipts WHERE run_id=$1 ORDER BY ordinal", [id]);
    return res.rows;
}
function nextPending(run: ProjectKeyRun, saved: {ordinal:number;sha256:string;byte_size:string}[]) {
    if (saved.length > run.objectCount) throw new Error("Project key receipt count exceeds manifest.");
    for (let i=0;i<saved.length;i++) {
        if (saved[i]!.ordinal !== i) throw new Error("Project key receipts are not a contiguous checkpoint.");
        if (!/^[a-f0-9]{64}$/.test(saved[i]!.sha256) ||
            Number(saved[i]!.byte_size) !== Number(run.items[i]!.row.byte_size))
            throw new Error("Project key receipt metadata does not match manifest.");
    }
    return saved.length;
}

export async function projectKeyLedgerStatus(database: Pick<Pool,"query">,
    id: string): Promise<KeyCopyLedgerStatus> {
    const run = await loadProjectKeyRun(database,id);
    const saved = await receipts(database,id);
    const offset = nextPending(run,saved);
    const current = await readProjectKeySnapshot(database,run.projectId);
    const matches = current.sha256 === run.manifestSha256 &&
        current.items.length === run.objectCount;
    return { runId: id, projectId: run.projectId, manifestSha256: run.manifestSha256,
        objectCount: run.objectCount, receipts: saved.length, nextOrdinal: offset,
        currentCatalogMatches: matches, allCopied: matches && offset === run.objectCount };
}

/** Existing create-only migration engine remains responsible for bounded
 * source/destination verification, and an additional fresh read establishes
 * the SHA-256 value recorded for every item (including legacy variants).
 * No receipts are written on a failure or an inconclusive acknowledgement. */
export async function advanceProjectKeyRun(input: {
    database: Pool; source: BoundedCopyStore; destination: BoundedCopyStore;
    runId: string; projectId: string; apply?: boolean; maxFiles?: number;
}): Promise<AdvanceKeyRunResult> {
    const project = projectId(input.projectId);
    const maxFiles = input.maxFiles ?? 3;
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_BATCH)
        throw new Error("Project key run batch must be 1 to 5 objects.");
    if (input.apply && !input.destination.putIfAbsent)
        throw new Error("Atomic create-only destination is required.");
    const run = await loadProjectKeyRun(input.database,input.runId);
    if (run.projectId !== project) throw new Error("Project key run belongs to another Project.");
    await checkedCurrent(input.database,run);
    const previous = await receipts(input.database,run.id);
    const offset = nextPending(run,previous);
    if (offset === run.objectCount)
        return { status:"all-copied",runId:run.id,checked:0,newlyReceipted:0,
            nextOrdinal:offset,copiedCount:offset,copy:null };
    const page = run.items.slice(offset,offset+maxFiles);
    const cursor = offset === 0 ? undefined : encodeKeyCopyCursor({
        projectId:run.projectId, source:run.items[offset-1]!.row.source,
        fileId:run.items[offset-1]!.row.file_id,variant:run.items[offset-1]!.row.variant,
    });
    const result = await copyProjectKeys({ database: input.database, source:input.source,
        destination:input.destination,apply:input.apply === true,
        maxFiles,projectId:project,cursor });
    if (result.status === "failed" || result.checked !== page.length ||
        result.nextCursor !== encodeKeyCopyCursor({
            projectId:run.projectId,source:page[page.length-1]!.row.source,
            fileId:page[page.length-1]!.row.file_id,variant:page[page.length-1]!.row.variant,
        }))
        throw new Error("Project key copy failed or did not match the captured manifest page.");
    if (input.apply !== true) return { status:"dry-run",runId:run.id,
        checked:page.length,newlyReceipted:0,nextOrdinal:offset,copiedCount:offset,copy:result };

    const verified: {ordinal:number;sha256:string;size:number}[] = [];
    for (const item of page) {
        const source = await input.source.getBounded(item.row.storage_key,MAX_BYTES);
        const destination = await input.destination.getBounded(item.target,MAX_BYTES);
        const size = Number(item.row.byte_size), digest = hash(source);
        if (!verify(source,size,digest) || !verify(destination,size,digest) ||
            (item.row.checksum !== null && item.row.checksum !== digest))
            throw new Error("Project key copy changed before receipt verification.");
        verified.push({ordinal:item.ordinal,sha256:digest,size});
    }
    await checkedCurrent(input.database,run);
    // Receipts are committed atomically. The lock prevents two operator
    // processes from recording mismatched checkpoint progress concurrently.
    const client = await input.database.connect();
    let begun = false;
    try {
        await client.query("BEGIN");
        begun = true;
        await client.query("SELECT id FROM atlas_project_key_runs WHERE id=$1 FOR UPDATE",[run.id]);
        const latest = await receipts(client,run.id);
        const nowOffset = nextPending(run,latest);
        if (nowOffset !== offset) throw new Error("Project key run advanced concurrently; retry with the latest checkpoint.");
        for (const value of verified)
            await client.query("INSERT INTO atlas_project_key_receipts(run_id,ordinal,sha256,byte_size) VALUES($1,$2,$3,$4)",
                [run.id,value.ordinal,value.sha256,value.size]);
        await client.query("COMMIT");
        begun = false;
    } catch (error) {
        if (begun) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally { client.release(); }
    const next = offset+verified.length;
    return { status: next === run.objectCount ? "all-copied" : "copied",
        runId:run.id,checked:page.length,newlyReceipted:verified.length,
        nextOrdinal:next,copiedCount:next,copy:result };
}

/** Explicit bounded live byte re-audit. A recorded copy receipt can go stale
 * if source or destination content changes; never treat receipt count as a DR
 * guarantee. Audit has no database or R2 writes. */
export async function auditProjectKeyRun(input: {
    database: Pool; source: BoundedCopyStore; destination: BoundedCopyStore;
    runId: string; projectId: string; fromOrdinal?: number; maxFiles?: number;
}): Promise<AuditKeyRunResult> {
    const run = await loadProjectKeyRun(input.database,input.runId);
    if (run.projectId !== projectId(input.projectId))
        throw new Error("Project key audit belongs to a different Project.");
    await checkedCurrent(input.database,run);
    const from = input.fromOrdinal ?? 0, count = input.maxFiles ?? 3;
    if (!Number.isInteger(from) || from < 0 || from >= run.objectCount ||
        !Number.isInteger(count) || count < 1 || count > MAX_BATCH)
        throw new Error("Invalid bounded Project key audit page.");
    const previous = await receipts(input.database,run.id);
    nextPending(run,previous);
    const byOrdinal = new Map(previous.map(item=>[item.ordinal,item]));
    const page = run.items.slice(from,from+count);
    let missingReceipts = 0, verified = 0;
    for (const item of page) {
        const receipt = byOrdinal.get(item.ordinal);
        if (!receipt) { missingReceipts++; continue; }
        const source = await input.source.getBounded(item.row.storage_key,MAX_BYTES);
        const destination = await input.destination.getBounded(item.target,MAX_BYTES);
        const expectedSize = Number(item.row.byte_size);
        if (!verify(source,expectedSize,receipt.sha256) ||
            !verify(destination,expectedSize,receipt.sha256) ||
            item.row.checksum !== null && item.row.checksum !== receipt.sha256)
            throw new Error("Project key audit found missing or corrupt source/destination bytes.");
        verified++;
    }
    await checkedCurrent(input.database,run);
    const next = from+page.length;
    return {runId:run.id,checked:page.length,verified,missingReceipts,
        status:missingReceipts===0?"passed-page":"incomplete",
        ...(next<run.objectCount?{nextOrdinal:next}:{}),remaining:next<run.objectCount};
}
