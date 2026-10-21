-- A Node upload may be retried after the file was saved but its response
-- was lost. Receipt IDs bind one Node's request to one immutable Files row.
CREATE TABLE node_file_upload_receipts (
  node_id uuid NOT NULL REFERENCES nodes(id),
  upload_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  file_id uuid NOT NULL UNIQUE REFERENCES atlas_files(id),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, upload_id)
);
CREATE INDEX node_file_upload_receipts_workspace_idx ON node_file_upload_receipts(workspace_id, created_at DESC);
