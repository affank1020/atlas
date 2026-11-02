ALTER TABLE agent_runs ADD COLUMN started_at timestamptz;
UPDATE agent_runs SET started_at=(receipt->>'startedAt')::timestamptz WHERE receipt->>'startedAt' IS NOT NULL;
CREATE INDEX agent_runs_owner_checkout_created ON agent_runs(owner_key,checkout_id,created_at DESC,id DESC);
CREATE INDEX agent_runs_owner_node_created ON agent_runs(owner_key,node_id,created_at DESC,id DESC);
