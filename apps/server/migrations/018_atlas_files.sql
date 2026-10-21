-- Shared Atlas Files metadata. This intentionally leaves Portfolio's existing
-- media_assets/media_variants rows and public routes untouched.
-- Owner identities are scoped to a specific project, workspace or application.
-- File bytes live in the configured local store or private R2 bucket.
CREATE TABLE atlas_files (
  id uuid PRIMARY KEY,
  owner_kind text NOT NULL CHECK(owner_kind IN ('project', 'workspace', 'application')),
  owner_id text NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 120),
  storage_key text NOT NULL UNIQUE,
  checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
  file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 255),
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size > 0),
  visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'public')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX atlas_files_owner_idx ON atlas_files(owner_kind,owner_id,created_at DESC);
