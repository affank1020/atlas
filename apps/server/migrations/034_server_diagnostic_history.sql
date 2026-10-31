-- Non-sensitive, fixed-code Server diagnostics across process restarts.
-- This table deliberately never stores request parameters, errors, log lines, paths or identifiers.
CREATE TABLE IF NOT EXISTS atlas_server_diagnostic_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at timestamptz NOT NULL,
    instance_id uuid NOT NULL,
    code text NOT NULL CHECK (code IN ('server_initialised', 'tool_request_failed', 'background_task_failed'))
);
CREATE INDEX IF NOT EXISTS atlas_server_diagnostic_events_recent_idx
    ON atlas_server_diagnostic_events (occurred_at DESC, id DESC);
