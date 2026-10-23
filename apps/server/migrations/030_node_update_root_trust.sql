-- Operator-only root attestation trust and single-use challenge ledger.
-- Neither Node credentials nor MCP have any mutation path to these tables.
-- A verified evidence record is NOT update completion or clearance of claim.
CREATE TABLE node_update_root_keys (
    node_id uuid PRIMARY KEY REFERENCES nodes(id),
    public_key_pem text NOT NULL CHECK (length(public_key_pem) BETWEEN 80 AND 512),
    fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    pinned_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX node_update_root_keys_fingerprint ON node_update_root_keys(fingerprint);

CREATE TABLE node_update_root_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id uuid NOT NULL UNIQUE REFERENCES node_update_intents(id),
    node_id uuid NOT NULL REFERENCES nodes(id),
    nonce char(64) NOT NULL UNIQUE CHECK (nonce ~ '^[0-9a-f]{64}$'),
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
    consumed_at timestamptz,
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes'),
    CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);
CREATE INDEX node_update_root_challenges_node ON node_update_root_challenges(node_id, issued_at DESC);

CREATE TABLE node_update_root_evidence (
    intent_id uuid PRIMARY KEY REFERENCES node_update_intents(id),
    challenge_id uuid NOT NULL UNIQUE REFERENCES node_update_root_challenges(id),
    node_id uuid NOT NULL REFERENCES nodes(id),
    key_fingerprint char(64) NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{64}$'),
    active_version text NOT NULL,
    target_sha256 char(64) NOT NULL CHECK (target_sha256 ~ '^[0-9a-f]{64}$'),
    observed_pid integer NOT NULL CHECK (observed_pid > 1),
    signature char(88) NOT NULL CHECK (char_length(signature) = 88),
    verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
