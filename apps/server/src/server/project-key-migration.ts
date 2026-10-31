import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
    isLegacyObjectKey, ObjectNotFound, projectStorageKey,
} from "./file-storage.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_BATCH = 5;
export const PROJECT_KEY_COPY_CONFIRMATION = "CREATE_PROJECT_KEY_COPIES";

type Source = "atlas-file" | "portfolio-media";
export type MigrationIdentity = { projectId: string; source: Source; fileId: string; variant: string };
type Row = {
    project_id: string; source: Source; file_id: string; variant: string;
    storage_key: string; checksum: string | null; byte_size: number | string; mime_type: string; status: string;
};
export type BoundedCopyStore = {
    getBounded(key: string, maxBytes: number): Promise<Buffer>;
    putIfAbsent?(key: string, bytes: Buffer, mimeType: string): Promise<boolean>;
};
export type KeyCopyOptions = {
    apply?: boolean; maxFiles?: number; cursor?: string; projectId?: string;
};
export type KeyCopyReport = {
    mode: "dry-run" | "apply";
    status: "ready" | "completed" | "partial" | "empty" | "failed";
    checked: number; alreadyVerified: number; planned: number; createdVerified: number;
    racedVerified: number; writesAttempted: number; bytesVerified: number; bytesUploaded: number;
    remaining: boolean; nextCursor?: string; failedIdentity?: MigrationIdentity;
};

/** Cursor is an exact identity tuple, not a mutable offset or a storage key. */
function identity(row: Row): MigrationIdentity {
    return { projectId: row.project_id, source: row.source, fileId: row.file_id, variant: row.variant };
}
function validIdentity(value: MigrationIdentity): boolean {
    return UUID.test(value.projectId) && UUID.test(value.fileId) &&
        (value.source === "atlas-file" || value.source === "portfolio-media") &&
        (value.variant === "original" || /^[a-z][a-z0-9-]{0,63}$/.test(value.variant) && value.variant !== "original") &&
        (value.source !== "atlas-file" || value.variant === "original");
}
export function encodeKeyCopyCursor(value: MigrationIdentity): string {
    if (!validIdentity(value)) throw new Error("Invalid Project key migration cursor.");
    return Buffer.from(JSON.stringify([value.projectId,value.source,value.fileId,value.variant])).toString("base64url");
}
export function decodeKeyCopyCursor(token: string): MigrationIdentity {
    if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{1,400}$/.test(token))
        throw new Error("Invalid Project key migration cursor.");
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); }
    catch { throw new Error("Invalid Project key migration cursor."); }
    if (!Array.isArray(parsed) || parsed.length !== 4 || !parsed.every(x => typeof x === "string"))
        throw new Error("Invalid Project key migration cursor.");
    const result: MigrationIdentity = { projectId: parsed[0], source: parsed[1] as Source, fileId: parsed[2], variant: parsed[3] };
    if (!validIdentity(result) || encodeKeyCopyCursor(result) !== token)
        throw new Error("Invalid Project key migration cursor.");
    return result;
}

export function parseKeyCopyArgs(args: string[]): Required<Pick<KeyCopyOptions,"apply"|"maxFiles">> & Pick<KeyCopyOptions,"cursor"|"projectId"> {
    const flags = new Map<string, string>();
    for (const arg of args) {
        const [name, ...value] = arg.split("=");
        if (!["--dry-run","--apply","--confirm","--max-files","--cursor","--project"].includes(name) ||
            flags.has(name) || (["--dry-run","--apply"].includes(name) ? value.length !== 0 : value.length !== 1))
            throw new Error("Invalid Project key copy arguments.");
        flags.set(name, value[0] ?? "");
    }
    const apply = flags.has("--apply");
    if (apply === flags.has("--dry-run") && (apply || flags.has("--dry-run")))
        throw new Error("Choose dry-run or apply, not both.");
    if (apply ? flags.get("--confirm") !== PROJECT_KEY_COPY_CONFIRMATION || !flags.has("--project")
        : flags.has("--confirm"))
        throw new Error("Apply requires explicit Project scope and exact confirmation.");
    const maxFiles = flags.has("--max-files") ? Number(flags.get("--max-files")) : 3;
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_BATCH)
        throw new Error("Project key copy batch must be 1 to 5 objects.");
    const projectId = flags.get("--project");
    if (projectId !== undefined && !UUID.test(projectId))
        throw new Error("Invalid Project scope.");
    const cursor = flags.get("--cursor");
    if (cursor !== undefined) {
        const decoded = decodeKeyCopyCursor(cursor);
        if (projectId && decoded.projectId !== projectId)
            throw new Error("Cursor belongs to a different Project.");
    }
    return { apply, maxFiles, ...(cursor ? { cursor } : {}), ...(projectId ? { projectId } : {}) };
}

