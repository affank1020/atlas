-- Operator-only, non-destructive Project Storage V2 key-switch record.
-- The immutable Stage 4B manifest referenced here is the durable rollback map.
-- No triggers, automatic cutover, or R2 object deletion.
CREATE TABLE atlas_project_storage_cutovers (
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
    key_run_id uuid NOT NULL UNIQUE REFERENCES atlas_project_key_runs(id) ON DELETE RESTRICT,
    manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
    object_count integer NOT NULL CHECK (object_count BETWEEN 1 AND 1000),
    state text NOT NULL CHECK (state IN ('applied','rolled_back')),
    applied_at timestamptz NOT NULL DEFAULT now(),
    rolled_back_at timestamptz,
    CHECK (
      (state = 'applied' AND rolled_back_at IS NULL) OR
      (state = 'rolled_back' AND rolled_back_at IS NOT NULL)
    )
);
COMMENT ON TABLE atlas_project_storage_cutovers IS
  'Manual reversible metadata cutover. The associated immutable Stage 4B manifest retains exact old/new keys. Original and destination R2 bytes are NOT deleted.';
