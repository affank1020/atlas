ALTER TABLE nodes ADD COLUMN platform text NOT NULL DEFAULT 'unknown';
ALTER TABLE nodes ADD COLUMN version text;
ALTER TABLE nodes ADD COLUMN credential_hash text;
ALTER TABLE nodes ADD COLUMN credential_state text NOT NULL DEFAULT 'unenrolled' CHECK (credential_state IN ('unenrolled','active','revoked','pending'));
ALTER TABLE nodes ADD COLUMN credential_updated_at timestamptz;
CREATE UNIQUE INDEX nodes_credential_hash_unique ON nodes(credential_hash) WHERE credential_hash IS NOT NULL;
CREATE TABLE node_enrolments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 token_hash text UNIQUE NOT NULL,
 node_id uuid REFERENCES nodes(id),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
