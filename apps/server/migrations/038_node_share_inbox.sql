-- Separate, bounded, encrypted-at-rest, opt-in asynchronous text handoff.
-- "queued" is NEVER a claim that the receiver copied the clipboard.
CREATE TABLE node_share_inbox (
    source_node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    delivery_id uuid NOT NULL,
    target_node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    digest char(64) NOT NULL,
    nonce bytea,
    ciphertext bytea,
    auth_tag bytea,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','copied','declined','expired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    resolved_at timestamptz,
    PRIMARY KEY (source_node_id, delivery_id),
    CONSTRAINT node_inbox_payload CHECK (
        (status = 'queued' AND nonce IS NOT NULL AND ciphertext IS NOT NULL
            AND auth_tag IS NOT NULL AND octet_length(nonce)=12
            AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 1 AND 65536)
        OR (status <> 'queued' AND nonce IS NULL AND ciphertext IS NULL AND auth_tag IS NULL)
    ),
    CONSTRAINT node_inbox_expiry CHECK (expires_at > created_at)
);
CREATE INDEX node_share_inbox_target_queue_idx
    ON node_share_inbox(target_node_id,created_at)
    WHERE status='queued';
CREATE INDEX node_share_inbox_expiry_idx ON node_share_inbox(expires_at);
