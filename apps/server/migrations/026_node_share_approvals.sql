CREATE TABLE node_share_approvals (
 source_node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
 target_node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (source_node_id,target_node_id),
 CONSTRAINT node_share_approvals_distinct CHECK (source_node_id <> target_node_id)
);
CREATE INDEX node_share_approvals_target_idx ON node_share_approvals(target_node_id);
