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


## Current Phase 4 rollout checklist (20 October 2026)

**Merged implementation:** Atlas main merge `3e9d22be53c314ab78b0057bd2c83590aa1ed562` (PR #14). Successful package run: https://github.com/affank1020/atlas/actions/runs/39456645977. Corresponding release version: `v2.0.0-3e9d22be53c3`.

**First:** merge the separate Compose wiring PR and let Atlas CI/deploy succeed, so the Server container receives the four `ATLAS_GITHUB_*` settings. Leave these values empty until a GitHub App has been created. Do not configure fake credentials or use the ChatGPT integration's GitHub permissions as a substitute.

**Mac (with authenticated `gh` CLI):**

```bash
set -euo pipefail
cd ~/Documents/GitRepos/Atlas
mkdir -p "$HOME/atlas-phase4-node-release"
gh run download 39456645977 --repo affank1020/atlas \
  --name atlas-node-3e9d22be53c314ab78b0057bd2c83590aa1ed562 \
  --dir "$HOME/atlas-phase4-node-release"
shasum -a 256 "$HOME"/atlas-phase4-node-release/*.tar.gz
# Confirm digest equals the .sha256 sidecar before transferring.
```

Transfer the release archive and its companion checksum to a private directory on the VPS using your existing SSH setup. On the VPS (where `scripts/linux-node-release.sh` and `atlas-node-lifecycle` are already installed):

```bash
set -euo pipefail
cd "$HOME/atlas-phase4-node-release"
archive="$(find . -maxdepth 1 -name 'atlas-node-v*.tar.gz' -print -quit)"
test -n "$archive"
sha256sum -c "$archive.sha256"
sudo bash "$HOME/atlas-deploy/scripts/linux-node-release.sh" verify "$archive" "$archive.sha256"
sudo bash "$HOME/atlas-deploy/scripts/linux-node-release.sh" install "$archive" "$archive.sha256"
sudo atlas-node-lifecycle plan v2.0.0-3e9d22be53c3
sudo atlas-node-lifecycle activate v2.0.0-3e9d22be53c3
sudo atlas-node-lifecycle status
```

If `$HOME/atlas-deploy/scripts/linux-node-release.sh` does not exist, copy that script from the verified current Atlas main checkout before running it. The existing lifecycle activation command will automatically roll back if the new Node fails registration. Do **not** restart the Atlas Server/PostgreSQL manually for the Node upgrade.

**GitHub App:** Create a private GitHub App owned by the appropriate account, grant only **Contents: read/write** and **Pull requests: read/write**, and install it exclusively on `affank1020/portfolio-site`. Put its numeric App ID, numeric installation ID, and newline-escaped PEM signing key in the VPS's private `atlas-deploy/infra/production.env` file. Add the Workspace-to-repository mapping shown above. Never paste the private key into a chat, shell history, or GitHub issue.

On the Linux Node, retain `ATLAS_GIT_WRITE_ROOTS=/srv/atlas/workspaces/portfolio-site` and add `ATLAS_GIT_REMOTE_ROOTS=/srv/atlas/workspaces/portfolio-site` in its root-owned service environment `/etc/atlas-node/node.env`. Use `sudoedit` and restart **only** `atlas-node.service`. Configure the Server independently by recreating **only** its container using the newly deployed Compose file and the production environment:

```bash
cd "$HOME/atlas-deploy"
docker compose --env-file infra/production.env -f infra/docker-compose.production.yml up -d --no-deps --force-recreate --wait server
```

Do not run `docker compose config` without redirecting its output to a private file: the rendered config contains secrets. Prefer `docker compose ... config -q` for validation.

**Final live smoke:** After both sides are configured and connected, create a new disposable `atlas/*` branch on the existing VPS Workspace, write/inspect an isolated text file, stage by inspected SHA-256, commit by expected Git index tree, push through `workspace_git_push_branch`, then use `workspace_git_open_pull_request` to open a draft PR into `main`. Inspect the remote commit and Atlas audit records before closing the draft without merging. Restore the VPS Workspace to `atlas/bootstrap` afterwards.

**Rollback:** Remove `ATLAS_GIT_REMOTE_ROOTS` or `ATLAS_GITHUB_WORKSPACE_REPOSITORIES` to disable remote writes. If Node activation itself fails, the lifecycle script automatically restores the old version; you can also use `sudo atlas-node-lifecycle rollback`.
