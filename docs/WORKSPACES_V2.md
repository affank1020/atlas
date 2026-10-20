# Workspace V2 — Node-owned workspaces and optional Projects

Migration `017_workspace_v2.sql` preserves existing Workspace IDs, Node
bindings and audit history. It removes the single-active-Workspace-per-Project
restriction and allows standalone Workspaces with no Project.

The `workspace_project_links` table makes Project association optional and
many-to-many. Existing associations are copied during migration; old IDs and
legacy tools continue to work. The legacy `workspaces.project_id` column
remains as a nullable primary/compatibility association for older consumers.
The active Node+root constraint prevents registering the same physical
directory twice on a Node.

## APIs

- `list_workspaces({nodeId?,includeArchived?})` — global Workspace inventory.
- `get_workspace({workspaceId,projectId?})` — inspect by stable ID.
- `create_workspace({name,rootPath,nodeId?,projectId?,kind?})` —
  register an existing directory; Projects are optional.
- `link_workspace_project({workspaceId,projectId})` — associate a Project.
- `unlink_workspace_project({workspaceId,projectId})` — detach that Project
  without moving files or deleting the Workspace.
- Existing filesystem/Git and development tools accept `workspaceId` alone;
  supplying `projectId` keeps the legacy Project-linked checks.
- Legacy `list_project_workspaces` continues to return associated Workspaces,
  now through the association table.

Git status and diff safely recognise normal repositories and linked Git
worktrees when their common Git directory belongs to an approved Node root.
Git mutation on linked worktrees remains deliberately restricted until the
managed-worktree lifecycle is designed and audited.

## GitHub integration

GitHub repositories are discovered from App installations via
`list_github_repositories`. The installed account's GitHub permissions
determine repository availability, not a Server-side per-Workspace JSON map.
Each push uses a short-lived, single-repository installation token.

A Node owner configures a single `ATLAS_GIT_TRUSTED_ROOTS` development
directory (existing trusted paths only). This enables Git operations in
registered checkouts under the directory after the usual safety checks.
It never grants access to the rest of the device.

## Next lifecycle layer

Managed remote checkout creation, temporary worktree allocation and cleanup,
automatic pairing with repository IDs, dedicated Web UI views, and explicit
confirmation before removing a dirty/unpushed worktree are not included in
this migration. Those operations need a separate Node-side lifecycle with
strict path, branch and resource controls.

Run database migrations before deploying the new Server. Deploy compatible
Server and Node revisions together. Do not run old Workspace SQL code against
the migrated database; keep a rollback deployment plan.
