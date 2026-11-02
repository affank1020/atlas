CREATE TABLE agent_approvals (
 id uuid PRIMARY KEY, run_id uuid UNIQUE NOT NULL, owner_key text NOT NULL,
 checkout_id uuid NOT NULL REFERENCES workspaces(id), node_id uuid NOT NULL REFERENCES nodes(id),
 root_path text NOT NULL, head text NOT NULL, branch text NOT NULL, instruction_sha256 text NOT NULL,
 timeout_ms integer NOT NULL CHECK(timeout_ms BETWEEN 100 AND 600000),
 profile jsonb NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_runs (
 id uuid PRIMARY KEY, approval_id uuid UNIQUE NOT NULL REFERENCES agent_approvals(id),
 owner_key text NOT NULL, checkout_id uuid NOT NULL REFERENCES workspaces(id),
 node_id uuid NOT NULL REFERENCES nodes(id), project_id uuid, logical_workspace_id uuid,
 token uuid NOT NULL, dispatch_session uuid NOT NULL, request_sha256 text NOT NULL, profile jsonb NOT NULL, actual_profile jsonb,
 permission text NOT NULL DEFAULT 'read-only' CHECK(permission='read-only'),
 head text NOT NULL, branch text NOT NULL,
 state text NOT NULL CHECK(state IN ('dispatching','starting','running','cancelling','unknown','completed','failed','cancelled','timed_out','incomplete')),
 created_at timestamptz NOT NULL DEFAULT now(), observed_at timestamptz, finished_at timestamptz,
 cancel_requested_at timestamptz, last_cursor integer NOT NULL DEFAULT 0,
 event_gap boolean NOT NULL DEFAULT false, evidence jsonb NOT NULL DEFAULT '{}',
 receipt jsonb, status_reason text,
 CHECK((state IN ('completed','failed','cancelled','timed_out','incomplete')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX agent_runs_one_live_node ON agent_runs(node_id)
 WHERE state IN ('dispatching','starting','running','cancelling','unknown');
CREATE TABLE agent_events (
 run_id uuid NOT NULL REFERENCES agent_runs(id), cursor integer NOT NULL CHECK(cursor>0),
 event jsonb NOT NULL CHECK(jsonb_typeof(event)='object' AND octet_length(event::text)<=4096), PRIMARY KEY(run_id,cursor)
);
CREATE INDEX agent_runs_owner_created ON agent_runs(owner_key,created_at DESC);
