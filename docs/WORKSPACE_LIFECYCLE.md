# Managed repositories and worktrees — initial lifecycle

This phase adds three Node-owned, auditable operations on top of Workspace V2:

- `workspace_git_clone_repository` — clone a GitHub App-accessible repository
  into a **previously empty** child directory of a registered, trusted
  development-root Workspace. The Server brokers a short-lived, repo-scoped,
  read-only installation token and never stores it in audit records.
  Once the checkout exists and the Node confirms its canonical path, Atlas
  registers it as its own independent Workspace. It does not inherit the
  manager directory's Project link; an optional Project can be linked afterward.
- `workspace_git_create_worktree` — create an isolated `atlas/*` worktree
  from an already registered Git repository at a canonical, nonexistent path
  under `ATLAS_GIT_TRUSTED_ROOTS`. The new worktree is automatically registered
  as an independent Workspace; existing checkout files are preserved.
- `workspace_git_list_worktrees` and `workspace_git_remove_worktree` —
  inspect worktrees and retire an explicitly selected registered feature
  worktree. Retiring rejects dirty/untracked worktrees and changed HEADs,
  archives the registered Workspace, **retains the feature branch and commits**,
  and never uses `git worktree remove --force`.

## Initial setup

Register each approved development directory as a generic Workspace once:

```json
{ "name": "VPS development roots", "nodeId": "<VPS_NODE_ID>",
  "rootPath": "/srv/atlas/workspaces", "kind": "generic" }
```

Use `create_workspace` for that input. This is a *manager Workspace* used to
provision new checkouts. It must exactly equal a canonical
`ATLAS_GIT_TRUSTED_ROOTS` entry already approved by the Node owner, and it must
also be included in `ATLAS_WORKSPACE_ROOTS`. A clone request is then:

```json
{ "workspaceId": "<MANAGER_WORKSPACE_ID>",
  "repository": "affank1020/atlas", "directoryName": "atlas-v2" }
```

The result includes the new Workspace ID. No per-repository environment map
or manually entered GitHub credential is needed. The GitHub App must already
have permission to read the repository.

To create a worktree from that repository's Workspace, send:

```json
{ "workspaceId": "<REPO_WORKSPACE_ID>", "branch": "atlas/new-feature",
  "targetPath": "/srv/atlas/workspaces/atlas-new-feature",
  "name": "New feature" }
```

To retire it, read `workspace_git_list_worktrees` or
`workspace_git_status` for the current HEAD, then call
`workspace_git_remove_worktree` with the source Workspace ID,
`targetWorkspaceId` (the feature Workspace ID) and `expectedHead`.
The Node receives the target directory from the Server database, **never
from untrusted request input**.

## Safety and rollout

- A repository target may not exist before clone/worktree creation. Neither
  operation rewrites an existing directory.
- Clone uses HTTPS + an App read token passed through Git process environment
  (not argv or logs), fetches only the default branch's shallow history,
  disables Git redirects, and never runs submodule cloning.
  It refuses checkout when tree entries contain symlinks or submodules.
- Clone requires an exact trusted development root; worktrees require a target
  inside an explicitly trusted development root. Registration uses Node binding.
- Archive/removal requires the expected commit **and** the original Atlas-created
  branch. The Server verifies a server-authored `workspace.created` audit entry for
  that exact Workspace ID, source Workspace, canonical directory, and
  `managedKind=git_worktree` marker under the same transaction locks used for
  removal. Merely registering a manually created worktree does not authorise
  deletion. The Git branch survives successful removal.
- The Server may not roll back a completed filesystem operation if PostgreSQL
  fails to commit. In that case, inspect the new folder and audit intent before
  retrying: Atlas deliberately avoids destructive automatic cleanup.
- Existing Git staging, committing and publishing operations now work in
  **validated linked worktrees**, subject to the same trusted-root rules,
  SHA-256 file checks, branch guards and GitHub origin verification as normal
  checkouts. A feature can progress through edit, commit, push and draft PR.
- Managed clone metadata and worktree association are currently derived from
  Git status and registered Node Workspace paths, rather than a separate
  persistent repository table.
- Web UI and automatic GitHub account/repository selection are follow-up work.

Run the Node and Server versions from the same release after CI and review.
**Do not deploy unfinished lifecycle code to production while developing it.**
