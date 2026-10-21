-- Preserve the immutable per-Node upload-ID namespace when an abandoned
-- resumable transfer's payload checkpoints are explicitly expired.
-- Only opaque IDs and expiry time remain; no filename, checksum, workspace,
-- chunk bytes, file contents, or Node credentials are retained.
-- These are permanent replay fences: do not periodically garbage-collect
-- this table without introducing a new explicitly versioned ID contract.
CREATE TABLE node_file_expired_upload_ids (
    node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    upload_id uuid NOT NULL,
    expired_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (node_id,upload_id)
);
