-- Node credentials can submit only UNVERIFIED execution observations.
-- These records are not host-root proof and NEVER change the claimed fence.
-- Reconciliation/clearance requires a future separately authenticated process.
CREATE TABLE node_update_outcome_reports (
    intent_id uuid PRIMARY KEY REFERENCES node_update_intents(id),
    node_id uuid NOT NULL REFERENCES nodes(id),
    reported_state text NOT NULL CHECK (reported_state IN ('activated', 'requires_reconciliation')),
    reported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX node_update_outcome_reports_node_recent
    ON node_update_outcome_reports(node_id, reported_at DESC);
