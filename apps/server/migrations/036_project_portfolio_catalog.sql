-- A reversible, read-only Project storage projection. No media or Atlas Files
-- rows are inserted, updated or deleted by this migration, and no object key
-- is rewritten. A view keeps historical and future Portfolio uploads in sync
-- without a fragile backfill or competing catalogue ownership.
--
-- Identity is (project_id, source, file_id, variant). The original retains
-- media_assets.id; derivatives retain media_variants.name. Do not treat a
-- derivative's absent SHA-256 as an integrity-verified object.
CREATE VIEW atlas_project_storage_objects AS
SELECT f.owner_id AS project_id,
       'atlas-file'::text AS source,
       f.id AS file_id,
       'original'::text AS variant,
       f.storage_key,
       f.checksum,
       f.byte_size,
       f.file_name,
       f.mime_type,
       f.status,
       f.created_at,
       f.updated_at
  FROM atlas_files f
 WHERE f.owner_kind = 'project'
UNION ALL
SELECT 'd99a6c45-a4ec-5ef6-8f22-c07d31f8bb38'::text AS project_id,
       'portfolio-media'::text AS source,
       a.id AS file_id,
       'original'::text AS variant,
       a.storage_key,
       a.checksum,
       a.byte_size,
       a.original_name AS file_name,
       a.mime_type,
       a.status,
       a.created_at,
       a.updated_at
  FROM media_assets a
UNION ALL
SELECT 'd99a6c45-a4ec-5ef6-8f22-c07d31f8bb38'::text AS project_id,
       'portfolio-media'::text AS source,
       a.id AS file_id,
       v.name AS variant,
       v.storage_key,
       NULL::text AS checksum,
       v.byte_size,
       a.original_name AS file_name,
       v.mime_type,
       a.status,
       a.created_at,
       a.updated_at
  FROM media_variants v
  JOIN media_assets a ON a.id = v.asset_id;

COMMENT ON VIEW atlas_project_storage_objects IS
  'Read-only, reversible mapping of Project Files and Portfolio originals/variants; source tables and object keys remain authoritative.';
