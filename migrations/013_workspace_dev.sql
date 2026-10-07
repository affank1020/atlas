-- Trusted owner configuration. Public Workspace create/update tools cannot write this field.
ALTER TABLE workspaces ADD COLUMN dev_tasks jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(dev_tasks) = 'object');
