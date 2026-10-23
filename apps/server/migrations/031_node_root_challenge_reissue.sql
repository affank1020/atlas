-- Preserve every challenge attempt: an expired nonce must never be reused.
-- Existing claimed intents, verified evidence and Node key pins are unchanged.
ALTER TABLE node_update_root_challenges
    ADD COLUMN invalidated_at timestamptz;
ALTER TABLE node_update_root_challenges
    ADD CONSTRAINT node_update_root_challenges_terminal_exclusive
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL),
    ADD CONSTRAINT node_update_root_challenges_invalidation_not_early
    CHECK (invalidated_at IS NULL OR invalidated_at >= issued_at);
ALTER TABLE node_update_root_challenges
    DROP CONSTRAINT node_update_root_challenges_intent_id_key;

-- A challenge awaiting resolution is unique per intent, including after its
-- expiry. The explicit trusted-operator reissue transaction must retire the
-- previous nonce before creating the successor. Historical rows are retained.
CREATE UNIQUE INDEX node_update_root_challenges_one_unresolved_per_intent
    ON node_update_root_challenges(intent_id)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX node_update_root_challenges_intent_history
    ON node_update_root_challenges(intent_id, issued_at DESC, id DESC);
