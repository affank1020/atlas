import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { AtlasError } from "../shared/errors.js";
import { ProjectFileFolders, folderId as parseFolderId } from "./project-file-folders.js";
import { listPortfolioProjectMedia, type ProjectPortfolioMedia } from "./project-storage-catalog.js";
import { createObjectStore, ObjectNotFound, projectStorageKey, R2ObjectStore, type ObjectStore, type R2StorageConfig } from "./file-storage.js";

export type FileOwner = { kind: "project" | "workspace" | "application"; id: string };
export type FileVisibility = "private" | "public";
export type AtlasFile = {
    id: string; owner: FileOwner; fileName: string; mimeType: string;
    byteSize: number; checksum: string; visibility: FileVisibility;
    status: "active" | "archived"; folderId: string | null; createdAt: string; updatedAt: string;
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
        status: row.status as AtlasFile["status"], folderId: row.folder_id === null || row.folder_id === undefined ? null : String(row.folder_id),
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
    readonly folders: ProjectFileFolders;
    private readonly r2Signer: R2ObjectStore | null;
    constructor(databaseUrl: string, root: string, r2: R2StorageConfig | null = null, objects?: ObjectStore,
        readonly versionedProjectWrites = false) {
        this.pool = new Pool({ connectionString: databaseUrl });
        this.folders = new ProjectFileFolders(this.pool);
        this.objects = objects ?? createObjectStore(root, r2);
        this.r2Signer = r2 ? new R2ObjectStore(r2) : null;
    }
    async close() { await this.pool.end(); }

    async portfolioCatalog(projectId: string): Promise<ProjectPortfolioMedia[]> {
        return listPortfolioProjectMedia(this.pool, projectId);
    }

    async list(ownerInput: FileOwner, status: AtlasFile["status"] = "active", destination?: string | null): Promise<AtlasFile[]> {
        const owner = ownerScope(ownerInput);
        if (status !== "active" && status !== "archived") throw new AtlasError("Invalid Atlas Files status.");
        if (destination !== undefined && owner.kind !== "project")
            throw new AtlasError("Folder browsing requires Project ownership.");
        const folder = destination === undefined ? undefined : parseFolderId(destination);
        const result = folder === undefined
            ? await this.pool.query(
                "SELECT * FROM atlas_files WHERE owner_kind=$1 AND owner_id=$2 AND status=$3 ORDER BY created_at DESC",
                [owner.kind, owner.id, status])
            : await this.pool.query(
                "SELECT * FROM atlas_files WHERE owner_kind='project' AND owner_id=$1 AND status=$2 AND folder_id IS NOT DISTINCT FROM $3::uuid ORDER BY created_at DESC",
                [owner.id, status, folder]);
        return result.rows.map(fileRow);
    }
    /** Bounded, project-only listing for the owner-authorized MCP transport. */
    async listProjectPage(projectId: string, folderId?: string | null, limit = 50, offset = 0):
        Promise<{ files: AtlasFile[]; hasMore: boolean }> {
        if (!UUID.test(projectId) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
            !Number.isInteger(offset) || offset < 0 || offset > 10000)
            throw new AtlasError("Invalid Project file listing.");
        const folder = folderId === undefined ? undefined : parseFolderId(folderId);
        const params: (string | number | null)[] = [projectId.toLowerCase()];
        const folderWhere = folder === undefined ? "" : " AND folder_id IS NOT DISTINCT FROM $2::uuid";
        if (folder !== undefined) params.push(folder);
        params.push(limit + 1);
        const limitParam = params.length;
        params.push(offset);
        const offsetParam = params.length;
        const rows = await this.pool.query(
            `SELECT * FROM atlas_files WHERE owner_kind='project' AND owner_id=$1
             AND status='active'${folderWhere} ORDER BY created_at DESC, id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
            params);
        return { files: rows.rows.slice(0, limit).map(fileRow), hasMore: rows.rows.length > limit };
    }

    /**
     * Return an R2 capability URL only for the exact active Project-owned file.
     * No bytes or storage keys enter the MCP response. This does not expose a
     * public bucket, and the signed link expires after two minutes.
     * Legacy local-only files cannot be linked using R2.
     */
    async projectDownloadLink(projectId: string, fileId: string):
        Promise<{ file: AtlasFile; downloadUrl: string | null; expiresAt: string | null; availability: "r2" | "r2_not_configured" }> {
        if (!UUID.test(projectId) || !UUID.test(fileId)) throw new AtlasError("Invalid Project file identity.");
        const selected = await this.pool.query(
            "SELECT * FROM atlas_files WHERE id=$1 AND owner_kind='project' AND owner_id=$2 AND status='active'",
            [fileId.toLowerCase(), projectId.toLowerCase()]);
        if (!selected.rows[0]) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
        const row = selected.rows[0]!;
        const file = fileRow(row);
        if (!this.r2Signer)
            return { file, downloadUrl: null, expiresAt: null, availability: "r2_not_configured" };
        const signed = this.r2Signer.presignGet(String(row.storage_key), 120);
        return { file, downloadUrl: signed.url, expiresAt: signed.expiresAt, availability: "r2" };
    }

    async upload(input: {
        owner: FileOwner; fileName: string; mimeType: string; bytes: Buffer;
        visibility?: FileVisibility; client?: string; database?: PoolClient; folderId?: string | null;
    }): Promise<AtlasFile> {
        const owner = ownerScope(input.owner);
        if (input.folderId !== undefined && owner.kind !== "project")
            throw new AtlasError("Only Project files may specify folders.");
        const destination = input.folderId === undefined ? null : parseFolderId(input.folderId);
        // The database scope trigger rechecks destination status after the object PUT,
        // so concurrent archival cannot attach a new active file to an archived folder.
        if (destination !== null) {
            const selected = await this.pool.query(
                "SELECT id FROM atlas_file_folders WHERE id=$1 AND project_id=$2 AND status='active'",
                [destination, owner.id]);
            if (!selected.rows[0]) throw new AtlasError("Project folder was not found.", "NOT_FOUND");
        }
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
        // Existing legacy reads and Workspace/Application uploads stay unchanged.
        // Enable only after migration of existing Project-owned objects, since
        // the historical immutable copy ledger captures legacy source keys.
        const storageKey = this.versionedProjectWrites && owner.kind === "project"
            ? projectStorageKey(owner.id,id) : `files-${id.replaceAll("-", "")}-${checksum}`;
        try {
            await this.objects.put(storageKey, input.bytes, input.mimeType);
            const result = await (input.database ?? this.pool).query(
                `INSERT INTO atlas_files(id,owner_kind,owner_id,storage_key,checksum,file_name,mime_type,byte_size,visibility,created_by,folder_id)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
                [id,owner.kind,owner.id,storageKey,checksum,fileName,input.mimeType,input.bytes.length,visibility,input.client ?? "atlas-files",destination]);
            return fileRow(result.rows[0]!);
        } catch (error) {
            // A PUT or INSERT may have committed despite a lost acknowledgement.
            // Verify durable metadata before deleting; on database uncertainty
            // retain the object rather than risking destruction of a valid file.
            try { await this.discardUncommitted({ id, checksum, owner }); }
            catch { console.error("Atlas Files could not confirm/clean an uncommitted object."); }
            if ((error as { code?: string })?.code === "23514" && destination !== null)
                throw new AtlasError("Project folder is no longer available.");
            throw error;
        }
    }

    /** Call only after the caller's transaction has completed or rolled back.
     *  A failed/ambiguous COMMIT may have succeeded: never delete if metadata
     *  exists, and never delete if the database cannot prove its absence. */
    async discardUncommitted(file: Pick<AtlasFile, "id" | "checksum"> & {owner?:FileOwner}): Promise<boolean> {
        if (!UUID.test(file.id) || !/^[a-f0-9]{64}$/.test(file.checksum))
            throw new AtlasError("Invalid pending Atlas file.");
        const owner = file.owner === undefined ? undefined : ownerScope(file.owner);
        const storageKey = this.versionedProjectWrites && owner?.kind === "project"
            ? projectStorageKey(owner.id,file.id)
            : `files-${file.id.replaceAll("-", "")}-${file.checksum}`;
        const result = await this.pool.query(
            "SELECT id FROM atlas_files WHERE id=$1 OR storage_key=$2",
            [file.id, storageKey]);
        if (result.rowCount) return false;
        await this.objects.delete(storageKey);
        return true;
    }
    async metadata(ownerInput: FileOwner, id: string): Promise<AtlasFile> {
        const owner = ownerScope(ownerInput);
        const result = await this.pool.query(
            "SELECT * FROM atlas_files WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 AND status='active'",
            [id,owner.kind,owner.id]);
        if (!result.rows[0]) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
        return fileRow(result.rows[0]);
    }
    private async verifiedBytes(row: Record<string, unknown>): Promise<Buffer> {
        const bytes = await this.objects.get(String(row.storage_key)).catch(error => {
            if (error instanceof ObjectNotFound) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
            throw error;
        });
        // Never return or restore metadata for missing, corrupted or truncated bytes.
        if (bytes.length !== Number(row.byte_size) ||
            createHash("sha256").update(bytes).digest("hex") !== row.checksum)
            throw new Error("Atlas Files object integrity verification failed.");
        return bytes;
    }
    async download(ownerInput: FileOwner, id: string): Promise<{ file: AtlasFile; bytes: Buffer }> {
        const owner = ownerScope(ownerInput);
        const result = await this.pool.query(
            "SELECT * FROM atlas_files WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 AND status='active'",
            [id,owner.kind,owner.id]);
        if (!result.rows[0]) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
        const row = result.rows[0]!;
        return { file: fileRow(row), bytes: await this.verifiedBytes(row) };
    }
    async archive(ownerInput: FileOwner, id: string): Promise<void> {
        const owner = ownerScope(ownerInput);
        const result = await this.pool.query(
            "UPDATE atlas_files SET status='archived',updated_at=now() WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 AND status='active' RETURNING id",
            [id,owner.kind,owner.id]);
        if (!result.rows[0]) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
        // Archiving never deletes physical bytes. A separate, explicit policy
        // and verified backup are required before implementing garbage collection.
    }
    async restore(ownerInput: FileOwner, id: string): Promise<AtlasFile> {
        const owner = ownerScope(ownerInput);
        const result = await this.pool.query(
            "SELECT * FROM atlas_files WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 AND status='archived'",
            [id, owner.kind, owner.id]);
        if (!result.rows[0]) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
        // Archived folders cannot receive active Files, even during restore.
        const archived = result.rows[0]!;
        if (archived.folder_id !== null) {
            const folder = await this.pool.query(
                "SELECT id FROM atlas_file_folders WHERE id=$1 AND project_id::text=$2 AND status='active'",
                [archived.folder_id, owner.id]);
            if (!folder.rows[0]) throw new AtlasError("Restore the containing Project folder first.");
        }
        // Verify retained bytes before making the file downloadable again.
        await this.verifiedBytes(archived);
        const restored = await this.pool.query(
            "UPDATE atlas_files SET status='active',updated_at=now() WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 AND status='archived' RETURNING *",
            [id, owner.kind, owner.id]);
        if (!restored.rows[0]) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
        return fileRow(restored.rows[0]);
    }
}
