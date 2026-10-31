-- Stage 4B: additive, operator-only migration checkpoint ledger.
-- No triggers on live asset tables, no object-key rewrites, and no production
-- data movement. Catalog snapshots and copy receipts are separate metadata.
CREATE TABLE atlas_project_key_runs (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id),
    manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
    object_count integer NOT NULL CHECK (object_count BETWEEN 1 AND 1000),
    captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX atlas_project_key_runs_project ON atlas_project_key_runs(project_id,captured_at DESC);

CREATE TABLE atlas_project_key_manifest (
    run_id uuid NOT NULL REFERENCES atlas_project_key_runs(id) ON DELETE RESTRICT,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 999),
    source text NOT NULL CHECK (source IN ('atlas-file','portfolio-media')),
    file_id uuid NOT NULL,
    variant text NOT NULL CHECK (variant <> ''),
    source_key text NOT NULL,
    target_key text NOT NULL,
    checksum text,
    byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
    mime_type text NOT NULL,
    status text NOT NULL CHECK (status IN ('active','archived')),
    PRIMARY KEY(run_id,ordinal),
    UNIQUE(run_id,source,file_id,variant),
    UNIQUE(run_id,target_key)
);

CREATE TABLE atlas_project_key_receipts (
    run_id uuid NOT NULL,
    ordinal integer NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
    created_new boolean NOT NULL,
    verified_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(run_id,ordinal),
    FOREIGN KEY(run_id,ordinal) REFERENCES atlas_project_key_manifest(run_id,ordinal) ON DELETE RESTRICT
);

COMMENT ON TABLE atlas_project_key_runs IS
 'Operator-only Project key migration manifest: durable metadata snapshot, not a DR or cutover certificate.';
COMMENT ON TABLE atlas_project_key_receipts IS
 'Verified source/new key copy receipt; source and destination bytes must be rechecked for DR acceptance.';
