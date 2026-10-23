import type { Pool } from "pg";
import { AtlasError } from "../shared/errors.js";
import { PORTFOLIO_PROJECT_ID } from "../portfolio/index.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export type ProjectPortfolioMedia = {
    id: string;
    projectId: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    checksum: string;
    status: "active" | "archived";
    createdAt: string;
    updatedAt: string;
    /** Public media delivery is unchanged; archived assets have no delivery URL. */
    url: string | null;
    /** Variant checksums do not exist in the legacy catalogue. Never infer them. */
    variants: { name: string; mimeType: string; byteSize: number }[];
};
type CatalogRow = {
    file_id: string; file_name: string; mime_type: string; byte_size: string;
    checksum: string; status: "active" | "archived";
    created_at: Date; updated_at: Date;
    variants: { name: string; mimeType: string; byteSize: string }[];
};
const LIMIT = 500;

/** Read-only projection. Neither the Portfolio tables nor object storage is
 * modified. In particular, this is not an Atlas Files upload/import path. */
export async function listPortfolioProjectMedia(pool: Pick<Pool, "query">, projectId: string):
    Promise<ProjectPortfolioMedia[]> {
    if (typeof projectId !== "string" || !UUID.test(projectId))
        throw new AtlasError("Invalid Project ID.");
    if (projectId.toLowerCase() !== PORTFOLIO_PROJECT_ID) return [];

    const rows = await pool.query<CatalogRow>(`
        SELECT a.file_id,a.file_name,a.mime_type,a.byte_size,a.checksum,a.status,a.created_at,a.updated_at,
               COALESCE((
                   SELECT json_agg(json_build_object(
                       'name',v.variant,'mimeType',v.mime_type,'byteSize',v.byte_size
                   ) ORDER BY v.variant)
                   FROM atlas_project_storage_objects v
                   WHERE v.project_id=a.project_id AND v.source=a.source
                     AND v.file_id=a.file_id AND v.variant<>'original'
               ),'[]'::json) AS variants
          FROM atlas_project_storage_objects a
         WHERE a.project_id=$1 AND a.source='portfolio-media' AND a.variant='original'
         ORDER BY a.created_at DESC,a.file_id
         LIMIT $2`, [PORTFOLIO_PROJECT_ID, LIMIT + 1]);
    // Explicitly fail rather than silently dropping media from an incomplete catalogue.
    if (rows.rows.length > LIMIT)
        throw new AtlasError("Portfolio catalogue exceeds the current bounded view; pagination is required.");
    return rows.rows.map(row => ({
        id: row.file_id,
        projectId: PORTFOLIO_PROJECT_ID,
        fileName: row.file_name,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        checksum: row.checksum,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        url: row.status === "active" ? `/api/media/${row.file_id}/original` : null,
        variants: row.variants.map(variant => ({
            name: variant.name, mimeType: variant.mimeType, byteSize: Number(variant.byteSize),
        })),
    }));
}
