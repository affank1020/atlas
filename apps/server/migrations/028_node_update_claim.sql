-- An Atlas intent can be claimed once, but claiming alone NEVER authorises
-- privileged host execution. The separate host-root approval must be checked
-- before a future executor runs any Node lifecycle commands.
ALTER TABLE node_update_intents DROP CONSTRAINT node_update_intents_status_check;
ALTER TABLE node_update_intents ADD CONSTRAINT node_update_intents_status_check
    CHECK (status IN ('requested', 'cancelled', 'expired', 'claimed'));

-- A claimed intent occupies its Node until a later, explicitly reconciled
-- completion path exists. Never allow a second request to race an update that
-- might already be switching the host's current release.
DROP INDEX node_update_intents_one_pending_node;
CREATE UNIQUE INDEX node_update_intents_one_pending_node
    ON node_update_intents(node_id) WHERE status IN ('requested', 'claimed');
