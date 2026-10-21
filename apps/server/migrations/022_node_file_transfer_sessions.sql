-- Durable bounded transfer checkpoints. Chunk bytes are private PostgreSQL
-- staging data, never publishable or addressable via Atlas Files.
-- Completed sessions retain only a small receipt; their chunks are deleted.
CREATE TABLE node_file_transfer_sessions (
  node_id uuid NOT NULL REFERENCES nodes(id),
  upload_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  mime_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  chunk_bytes integer NOT NULL DEFAULT 1048576 CHECK (chunk_bytes=1048576),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','complete')),
  completed_file_id uuid REFERENCES atlas_files(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(node_id, upload_id),
  CHECK ((status='active' AND completed_file_id IS NULL) OR
         (status='complete' AND completed_file_id IS NOT NULL))
);
CREATE INDEX node_file_transfer_active_workspace_idx
  ON node_file_transfer_sessions(workspace_id) WHERE status='active';

CREATE TABLE node_file_transfer_parts (
  node_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  part_index integer NOT NULL CHECK (part_index BETWEEN 0 AND 24),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 1048576),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(node_id, upload_id, part_index),
  FOREIGN KEY (node_id,upload_id) REFERENCES node_file_transfer_sessions(node_id,upload_id)
    ON DELETE CASCADE,
  CHECK (octet_length(bytes)=byte_size)
);