function validateRow(row: Row): { target: string; size: number } {
    const id = identity(row);
    const size = Number(row.byte_size);
    if (!validIdentity(id) || !isLegacyObjectKey(row.storage_key) ||
        !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(row.mime_type) ||
        (row.status !== "active" && row.status !== "archived") ||
        (row.variant === "original" ? !SHA.test(row.checksum ?? "") : row.checksum !== null))
        throw new Error("Invalid Project storage catalog metadata.");
    if (row.source === "atlas-file" && row.storage_key !==
        "files-" + row.file_id.replaceAll("-", "") + "-" + row.checksum)
        throw new Error("Inconsistent Atlas Files storage identity.");
    return { target: projectStorageKey(row.project_id, row.file_id, row.variant), size };
}
function matches(bytes: Buffer, expectedSize: number, expectedHash: string): boolean {
    return bytes.length === expectedSize && createHash("sha256").update(bytes).digest("hex") === expectedHash;
}

/** No database updates, key retirement or deletes. Always verifies source and
 * existing destination bytes before any PUT. An ambiguous PUT never advances
 * the checkpoint cursor; rerunning the same batch checks existing bytes. */
export async function copyProjectKeys(input: {
    database: Pick<Pool,"query">; source: BoundedCopyStore; destination: BoundedCopyStore;
} & KeyCopyOptions): Promise<KeyCopyReport> {
    const apply = input.apply === true, maxFiles = input.maxFiles ?? 3;
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_BATCH)
        throw new Error("Invalid bounded Project key copy size.");
    if (input.projectId !== undefined && !UUID.test(input.projectId))
        throw new Error("Invalid Project scope.");
    if (apply && (!input.projectId || !input.destination.putIfAbsent))
        throw new Error("Apply requires a Project scope and atomic create-only destination.");
    const cursor = input.cursor ? decodeKeyCopyCursor(input.cursor) : null;
    if (cursor && input.projectId && cursor.projectId !== input.projectId)
        throw new Error("Project key copy cursor has the wrong scope.");

    // One ordered SQL statement; no transaction or lock persists across R2 IO.
    const result = await input.database.query<Row>(
        `SELECT project_id,source,file_id,variant,storage_key,checksum,byte_size,mime_type,status
           FROM atlas_project_storage_objects
          WHERE ($1::text IS NULL OR project_id=$1::text)
            AND ($2::text IS NULL OR (project_id,source,file_id::text,variant) >
                 ($2::text,$3::text,$4::text,$5::text))
          ORDER BY project_id,source,file_id::text,variant LIMIT $6`,
        [input.projectId ?? null, cursor?.projectId ?? null, cursor?.source ?? null,
         cursor?.fileId ?? null, cursor?.variant ?? null, maxFiles + 1],
    );
    if (result.rows.length > maxFiles + 1) throw new Error("Project key copy catalog exceeded batch limit.");
    const rows = result.rows.slice(0, maxFiles), remaining = result.rows.length > maxFiles;
    const report: KeyCopyReport = {
        mode: apply ? "apply" : "dry-run", status: "failed", checked: 0,
        alreadyVerified: 0, planned: 0, createdVerified: 0, racedVerified: 0,
        writesAttempted: 0, bytesVerified: 0, bytesUploaded: 0, remaining,
    };
    const pending: { row: Row; target: string; bytes: Buffer; hash: string }[] = [];
    // Preflight the entire bounded batch before writing even one object. This
    // includes archived variants whose legacy checksum is absent in PostgreSQL.
    for (const row of rows) {
        report.checked++;
        try {
            const { target, size } = validateRow(row);
            const bytes = await input.source.getBounded(row.storage_key, MAX_BYTES);
            const hash = createHash("sha256").update(bytes).digest("hex");
            if (bytes.length !== size || row.checksum !== null && row.checksum !== hash)
                throw new Error("Source bytes failed integrity validation.");
            report.bytesVerified += bytes.length;
            let destinationBytes: Buffer | null = null;
            try { destinationBytes = await input.destination.getBounded(target, MAX_BYTES); }
            catch (error) { if (!(error instanceof ObjectNotFound)) throw error; }
            if (destinationBytes !== null) {
                if (!matches(destinationBytes, size, hash)) throw new Error("Existing destination is corrupt.");
                report.bytesVerified += destinationBytes.length;
                report.alreadyVerified++;
            } else {
                pending.push({ row, target, bytes, hash });
                report.planned++;
            }
        } catch {
            report.failedIdentity = identity(row);
            return report;
        }
    }

    if (apply) {
        for (const item of pending) {
            report.writesAttempted++;
            try {
                const created = await input.destination.putIfAbsent!(item.target,item.bytes,item.row.mime_type);
                const bytes = await input.destination.getBounded(item.target,MAX_BYTES);
                if (!matches(bytes,item.bytes.length,item.hash))
                    throw new Error("Created Project key failed read-after-write verification.");
                report.bytesVerified += bytes.length;
                if (created) { report.createdVerified++; report.bytesUploaded += bytes.length; }
                else report.racedVerified++;
            } catch {
                // Ambiguous acknowledgement can mean the copy exists. Retain
                // both objects and retry this exact batch, not the next cursor.
                report.failedIdentity = identity(item.row);
                return report;
            }
        }
    }
    if (rows.length) report.nextCursor = encodeKeyCopyCursor(identity(rows[rows.length - 1]!));
    report.status = rows.length === 0 ? "empty" : remaining ? "partial" : apply ? "completed" : "ready";
    return report;
}
