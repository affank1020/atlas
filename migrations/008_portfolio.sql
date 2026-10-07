-- Portfolio Core records are editable drafts. Immutable revisions and
-- publication pointers define the public website corpus. The Portfolio app
-- seeds its project/stores on startup so Core remains empty when unused.

CREATE TABLE portfolio_revisions (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  data jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(record_id,revision)
);

CREATE TABLE portfolio_publications (
  record_id uuid PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES portfolio_revisions(id),
  published_by text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX portfolio_revisions_record_idx ON portfolio_revisions(record_id,revision DESC);
CREATE INDEX portfolio_publications_date_idx ON portfolio_publications(published_at DESC);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  checksum text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size >= 0),
  width integer,
  height integer,
  alt_text text,
  caption text,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_variants (
  asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  name text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size >= 0),
  width integer,
  height integer,
  PRIMARY KEY(asset_id,name)
);

CREATE INDEX media_assets_created_idx ON media_assets(created_at DESC);
