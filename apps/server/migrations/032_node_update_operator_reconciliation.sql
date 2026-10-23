-- Manual, separately authenticated operator reconciliation is distinct from
-- cryptographic evidence verification and Node-supplied outcome reports.
-- A reconciled intent no longer occupies the unique claimed/requested fence,
-- but its original immutable target and signed evidence remain forever.
ALTER TABLE node_update_intents DROP CONSTRAINT node_update_intents_status_check;
ALTER TABLE node_update_intents ADD CONSTRAINT node_update_intents_status_check
    CHECK (status IN ('requested','cancelled','expired','claimed','reconciled'));

CREATE TABLE node_update_reconciliations (
    intent_id uuid PRIMARY KEY REFERENCES node_update_intents(id),
    node_id uuid NOT NULL REFERENCES nodes(id),
    evidence_challenge_id uuid NOT NULL UNIQUE REFERENCES node_update_root_challenges(id),
    root_key_fingerprint char(64) NOT NULL CHECK (root_key_fingerprint ~ '^[a-f0-9]{64}$'),
    independently_checked_version text NOT NULL,
    independently_checked_pid integer NOT NULL CHECK (independently_checked_pid > 1),
    operator_check_reference text NOT NULL
        CHECK (length(operator_check_reference) BETWEEN 8 AND 100),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX node_update_reconciliations_node_recent
    ON node_update_reconciliations(node_id, recorded_at DESC);
