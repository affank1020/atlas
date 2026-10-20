# Phase 4.3 — Scoped GitHub publishing

This is an **opt-in pilot**, not a production-enabled feature. Nothing changes until a reviewed Server and Linux Node release has been deployed and the owner explicitly configures the two separate allowlists.

## Supported actions

1. Use the Phase 4.2 Git operations to create an `atlas/*` branch and commit explicit inspected files.
2. `workspace_git_push_branch`: publish the exact clean local branch HEAD to one operator-approved GitHub repository using native **non-force** Git push. Supply `projectId`, `workspaceId`, `repository`, `branch`, and `expectedHead` (the SHA returned by the local commit operation).
3. `workspace_git_open_pull_request`: create a **draft** pull request from that remote branch into `main`, only if the remote branch still matches `expectedHead`. Supply the same scope, `title`, and optional `body`.

No pull, fetch, merge, force push, ref deletion, arbitrary remote URL, personal access token input, or arbitrary shell tool is available. Existing local operations remain intact.

## Server setup (operator-only)

Create a GitHub App installed on the **specific approved repository**, granting only Contents: write and Pull requests: write. Store its **private key only on the Atlas Server** (in a securely managed, private service environment; never check it into Git or pass it through MCP):

- `ATLAS_GITHUB_APP_ID=<numeric app id>`
- `ATLAS_GITHUB_INSTALLATION_ID=<numeric installation id>`
- `ATLAS_GITHUB_APP_PRIVATE_KEY_PEM=<PEM private key with escaped newline characters>`
- `ATLAS_GITHUB_WORKSPACE_REPOSITORIES='{"b0642889-d2b4-41de-bf22-c3ef2ef334bb":"affank1020/portfolio-site"}'`

The final setting is a JSON object mapping exact Atlas Workspace IDs to exact `owner/repository` pairs. Other Workspaces fail closed. The GitHub App broker requests a short-lived installation token limited to that repository. The app signing key is **never** sent to the Node.

## Linux Node setup (operator-only)

On the **Linux Node only**, keep the existing local write opt-in and add:

- `ATLAS_GIT_WRITE_ROOTS=/srv/atlas/workspaces/portfolio-site`
- `ATLAS_GIT_REMOTE_ROOTS=/srv/atlas/workspaces/portfolio-site`

The Node verifies a canonical in-workspace `.git` directory, an `atlas/*` checkout, an unchanged expected commit, a clean worktree, and an origin exactly equal to `https://github.com/affank1020/portfolio-site.git`. It does not accept a caller-supplied remote URL.

A short-lived GitHub installation token travels through Atlas's authenticated Node WebSocket for one push and is injected into the child Git process environment; no credential is written to disk or included in the mutation audit. The push is non-forced, Git HTTP redirects are disabled, Git hooks are disabled, and interactive prompts are disabled.

## Safe release process

1. Review and merge the implementation after unit tests and CI pass.
2. Deploy the Server release, then publish and activate the compatible Linux Node release with the existing rollback procedure.
3. Configure the GitHub App and both allowlists; do not enable access to production deployment roots or secrets.
4. In the isolated Linux Workspace, verify a local disposable `atlas/*` commit, publish it to the approved repo, and create a draft PR. Verify the remote commit SHA and audit events `workspace.git_pushed` and `workspace.git_pull_request_created`.
5. Close the smoke-test PR without merging; inspect remote refs and workspace cleanliness. Treat timeouts as **outcome uncertain** and inspect GitHub before retrying.

If anything fails, remove `ATLAS_GIT_REMOTE_ROOTS` from the Node and/or the Workspace allowlist from the Server to disable remote publishing without affecting local Git operations.
