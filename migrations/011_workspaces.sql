CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  root_path text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('generic','unity')),
  adapter text CHECK (adapter = 'unity'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK ((kind='unity' AND adapter='unity') OR (kind='generic' AND adapter IS NULL))
);
CREATE UNIQUE INDEX workspaces_one_active_project ON workspaces(project_id) WHERE archived_at IS NULL;
CREATE INDEX workspaces_project_idx ON workspaces(project_id);
ALTER TABLE audit_events ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
CREATE INDEX audit_events_workspace_idx ON audit_events(workspace_id);
