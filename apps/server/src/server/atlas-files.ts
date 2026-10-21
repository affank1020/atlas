import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AtlasError } from "../shared/errors.js";
import { createObjectStore, ObjectNotFound, type ObjectStore, type R2StorageConfig } from "./file-storage.js";

export type FileOwner = { kind: "project" | "workspace" | "application"; id: string };
export type FileVisibility = "private" | "public";
export type AtlasFile = {
    id: string; owner: FileOwner; fileName: string; mimeType: string;
    byteSize: number; checksum: string; visibility: FileVisibility;
    status: "active" | "archived"; createdAt: string; updatedAt: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ID = /^[a-z][a-z0-9-]{0,79}$/;
const MAX_BYTES = 25 * 1024 * 1024;

function ownerScope(owner: FileOwner): FileOwner {
    if (!owner || !["project", "workspace", "application"].includes(owner.kind)
        || typeof owner.id !== "string" || !(owner.kind === "application" ? APP_ID : UUID).test(owner.id))
        throw new AtlasError("Invalid Atlas Files ownership scope.");
    return { kind: owner.kind, id: owner.id.toLowerCase() };
}
function fileRow(row: Record<string, unknown>): AtlasFile {
    return {
        id: String(row.id), owner: { kind: row.owner_kind as FileOwner["kind"], id: String(row.owner_id) },
        fileName: String(row.file_name), mimeType: String(row.mime_type), byteSize: Number(row.byte_size),
        checksum: String(row.checksum), visibility: row.visibility as FileVisibility,
        status: row.status as AtlasFile["status"],
        createdAt: new Date(row.created_at as string | Date).toISOString(),
        updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    };
}

/**
 * Private internal API for independent Atlas applications and workspaces.
 * Callers must authenticate/authorise the requested owner before using this
 * service. No generic unauthenticated HTTP or MCP tool is exposed.
 *
 * Portfolio retains its existing media metadata, routes and image processing;
 * both services now share the same object-store implementation.
 */
export class AtlasFilesService {
    readonly pool: Pool;
    readonly objects: ObjectStore;
    constructor(databaseUrl: string, root: string, r2: R2StorageConfig | null = null, objects?: ObjectStore) {
        this.pool = new Pool({ connectionString: databaseUrl });
        this.objects = objects ?? createObjectStore(root, r2);
    }
    async close() { await this.pool.end(); }

    async list(ownerInput: FileOwner): Promise<AtlasFile[]> {
        const owner = ownerScope(ownerInput);
        const result = await this.pool.query(
            "SELECT * FROM atlas_files WHERE owner_kind=$1 AND owner_id=$2 AND status='active' ORDER BY created_at DESC",
            [owner.kind, owner.id]);
        return result.rows.map(fileRow);
    }
    async upload(input: {
        owner: FileOwner; fileName: string; mimeType: string; bytes: Buffer;
        visibility?: FileVisibility; client?: string;
    }): Promise<AtlasFile> {
        const owner = ownerScope(input.owner);
        const fileName = input.fileName?.trim();
        if (!fileName || fileName.length > 255 || /[\\/\u0000-\u001f]/.test(fileName))
            throw new AtlasError("Invalid Atlas file name.");
        if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(input.mimeType ?? ""))
            throw new AtlasError("Invalid Atlas file MIME type.");
        if (!Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > MAX_BYTES)
            throw new AtlasError("Atlas Files accepts nonempty buffers up to 25 MiB.");
        const visibility = input.visibility ?? "private";
        if (visibility !== "private" && visibility !== "public") throw new AtlasError("Invalid Atlas file visibility.");
        const id = randomUUID();
        const checksum = createHash("sha256").update(input.bytes).digest("hex");
        const storageKey = `files-${id.replaceAll("-", "")}-${checksum}`;
        await this.objects.put(storageKey, input.bytes, input.mimeType);
        const result = await this.pool.query(
            `INSERT INTO atlas_files(id,owner_kind,owner_id,storage_key,checksum,file_name,mime_type,byte_size,visibility,created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [id,owner.kind,owner.id,storageKey,checksum,fileName,input.mimeType,input.bytes.length,visibility,input.client ?? "atlas-files"]);
        return fileRow(result.rows[0]!);
    }
    async metadata(ownerInput: FileOwner, id: string): Promise<AtlasFile> {
        const owner = ownerScope(ownerInput);
        const result = await this.pool.query(
            "SELECT * FROM atlas_files WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 AND status='active'",
            [id,owner.kind,owner.id]);
        if (!result.rows[0]) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
        return fileRow(result.rows[0]);
    }
    async download(ownerInput: FileOwner, id: string): Promise<{ file: AtlasFile; bytes: Buffer }> {
        const owner = ownerScope(ownerInput);
        const result = await this.pool.query(
            "SELECT * FROM atlas_files WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 AND status='active'",
            [id,owner.kind,owner.id]);
        if (!result.rows[0]) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
        const row = result.rows[0]!;
        const bytes = await this.objects.get(row.storage_key).catch(error => {
            if (error instanceof ObjectNotFound) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
            throw error;
        });
        return { file: fileRow(row), bytes };
    }
    async archive(ownerInput: FileOwner, id: string): Promise<void> {
        const owner = ownerScope(ownerInput);
        const result = await this.pool.query(
            "UPDATE atlas_files SET status='archived',updated_at=now() WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 AND status='active' RETURNING id",
            [id,owner.kind,owner.id]);
        if (!result.rows[0]) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
        // Physical deletion and retention are deliberate follow-up work.
    }
}
