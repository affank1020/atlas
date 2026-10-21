-- Project associations belong to logical Workspaces, not Node-bound checkouts.
-- Promote every existing checkout association (including archived checkouts)
-- without modifying the original checkout identities, Node paths or audit history.
CREATE TABLE logical_workspace_project_links (
    logical_workspace_id uuid NOT NULL REFERENCES logical_workspaces(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (logical_workspace_id, project_id)
);
CREATE INDEX logical_workspace_project_links_project_idx
    ON logical_workspace_project_links(project_id);

INSERT INTO logical_workspace_project_links(logical_workspace_id, project_id, created_at)
SELECT w.logical_workspace_id, l.project_id, MIN(l.created_at)
FROM workspace_project_links l
JOIN workspaces w ON w.id=l.workspace_id
GROUP BY w.logical_workspace_id, l.project_id
ON CONFLICT DO NOTHING;

-- Preserve any non-null legacy primary association missing from an older link row.
INSERT INTO logical_workspace_project_links(logical_workspace_id, project_id)
SELECT DISTINCT w.logical_workspace_id, w.project_id
FROM workspaces w WHERE w.project_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Transitional compatibility mirror: existing Project-oriented callers still
-- find checkouts under all Projects associated with their logical Workspace.
INSERT INTO workspace_project_links(workspace_id, project_id)
SELECT w.id, lp.project_id
FROM workspaces w
JOIN logical_workspace_project_links lp ON lp.logical_workspace_id=w.logical_workspace_id
ON CONFLICT DO NOTHING;

-- The legacy primary project remains an optional, deterministic representative.
-- Preserve a checkout's previous primary when it is still associated.
UPDATE workspaces w
SET project_id = (
    SELECT lp.project_id
    FROM logical_workspace_project_links lp
    WHERE lp.logical_workspace_id=w.logical_workspace_id
    ORDER BY (lp.project_id = w.project_id) DESC, lp.created_at, lp.project_id
    LIMIT 1
)
WHERE w.project_id IS NULL
  AND EXISTS (
      SELECT 1 FROM logical_workspace_project_links lp
      WHERE lp.logical_workspace_id=w.logical_workspace_id
  );
