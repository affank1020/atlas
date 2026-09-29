CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX projects_active_name_idx ON projects (lower(name)) WHERE archived_at IS NULL;
CREATE INDEX projects_updated_at_idx ON projects (updated_at DESC);

CREATE TABLE stores (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  description text,
  archived_at timestamptz,
  current_schema_version integer NOT NULL CHECK (current_schema_version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX stores_active_name_idx ON stores (project_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX stores_project_id_idx ON stores (project_id);
CREATE INDEX stores_updated_at_idx ON stores (updated_at DESC);

CREATE TABLE store_schemas (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(store_id, version)
);
CREATE INDEX store_schemas_store_id_idx ON store_schemas (store_id, version DESC);

CREATE TABLE records (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  data jsonb NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX records_store_id_idx ON records (store_id);
CREATE INDEX records_active_store_idx ON records (store_id) WHERE archived_at IS NULL;
CREATE INDEX records_created_at_idx ON records (created_at);
CREATE INDEX records_updated_at_idx ON records (updated_at DESC);
CREATE INDEX records_data_gin_idx ON records USING gin (data);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  client text NOT NULL,
  operation text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  record_id uuid REFERENCES records(id) ON DELETE SET NULL,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX audit_events_project_id_idx ON audit_events (project_id);
CREATE INDEX audit_events_store_id_idx ON audit_events (store_id);
CREATE INDEX audit_events_record_id_idx ON audit_events (record_id);
CREATE INDEX audit_events_created_at_idx ON audit_events (created_at DESC);
