CREATE TABLE fabric_store_authority_policies (
  store_id uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  authority_role text NOT NULL CHECK (authority_role IN ('canonical','primary','mirror','derived','historical','supporting','unknown')),
  canonical_store_id uuid REFERENCES stores(id) ON DELETE CASCADE,
  equivalence_kind text NOT NULL DEFAULT 'same_fact' CHECK (equivalence_kind IN ('same_entity','same_fact')),
  identity_fields text[] NOT NULL CHECK (cardinality(identity_fields)>0),
  comparison_fields text[] NOT NULL DEFAULT '{}',
  effective_time_fields text[] NOT NULL DEFAULT '{}',
  current_field text,
  current_values text[] NOT NULL DEFAULT '{}',
  historical_values text[] NOT NULL DEFAULT '{}',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fabric_store_authority_canonical_idx ON fabric_store_authority_policies(canonical_store_id);

CREATE TABLE fabric_record_authority_policies (
  record_id uuid PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  authority_role text CHECK (authority_role IN ('canonical','primary','mirror','derived','historical','supporting','unknown')),
  effective_at timestamptz,
  supersedes_record_id uuid REFERENCES records(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fabric_record_authority_supersedes_idx ON fabric_record_authority_policies(supersedes_record_id);
