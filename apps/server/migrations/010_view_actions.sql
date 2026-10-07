ALTER TABLE views ADD COLUMN actions jsonb NOT NULL DEFAULT '[]'::jsonb;
