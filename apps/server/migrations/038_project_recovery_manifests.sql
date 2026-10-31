-- Additive, operator-only manifests of verified bytes in independently
-- recoverable Project storage. Not a claim that any backup has been published.
CREATE TABLE atlas_project_recovery_runs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  catalog_sha256 text NOT NULL CHECK (catalog_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  object_count integer NOT NULL CHECK (object_count BETWEEN 1 AND 2000),
  versioned_copy_run_id uuid REFERENCES atlas_project_key_runs(id),
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX atlas_project_recovery_runs_project ON atlas_project_recovery_runs(project_id,captured_at DESC);

CREATE TABLE atlas_project_recovery_entries (
  run_id uuid NOT NULL REFERENCES atlas_project_recovery_runs(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 1999),
  source text NOT NULL CHECK (source IN ('atlas-file','portfolio-media')),
  file_id uuid NOT NULL,
  variant text NOT NULL,
  key_kind text NOT NULL CHECK (key_kind IN ('legacy','versioned')),
  storage_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
  status text NOT NULL CHECK (status IN ('active','archived')),
  PRIMARY KEY(run_id,ordinal),
  UNIQUE(run_id,storage_key),
  UNIQUE(run_id,source,file_id,variant,key_kind)
);
COMMENT ON TABLE atlas_project_recovery_runs IS
 'Byte-verified metadata inventory for independent R2 recovery; not a claim that backup bytes exist or that DB+R2 have an atomic restore point.';

-- Each receipt is a bounded source AND independent-backup byte verification
-- observed by an explicitly authorised apply batch. A complete set can be
-- aggregated across invocations; receipts are not proof of current R2 health.
CREATE TABLE atlas_project_recovery_receipts (
  run_id uuid NOT NULL,
  ordinal integer NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id,ordinal),
  FOREIGN KEY (run_id,ordinal) REFERENCES atlas_project_recovery_entries(run_id,ordinal) ON DELETE RESTRICT
);
COMMENT ON TABLE atlas_project_recovery_receipts IS
 'Durable per-entry evidence of byte-verified independent R2 copy at the time of each authorized seed; not a live-byte or DR-readiness guarantee.';
