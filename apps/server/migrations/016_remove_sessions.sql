-- Retire the standalone Atlas Sessions coordination feature.
-- Preserve migration 015 for existing installations, then explicitly remove its data.
-- These tables belong only to Sessions, not to auth, MCP transport or Node connections.
DROP TABLE IF EXISTS session_events;
DROP TABLE IF EXISTS session_assignments;
ALTER TABLE IF EXISTS atlas_sessions DROP CONSTRAINT IF EXISTS atlas_sessions_coordinator_fk;
ALTER TABLE IF EXISTS atlas_sessions DROP CONSTRAINT IF EXISTS atlas_sessions_scoped_coordinator;
DROP TABLE IF EXISTS session_participants;
DROP TABLE IF EXISTS atlas_sessions;
