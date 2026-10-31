-- Monitoring: record committed Atlas Files metadata mutations, regardless of
-- whether the caller is Web, a Node upload, or an internal application.
-- A database trigger proves only that metadata changed; it cannot authenticate
-- a human actor or prove bytes are backed up/restorable.
CREATE FUNCTION atlas_audit_file_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  action text;
  scope_project uuid;
  scope_workspace uuid;
  safe_details jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    action := 'files.uploaded';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    action := CASE WHEN NEW.status = 'archived' THEN 'files.archived' ELSE 'files.restored' END;
  ELSIF NEW.folder_id IS DISTINCT FROM OLD.folder_id THEN
    action := 'files.moved';
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.owner_kind = 'project' AND
     NEW.owner_id ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN
    SELECT id INTO scope_project FROM projects WHERE id = NEW.owner_id::uuid;
  ELSIF NEW.owner_kind = 'workspace' AND
        NEW.owner_id ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN
    SELECT id, project_id INTO scope_workspace, scope_project
    FROM workspaces WHERE id = NEW.owner_id::uuid;
  END IF;

  safe_details := jsonb_build_object('fileId', NEW.id, 'ownerKind', NEW.owner_kind,
                                    'source', 'database-trigger');
  IF NEW.folder_id IS NOT NULL THEN
    safe_details := safe_details || jsonb_build_object('folderId', NEW.folder_id);
  END IF;
  IF TG_OP = 'UPDATE' AND action = 'files.moved' AND OLD.folder_id IS NOT NULL THEN
    safe_details := safe_details || jsonb_build_object('previousFolderId', OLD.folder_id);
  END IF;
  INSERT INTO audit_events(id,client,operation,project_id,workspace_id,after_state,created_at)
    VALUES(gen_random_uuid(),'atlas-files-db',action,scope_project,scope_workspace,safe_details,now());
  RETURN NEW;
END $$;

CREATE TRIGGER atlas_files_monitoring_audit_trg
  AFTER INSERT OR UPDATE OF status,folder_id ON atlas_files
  FOR EACH ROW EXECUTE FUNCTION atlas_audit_file_mutation();

-- Folder identity/project/parent are immutable. Only lifecycle/name changes
-- are recorded; a filename or folder name is NEVER persisted to audit details.
CREATE FUNCTION atlas_audit_folder_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  action text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    action := 'files.folder_created';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    action := CASE WHEN NEW.status = 'archived' THEN 'files.folder_archived' ELSE 'files.folder_restored' END;
  ELSIF NEW.name IS DISTINCT FROM OLD.name THEN
    action := 'files.folder_renamed';
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO audit_events(id,client,operation,project_id,after_state,created_at)
    VALUES(gen_random_uuid(),'atlas-files-db',action,NEW.project_id,
           jsonb_build_object('folderId',NEW.id,'source','database-trigger'),now());
  RETURN NEW;
END $$;

CREATE TRIGGER atlas_file_folders_monitoring_audit_trg
  AFTER INSERT OR UPDATE OF status,name ON atlas_file_folders
  FOR EACH ROW EXECUTE FUNCTION atlas_audit_folder_mutation();
