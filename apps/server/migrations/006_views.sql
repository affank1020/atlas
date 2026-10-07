CREATE TABLE views (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  slug text,
  description text,
  queries jsonb NOT NULL,
  html text NOT NULL,
  css text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX views_active_name_idx ON views (project_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX views_active_slug_idx ON views (project_id, lower(slug)) WHERE archived_at IS NULL AND slug IS NOT NULL;
CREATE INDEX views_project_id_idx ON views (project_id);
CREATE INDEX views_updated_at_idx ON views (updated_at DESC);
ALTER TABLE audit_events ADD COLUMN view_id uuid REFERENCES views(id) ON DELETE SET NULL;
CREATE INDEX audit_events_view_id_idx ON audit_events (view_id);
