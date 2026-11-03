-- Child state is authoritative only when corroborated by ordered Node lifecycle events.
-- This table never grants a child permission to execute; spawning remains disabled
-- until the reviewed Pi extension and per-child policy are integrated.
CREATE TABLE agent_children (
    run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL,
    parent_agent_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('scout','worker','reviewer','general')),
    requested_profile_id text NOT NULL CHECK (requested_profile_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
    actual_profile jsonb,
    state text NOT NULL CHECK (state IN ('starting','running','completed','failed','cancelled','timed_out','incomplete')),
    started_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL,
    finished_at timestamptz,
    start_cursor integer NOT NULL CHECK (start_cursor > 0),
    last_cursor integer NOT NULL CHECK (last_cursor >= start_cursor),
    PRIMARY KEY (run_id, agent_id),
    CHECK (agent_id <> parent_agent_id),
    CHECK ((state IN ('completed','failed','cancelled','timed_out','incomplete')) = (finished_at IS NOT NULL))
);
CREATE INDEX agent_children_run_order ON agent_children(run_id, start_cursor);
