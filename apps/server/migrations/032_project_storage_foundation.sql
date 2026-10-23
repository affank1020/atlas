-- Project Storage V2: additive folder metadata, with legacy Files preserved.
-- No existing atlas_files owner, key, checksum or physical R2 object is rewritten.
CREATE TABLE atlas_file_folders (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  parent_id uuid,
  name text NOT NULL CHECK (
    char_length(name) BETWEEN 1 AND 255
    AND name = btrim(name)
    AND name NOT IN ('.', '..')
    AND strpos(name, '/') = 0
    AND strpos(name, chr(92)) = 0
    AND name !~ '[[:cntrl:]]'
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  CONSTRAINT atlas_file_folders_parent_scope_fk
    FOREIGN KEY (project_id, parent_id)
    REFERENCES atlas_file_folders(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT atlas_file_folders_not_self_parent
    CHECK (parent_id IS NULL OR parent_id <> id)
);

-- SQL NULL semantics require a separate root index: a single index on
-- (project_id, parent_id, lower(name)) would allow duplicate root names.
CREATE UNIQUE INDEX atlas_file_folders_root_name_uq
  ON atlas_file_folders(project_id, lower(name))
  WHERE parent_id IS NULL AND status = 'active';
CREATE UNIQUE INDEX atlas_file_folders_child_name_uq
  ON atlas_file_folders(project_id, parent_id, lower(name))
  WHERE parent_id IS NOT NULL AND status = 'active';
CREATE INDEX atlas_file_folders_project_parent_idx
  ON atlas_file_folders(project_id, parent_id)
  WHERE status = 'active';

-- Folder identity, parent and Project are immutable. PR 2 will add safe
-- metadata operations for names and lifecycle; folder reparenting is not
-- part of the initial contract.
CREATE FUNCTION atlas_file_folders_immutable_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    RAISE EXCEPTION 'Project file folder identity and parent are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER atlas_file_folders_immutable_scope_trg
  BEFORE UPDATE ON atlas_file_folders
  FOR EACH ROW EXECUTE FUNCTION atlas_file_folders_immutable_scope();

-- An AFTER constraint trigger also rejects circular references inserted
-- within one multi-row SQL statement (including cycles longer than 2).
CREATE FUNCTION atlas_file_folders_reject_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM atlas_file_folders WHERE id = NEW.parent_id
      UNION
      SELECT parent.id, parent.parent_id
      FROM atlas_file_folders parent
      JOIN ancestors ON parent.id = ancestors.parent_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Project file folder ancestry cannot contain cycles'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER atlas_file_folders_cycle_trg
  AFTER INSERT OR UPDATE OF parent_id ON atlas_file_folders
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION atlas_file_folders_reject_cycle();

-- NULL means the Project root for project-owned Files, or unchanged legacy
-- placement for Workspace/Application-owned Files. No backfill is required.
ALTER TABLE atlas_files
  ADD COLUMN folder_id uuid REFERENCES atlas_file_folders(id) ON DELETE RESTRICT;

-- A file must never point at a folder in another Project. Legacy owners may
-- continue to exist, but they cannot attach themselves to Project folders.
CREATE FUNCTION atlas_files_check_folder_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.folder_id IS NOT NULL THEN
    IF NEW.owner_kind <> 'project' OR NOT EXISTS (
      SELECT 1 FROM atlas_file_folders f
      WHERE f.id = NEW.folder_id AND f.project_id::text = NEW.owner_id
    ) THEN
      RAISE EXCEPTION 'Atlas file folder must belong to its owning Project'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER atlas_files_folder_scope_trg
  BEFORE INSERT OR UPDATE OF folder_id, owner_kind, owner_id ON atlas_files
  FOR EACH ROW EXECUTE FUNCTION atlas_files_check_folder_scope();
