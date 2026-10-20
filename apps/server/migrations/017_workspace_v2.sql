-- Workspaces are Node-owned resources. Projects are optional associations.
-- Preserve every existing Workspace ID, binding and audit row.
DROP INDEX IF EXISTS workspaces_one_active_project;
ALTER TABLE workspaces ALTER COLUMN project_id DROP NOT NULL;

CREATE TABLE workspace_project_links (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, project_id)
);
INSERT INTO workspace_project_links (workspace_id, project_id)
SELECT id, project_id FROM workspaces WHERE project_id IS NOT NULL
ON CONFLICT DO NOTHING;
CREATE INDEX workspace_project_links_project_idx ON workspace_project_links(project_id);
-- Only one active Atlas binding for a given physical directory on a Node.
CREATE UNIQUE INDEX workspaces_one_active_node_root
ON workspaces(node_id, root_path) WHERE archived_at IS NULL;
