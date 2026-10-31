-- Server-side bounded, encrypted, short-lived device inbox.
-- Ciphertext is application-encrypted with a separately managed AES-GCM key.
-- Do not store plaintext share text in this table, audit_events or logs.
CREATE TABLE device_inbox (
  id uuid PRIMARY KEY,
  source_node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  -- Bind each queued item to the credentials current at admission.
  -- A revoked/rotated Node must not regain earlier queued content on re-enrolment.
  source_credential_updated_at timestamptz NOT NULL,
  target_credential_updated_at timestamptz NOT NULL,
  submission_hash text NOT NULL CHECK (length(submission_hash)=64),
  payload_ciphertext bytea CHECK (payload_ciphertext IS NULL OR octet_length(payload_ciphertext) BETWEEN 1 AND 32768),
  payload_nonce bytea CHECK (payload_nonce IS NULL OR octet_length(payload_nonce)=12),
  payload_tag bytea CHECK (payload_tag IS NULL OR octet_length(payload_tag)=16),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','user_copied','declined','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT device_inbox_pair_id_unique UNIQUE (source_node_id,id),
  CONSTRAINT device_inbox_decision_consistency CHECK (
    (state='queued' AND decided_at IS NULL AND payload_ciphertext IS NOT NULL
      AND payload_nonce IS NOT NULL AND payload_tag IS NOT NULL) OR
    (state<>'queued' AND decided_at IS NOT NULL AND payload_ciphertext IS NULL
      AND payload_nonce IS NULL AND payload_tag IS NULL)
  )
);
CREATE INDEX device_inbox_target_pending ON device_inbox(target_node_id,expires_at,created_at)
  WHERE state='queued';
CREATE INDEX device_inbox_expiry ON device_inbox(expires_at);
