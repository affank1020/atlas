-- Logical Workspaces are repository or standalone development identities.
-- Existing workspaces retain their IDs and Node/path bindings as Checkouts.
-- This migration never guesses repository identity from names or directories.
CREATE TABLE logical_workspaces (
    id uuid PRIMARY KEY,
    name text NOT NULL, -- do not reject an existing legacy label during backfill
    repository text,
    kind text NOT NULL DEFAULT 'local' CHECK (kind IN ('local', 'git')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'git' AND repository IS NOT NULL) OR
           (kind = 'local' AND repository IS NULL)),
    CHECK (repository IS NULL OR repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
);
CREATE UNIQUE INDEX logical_workspaces_repository_unique
    ON logical_workspaces (lower(repository)) WHERE repository IS NOT NULL;

-- Preserve stable legacy checkout IDs by initially giving each existing
-- checkout its own logical identity. An explicit, verified reconciliation
-- later groups repositories across Nodes.
INSERT INTO logical_workspaces(id,name)
SELECT id,name FROM workspaces;

ALTER TABLE workspaces ADD COLUMN logical_workspace_id uuid REFERENCES logical_workspaces(id);
UPDATE workspaces SET logical_workspace_id = id;
ALTER TABLE workspaces ALTER COLUMN logical_workspace_id SET NOT NULL;
CREATE INDEX workspaces_logical_workspace_idx ON workspaces(logical_workspace_id);
