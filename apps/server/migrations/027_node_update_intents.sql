-- Prepared Linux Node update intentions are NOT approvals or executable jobs.
-- No Node/host process consumes this table, and no privileged capability is
-- granted by writing to it. Immutable target identity is persisted for future
-- operator review and audit; all requests expire within 15 minutes.
CREATE TABLE node_update_intents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id uuid NOT NULL REFERENCES nodes(id),
    installed_version text NOT NULL,
    target_version text NOT NULL,
    target_commit char(12) NOT NULL CHECK (target_commit ~ '^[0-9a-f]{12}$'),
    target_source_commit char(40) NOT NULL CHECK (target_source_commit ~ '^[0-9a-f]{40}$'),
    target_sha256 char(64) NOT NULL CHECK (target_sha256 ~ '^[0-9a-f]{64}$'),
    status text NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'cancelled', 'expired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
    resolved_at timestamptz,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
    CHECK ((status = 'requested' AND resolved_at IS NULL)
        OR (status <> 'requested' AND resolved_at IS NOT NULL)),
    CHECK (left(target_source_commit, 12) = target_commit)
);
CREATE UNIQUE INDEX node_update_intents_one_pending_node
    ON node_update_intents(node_id) WHERE status = 'requested';
CREATE INDEX node_update_intents_node_recent
    ON node_update_intents(node_id, created_at DESC, id DESC);
