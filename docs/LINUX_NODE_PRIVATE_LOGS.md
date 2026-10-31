# Linux Node private service output — least-privilege rollout

This optional source replaces the *default* Linux Monitoring log read with a
fixed **Atlas-owned** output file. It does not grant the service account
`systemd-journal`, `adm`, sudo, Docker socket, generic journald access,
an arbitrary filesystem path, or a developer execution capability.

The older explicit `source: journal` remains a legacy, separately checked
source and **is not** silently mapped to this file. New Monitoring clients
request `source: service`; during a rolling upgrade, an older Server/Node may
reject the new source as unsupported. Missing files are reported unavailable,
not empty/healthy. Roll out Server + Web compatibility first, then the Node and
host unit changes.

## Trust boundary and storage contract

- Directory: **`/var/log/atlas-node`**, root-owned, group `atlas-node`,
  mode `0750`, **not writable** by the Node account. This prevents a
  compromised Node process from replacing `service.log` with a symlink
  before PID 1 opens `StandardOutput=append`.
- File: **`service.log`**, owner `atlas-node:atlas-node`, mode `0600`,
  one regular inode; never a symlink/hardlink. The installed systemd unit opens
  this fixed file and merges its stderr into the same append stream.
- The sandbox has `ProtectSystem=strict` and only the fixed log file added
  to its `ReadWritePaths`; no access to arbitrary host logs is needed.
- The Node performs a bounded non-following file read, verifies ownership,
  directory integrity and permissions, and redacts output before returning
  at most 200 complete lines / 48 KiB from a 256 KiB tail.
- **At rest**, the private service file and its rotated copies can contain
  raw process output. They are restricted host artifacts, **not guaranteed
  secret-free**, and must never be pasted into GitHub or sent as evidence.
  The Monitoring API's redaction is a read-time safeguard, not a guarantee
  that secrets were never written to disk.
- Root-owned `logrotate` config performs best-effort size-based rotation,
  keeps four old files, and uses `copytruncate` to preserve the file inode
  held by systemd. It can lose a few log lines while copying/truncating;
  a flood between logrotate runs can exceed the threshold. This is **not**
  complete, immutable or strictly size-bounded history.

## Operator-controlled installation (VPS only)

Do not run automatically during a CI deployment. Review current unit,
filesystem and storage usage, and retain a rollback copy. Provision **before**
installing/restarting the new unit: systemd's append output path must already
exist and must not be service-user replaceable.

```bash
# Read-only preflight, no log contents or credentials.
sudo systemctl show atlas-node.service -p User -p Group -p SupplementaryGroups
sudo test ! -L /var/log/atlas-node
sudo test ! -L /var/log/atlas-node/service.log
sudo stat -c '%U:%G %a %n' /var/log/atlas-node 2>/dev/null || true
sudo stat -c '%U:%G %a %n' /var/log/atlas-node/service.log 2>/dev/null || true

# Confirm the existing paths are intended for Atlas; do not overwrite any
# unrelated file or alter an unexpected existing symlink/owner.
sudo install -d -o root -g atlas-node -m 0750 /var/log/atlas-node
if ! sudo test -e /var/log/atlas-node/service.log; then
  sudo install -o atlas-node -g atlas-node -m 0600 /dev/null /var/log/atlas-node/service.log
fi

# Required: directory root:atlas-node 750; file atlas-node:atlas-node 600.
sudo stat -c '%U:%G %a %n' /var/log/atlas-node /var/log/atlas-node/service.log
sudo test ! -L /var/log/atlas-node/service.log
sudo test "$(sudo stat -c '%h' /var/log/atlas-node/service.log)" = 1

# From a verified Atlas checkout/release containing the reviewed config.
sudo install -m 0644 infra/atlas-node.logrotate /etc/logrotate.d/atlas-node
sudo logrotate -d /etc/logrotate.d/atlas-node
sudo install -m 0644 infra/atlas-node.service /etc/systemd/system/atlas-node.service
sudo systemctl daemon-reload
sudo systemctl cat atlas-node.service

# Only after reviewing every line above and scheduling a Node-only restart:
sudo systemctl restart atlas-node.service
sudo systemctl is-active --quiet atlas-node.service
```

**Do not copy the environment file or grant journald groups.** The
`atlas-node` account is deliberately unable to create/rename the root-owned
log directory. If preflight reports an unexpected owner, mode, symlink, or
missing path, stop for operator diagnosis instead of coercively repairing it.

`logrotate` is normally timer-driven by the host OS; verify its timer
is installed/enabled, and record its actual cadence. There is no privileged
logrotate subprocess in the Node service.

## Read-only acceptance and rollback

After the Node reconnects and the compatible Server/Web revision is live,
check the Atlas **Monitoring → Logs → Connected Node → Linux Node** source.
`read_node_logs({nodeId, source: "service", lines: 10})` should return
`source: service`, `available: true`, no more than 10 lines and only
redacted content. Never record raw lines in issue #110. Confirm an explicit
legacy `journal` request still reports unavailable if the service user lacks
journal permission; this must **not** silently serve the private file.

On host, only if needed for diagnosis, verify *exit status* (not content):
```bash
sudo -u atlas-node test -r /var/log/atlas-node/service.log
echo "Private log readable: $?"
sudo stat -c '%U:%G %a %h %s' /var/log/atlas-node/service.log
```

For an isolated rotation drill, use a disposable fixture rather than
truncating the production log. For rollback, restore the saved previous
systemd unit, reload, and restart **only** `atlas-node.service`. Keep the
private log file until the operator reviews its retention/disposal needs;
the older Node continues to use the legacy journal source. Do not mark
#110 complete until deployed source/rotation checks actually pass.
