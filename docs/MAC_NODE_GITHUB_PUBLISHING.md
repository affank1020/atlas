# Mac Git publishing — dynamic GitHub installation

Atlas now discovers repositories across accounts where its GitHub App is installed.
The Server uses its existing App ID and signing key to discover installations
and obtain short-lived tokens scoped to a single repository.

Setup:
1. Install the GitHub App on the desired accounts. Select **All repositories**
   for automatic future repository access or choose selected repositories.
2. Keep the existing App ID and signing key on the Server. The old installation
   ID and Workspace-to-repository environment mapping are no longer used by the
   updated broker.
3. Configure a **single trusted development root** on each Node, such as
   `ATLAS_GIT_TRUSTED_ROOTS=/Users/affankhan/Documents/GitRepos` on the Mac.
   Do not approve home folders, production deployment roots or system paths.
4. Continue registering Workspaces beneath approved ATLAS_WORKSPACE_ROOTS.
   They are now independent of Projects; optional Project links can be managed
   with link_workspace_project and unlink_workspace_project.
5. After reviewed code is deployed, run list_github_repositories and
   list_workspaces; then test an approved clean checkout with a disposable
   atlas/* branch and draft PR.

The legacy exact-root configuration still works for compatibility.
Branches, file hashes, repository origin matching, brokered token scope,
non-forced pushes and draft PR checks remain enforced.

Managed cloning and temporary worktree creation/cleanup are **not yet
implemented**. Keep those operations separate from this foundation.
