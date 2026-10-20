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
