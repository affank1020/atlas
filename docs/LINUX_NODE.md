# Atlas Linux Node — Phase 3 bootstrap

The first Linux Node is **not** a production code-execution worker. It runs
as a separate unprivileged `atlas-node` account and connects outbound through
the existing authenticated Node WebSocket endpoint.

## Preconditions
- Merge and verify Node packaging PR #4, then install an immutable and
  verified release to `/opt/atlas-node/releases/<version>` with a `current`
  symlink. Keep the previous release for rollback.
- Measure available disk, swap, RAM and CPU headroom first. Atlas API and
  PostgreSQL on this VPS take priority.
- Enrol a **new** Node identity in Atlas. Do not copy Mac credentials.
- Create `/srv/atlas/workspaces` owned by the dedicated service user.
  Only approved repositories belong there; do not mount production Atlas
  data, database volumes, deployment credentials or Docker socket.

## Example service setup (administrator-run; do not automate on production yet)
```bash
sudo useradd --system --home /var/lib/atlas-node --shell /usr/sbin/nologin atlas-node
sudo install -d -o atlas-node -g atlas-node -m 0700 /srv/atlas/workspaces /var/lib/atlas-node
sudo install -d -o root -g root -m 0700 /etc/atlas-node
sudo install -m 0644 infra/atlas-node.service /etc/systemd/system/atlas-node.service
```

The root-owned `/etc/atlas-node/node.env` must contain only this Node's own
`ATLAS_NODE_ID`, `ATLAS_NODE_CREDENTIAL`, `ATLAS_SERVER_URL` and
`ATLAS_WORKSPACE_ROOTS=/srv/atlas/workspaces`. Use `wss://` for remote
connectivity. Ensure it remains unreadable by unrelated users, while the
`atlas-node` service can access credentials via systemd. Do not paste it into
chat or store it in Git. Review permission, process and isolation settings on
the target Linux host before enabling the service.

## Scope
- File browse/search/read/edit and read-only Git status/diff.
- No `workspace.dev`, Unity or football training on Linux yet.
- No project builds/tests until a separate sandbox is implemented.
- No public listening socket, arbitrary command MCP tool or dev server.

## Verification
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-node
systemctl status atlas-node --no-pager
journalctl -u atlas-node -n 40 --no-pager
```

Confirm the distinct Linux Node appears online in Atlas with capabilities
`workspace.files` and `workspace.git`; check the macOS Node stays online.
Then test a disposable project workspace and demonstrate filesystem isolation.

## Read-only VPS preflight and verified release staging

Before provisioning, run `bash scripts/linux-node-preflight.sh --check` **on the
VPS** (or `--json` for a machine-readable report). It only reads memory,
swap, free root disk, CPU count and availability of Node.js, Git and systemd.
The initial thresholds (768 MiB free RAM and 3 GiB free disk) are minimum
screening criteria, not proof of sufficient resources for code builds.

A verified Node release can be checked without privilege using:
```bash
bash scripts/linux-node-release.sh verify atlas-node-v*.tar.gz atlas-node-v*.tar.gz.sha256
```
On Linux, an administrator can stage the verified artifact without activating:
```bash
sudo bash scripts/linux-node-release.sh install atlas-node-v*.tar.gz atlas-node-v*.tar.gz.sha256
```
This explicitly **does not** change the `current` symlink or restart systemd.
Review the available previous release and independent Node identity before
manually activating anything. The MacBook Node remains independent.

## Signed provenance gate

The legacy `linux-node-release.sh verify/install` only checks checksum,
bundle structure, and metadata. It does **not** establish who built an
archive; do not treat it as a trusted installation path by itself.

For production staging, download attestations as your normal
GitHub CLI-authenticated user and then supply that local bundle to the
root installer:
```bash
archive="atlas-node-v2.0.0-<12-character-commit>.tar.gz"  # replace with the release filename
gh attestation download "$archive" -R affank1020/atlas
bundle="sha256:$(sha256sum "$archive" | awk '{print $1}').jsonl"
bash scripts/linux-node-trusted-stage.sh verify "$archive" "$archive.sha256" "$bundle"
sudo bash scripts/linux-node-trusted-stage.sh install "$archive" "$archive.sha256" "$bundle"
```
Do not use `sudo -E` or give root the user's GitHub token. The root installer
copies the archive, checksum and bundle privately and uses offline
`gh attestation verify --bundle` (no root GitHub authentication).
An installation without the bundle fails closed.
This fails unless patched GitHub CLI 2.102.0 or later verifies the exact
main-branch `node-package.yml` signing identity, source SHA and SLSA
provenance. The install operation stages a release without activating it.
Neither command triggers a Node restart, updates Server/PostgreSQL, or
accesses credentials. See `docs/NODE_RELEASES.md` for trust details.
