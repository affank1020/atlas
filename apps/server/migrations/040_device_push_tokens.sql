-- Firebase token is encrypted at rest and bound to a single active Node credential generation.
-- No device message content or plaintext token is stored in PostgreSQL.
CREATE TABLE device_push_tokens (
    node_id uuid PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    credential_updated_at timestamptz NOT NULL,
    token_ciphertext bytea NOT NULL CHECK (octet_length(token_ciphertext) BETWEEN 1 AND 4096),
    token_nonce bytea NOT NULL CHECK (octet_length(token_nonce)=12),
    token_tag bytea NOT NULL CHECK (octet_length(token_tag)=16),
    registered_at timestamptz NOT NULL DEFAULT now()
);
