-- Fabric can index material that is derived from systems other than Atlas Core.
-- Core remains canonical: these rows are disposable search projections.
ALTER TABLE fabric_semantic_documents
  DROP CONSTRAINT IF EXISTS fabric_semantic_documents_record_id_fkey;

ALTER TABLE fabric_search_documents
  DROP CONSTRAINT IF EXISTS fabric_search_documents_record_id_fkey,
  DROP CONSTRAINT IF EXISTS fabric_search_documents_project_id_fkey,
  DROP CONSTRAINT IF EXISTS fabric_search_documents_store_id_fkey;

ALTER TABLE fabric_search_documents
  ADD COLUMN source_type text NOT NULL DEFAULT 'atlas-core',
  ADD COLUMN source_id text,
  ADD COLUMN record_data jsonb,
  ADD COLUMN record_created_at timestamptz,
  ADD COLUMN record_updated_at timestamptz;

UPDATE fabric_search_documents d
SET source_id = d.record_id::text,
    record_data = r.data,
    record_created_at = r.created_at,
    record_updated_at = r.updated_at
FROM records r
WHERE r.id = d.record_id;

ALTER TABLE fabric_search_documents
  ALTER COLUMN source_id SET NOT NULL,
  ALTER COLUMN record_data SET NOT NULL,
  ALTER COLUMN record_created_at SET NOT NULL,
  ALTER COLUMN record_updated_at SET NOT NULL;

CREATE UNIQUE INDEX fabric_search_documents_source_idx
  ON fabric_search_documents(source_type, source_id);

CREATE TABLE contentful_sync_state (
  integration text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('not_configured', 'idle', 'syncing', 'failed')),
  last_trigger text,
  last_event text,
  last_started_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contentful_webhook_deliveries (
  idempotency_key text PRIMARY KEY,
  topic text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
