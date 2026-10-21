-- Read-only Monitoring uses the existing immutable audit_events table.
-- Composite indexes support filtered ORDER BY / LIMIT without materialising all events.
CREATE INDEX IF NOT EXISTS audit_events_time_id_idx ON audit_events (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_project_time_idx ON audit_events (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_workspace_time_idx ON audit_events (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_store_time_idx ON audit_events (store_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_client_time_idx ON audit_events (lower(client), created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_operation_time_idx ON audit_events (operation, created_at DESC, id DESC);
-- Node associations historically reside in event outcome JSON, not a dedicated column.
CREATE INDEX IF NOT EXISTS audit_events_node_time_idx ON audit_events ((after_state->>'nodeId'), created_at DESC, id DESC);
