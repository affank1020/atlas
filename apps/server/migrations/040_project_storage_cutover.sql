-- Operator-only, non-destructive Project Storage V2 key-switch history.
-- The immutable Stage 4B manifest referenced by EACH attempt is its exact
-- rollback map. A rolled-back attempt is never rewritten or reused.
-- No automatic cutover, R2 deletion, or retention change.
CREATE TABLE atlas_project_storage_cutovers (
    attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
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
-- At most one outstanding switched catalogue per Project. Previous attempts
-- remain queryable; no deletion/reset is needed for an approved fresh run.
CREATE UNIQUE INDEX atlas_project_storage_cutovers_one_active
  ON atlas_project_storage_cutovers(project_id) WHERE state='applied';
CREATE INDEX atlas_project_storage_cutovers_history
  ON atlas_project_storage_cutovers(project_id,attempt_id DESC);
COMMENT ON TABLE atlas_project_storage_cutovers IS
  'Append-only cutover attempts with non-destructive rollback state. Every key run is single-use and its immutable Stage 4B manifest preserves exact old/new mappings. Source and destination R2 objects are not deleted.';
