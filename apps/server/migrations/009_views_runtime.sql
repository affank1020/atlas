ALTER TABLE views ADD COLUMN manifest jsonb;
ALTER TABLE views ADD COLUMN script text NOT NULL DEFAULT '';
