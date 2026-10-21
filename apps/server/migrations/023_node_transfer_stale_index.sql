-- Accelerate bounded operator-only cleanup of inactive checkpoint sessions.
-- Existing sessions and bytes are preserved; this migration never deletes.
CREATE INDEX node_file_transfer_stale_active_idx
    ON node_file_transfer_sessions(updated_at,node_id,upload_id)
    WHERE status='active';
