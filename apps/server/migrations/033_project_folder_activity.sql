-- Project Storage V2: enforce folder activity on new and restored Files.
-- Acquire a row lock on the destination folder so folder archival and file
-- attachment cannot race and leave active Files inside archived folders.
CREATE OR REPLACE FUNCTION atlas_files_check_folder_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.folder_id IS NOT NULL THEN
    IF NEW.owner_kind <> 'project' THEN
      RAISE EXCEPTION 'Atlas file folder requires Project ownership'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM atlas_file_folders f
      WHERE f.id = NEW.folder_id
        AND f.project_id::text = NEW.owner_id
        AND (NEW.status <> 'active' OR f.status = 'active')
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Atlas file destination must belong to the Project and be active'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER atlas_files_folder_scope_trg ON atlas_files;
CREATE TRIGGER atlas_files_folder_scope_trg
  BEFORE INSERT OR UPDATE OF folder_id, owner_kind, owner_id, status ON atlas_files
  FOR EACH ROW EXECUTE FUNCTION atlas_files_check_folder_scope();
