import { randomUUID } from "node:crypto";
import { type Pool, type PoolClient } from "pg";
import { AtlasError } from "../shared/errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ProjectFileFolder = {
    id: string; projectId: string; parentId: string | null; name: string;
    status: "active" | "archived"; createdAt: string; updatedAt: string;
};
function projectId(value: string): string {
    if (typeof value !== "string" || !UUID.test(value)) throw new AtlasError("Invalid Project ID.");
    return value.toLowerCase();
}
export function folderId(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== "string" || !UUID.test(value)) throw new AtlasError("Invalid folder ID.");
    return value.toLowerCase();
}
function folderName(value: string): string {
    if (typeof value !== "string" || !value.length || [...value].length > 255 ||
        value !== value.trim() || value === "." || value === ".." || /[\\/\u0000-\u001f\u007f-\u009f]/u.test(value))
        throw new AtlasError("Invalid Project folder name.");
    return value;
}
function folderRow(row: Record<string, unknown>): ProjectFileFolder {
    return {
        id: String(row.id), projectId: String(row.project_id), parentId: row.parent_id === null ? null : String(row.parent_id),
        name: String(row.name), status: row.status as ProjectFileFolder["status"],
        createdAt: new Date(row.created_at as string | Date).toISOString(),
        updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    };
}
function notFound(): never { throw new AtlasError("Project folder was not found.", "NOT_FOUND"); }
function dbError(error: unknown): never {
    if ((error as { code?: string })?.code === "23505") throw new AtlasError("A folder with this name already exists.");
    if ((error as { code?: string })?.code === "23503" || (error as { code?: string })?.code === "23514")
        throw new AtlasError("Invalid folder hierarchy or Project scope.");
    throw error;
}

/** Metadata-only Project folder operations. No R2 object is moved or removed.
 * Callers must authorise the Project before using this service. */
export class ProjectFileFolders {
    constructor(readonly pool: Pool) {}
    private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const result = await fn(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch { /* original failure is authoritative */ }
            dbError(error);
        } finally { client.release(); }
    }
    private async activeDestination(client: PoolClient, project: string, destination: string | null) {
        if (destination === null) return;
        // SHARE conflicts with archival's FOR UPDATE lock. Destination validation
        // and metadata writes must happen in the same transaction.
        const found = await client.query(
            "SELECT id FROM atlas_file_folders WHERE id=$1 AND project_id=$2 AND status='active' FOR SHARE",
            [destination, project]);
        if (!found.rows[0]) notFound();
    }
    async list(projectInput: string): Promise<ProjectFileFolder[]> {
        const project = projectId(projectInput);
        const result = await this.pool.query(
            "SELECT * FROM atlas_file_folders WHERE project_id=$1 ORDER BY parent_id NULLS FIRST,lower(name),id",
            [project]);
        return result.rows.map(folderRow);
    }
    async create(projectInput: string, parentInput: string | null, nameInput: string, clientName = "Atlas Web"): Promise<ProjectFileFolder> {
        const project = projectId(projectInput), parent = folderId(parentInput), name = folderName(nameInput);
        return this.transaction(async client => {
            await this.activeDestination(client, project, parent);
            const result = await client.query(
                `INSERT INTO atlas_file_folders(id,project_id,parent_id,name,created_by)
                 VALUES($1,$2,$3,$4,$5) RETURNING *`,
                [randomUUID(), project, parent, name, clientName]);
            return folderRow(result.rows[0]!);
        });
    }
    async rename(projectInput: string, idInput: string, nameInput: string): Promise<ProjectFileFolder> {
        const project = projectId(projectInput), id = folderId(idInput), name = folderName(nameInput);
        const result = await this.pool.query(
            `UPDATE atlas_file_folders SET name=$3,updated_at=now()
             WHERE project_id=$1 AND id=$2 AND status='active' RETURNING *`, [project, id, name])
            .catch(dbError);
        if (!result.rows[0]) notFound();
        return folderRow(result.rows[0]);
    }
    async archive(projectInput: string, idInput: string): Promise<ProjectFileFolder> {
        const project = projectId(projectInput), id = folderId(idInput);
        return this.transaction(async client => {
            const selected = await client.query(
                "SELECT * FROM atlas_file_folders WHERE project_id=$1 AND id=$2 AND status='active' FOR UPDATE",
                [project, id]);
            if (!selected.rows[0]) notFound();
            // Non-empty folders cannot be archived: children and active files
            // must first be archived or moved. Archived files retain their keys.
            const contents = await client.query(
                `SELECT EXISTS(SELECT 1 FROM atlas_file_folders WHERE parent_id=$1 AND status='active')
                 OR EXISTS(SELECT 1 FROM atlas_files WHERE owner_kind='project' AND owner_id=$2 AND folder_id=$1 AND status='active') AS populated`,
                [id, project]);
            if (contents.rows[0]?.populated) throw new AtlasError("Move or archive active folder contents first.");
            const updated = await client.query(
                "UPDATE atlas_file_folders SET status='archived',updated_at=now() WHERE id=$1 RETURNING *", [id]);
            return folderRow(updated.rows[0]!);
        });
    }
    async restore(projectInput: string, idInput: string): Promise<ProjectFileFolder> {
        const project = projectId(projectInput), id = folderId(idInput);
        return this.transaction(async client => {
            const selected = await client.query(
                "SELECT * FROM atlas_file_folders WHERE project_id=$1 AND id=$2 AND status='archived' FOR UPDATE",
                [project, id]);
            if (!selected.rows[0]) notFound();
            await this.activeDestination(client, project, selected.rows[0].parent_id as string | null);
            const updated = await client.query(
                "UPDATE atlas_file_folders SET status='active',updated_at=now() WHERE id=$1 RETURNING *", [id]);
            return folderRow(updated.rows[0]!);
        });
    }
    async moveFile(projectInput: string, fileInput: string, destinationInput: string | null): Promise<void> {
        const project = projectId(projectInput), id = folderId(fileInput), destination = folderId(destinationInput);
        await this.transaction(async client => {
            await this.activeDestination(client, project, destination);
            const updated = await client.query(
                `UPDATE atlas_files SET folder_id=$3,updated_at=now()
                 WHERE id=$1 AND owner_kind='project' AND owner_id=$2 AND status='active' RETURNING id`,
                [id, project, destination]);
            if (!updated.rows[0]) throw new AtlasError("Atlas file was not found.", "NOT_FOUND");
        });
    }
}
