-- One persisted identity for this Atlas installation's local execution host.
CREATE TABLE nodes (
  id uuid PRIMARY KEY,
  local_key text UNIQUE CHECK (local_key IS NULL OR local_key = 'local'),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('online','offline','unavailable')),
  capabilities text[] NOT NULL DEFAULT '{}',
  last_seen timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO nodes(id,local_key,name,status,metadata)
VALUES(gen_random_uuid(),'local','Local Node','offline','{"runtime":"local"}');
ALTER TABLE workspaces ADD COLUMN node_id uuid REFERENCES nodes(id);
-- Include archived bindings; do not rewrite timestamps, IDs, paths or audit history.
UPDATE workspaces SET node_id=(SELECT id FROM nodes WHERE local_key='local');
ALTER TABLE workspaces ALTER COLUMN node_id SET NOT NULL;
CREATE INDEX workspaces_node_idx ON workspaces(node_id);
INSERT INTO audit_events(id,client,operation,after_state,created_at)
SELECT gen_random_uuid(),'atlas-migration','node.created',jsonb_build_object('nodeId',id,'name',name),now() FROM nodes WHERE local_key='local';
