# Linux Node lifecycle (manual rollout)

The Linux Node runs independently of Atlas Server and PostgreSQL. Install and
audit a checksum-verified release first with \`scripts/linux-node-release.sh\`.
Each immutable release is stored beneath \`/opt/atlas-node/releases\`.

## One-command, operator-initiated upgrade (recommended)

From a Mac checkout with GitHub CLI authenticated and the existing SSH alias
`ovh` configured:

```bash
./atlasctl vps node-upgrade
```

This selects the latest successfully packaged `main` Node release, downloads
and verifies its checksum, transfers the artifact through SSH, stages the
immutable release, invokes the existing lifecycle activation and confirms the
new Node reconnects. Only `atlas-node.service` is restarted; Node identity,
credentials, Atlas Server, Web and PostgreSQL are unchanged.

The VPS sudo prompt can appear once. If validation, transfer, installation or
activation fails, the command exits unsuccessfully; lifecycle activation retains
its automatic rollback. Run `./atlasctl vps node-status` to check current
version and connection. For a different configured SSH host use the existing
`ATLAS_VPS_SSH_HOST` environment override. The command does not configure
GitHub App publishing credentials and does not run unattended.

The manual verify/install/plan/activate commands below remain available for
recovery or constrained environments.

## Independent interrupted-activation recovery (required for production)

**Before the next activation**, install the recovery watchdog from a reviewed
checkout onto the Linux host. It runs independently of the Node process, so it
can still restore the old Node when the SSH caller, updater or Node process
dies during restart. The watcher does not retrieve releases, grant approvals,
read credentials, contact Atlas Server, or initiate new updates.

```bash
sudo install -D -o root -g root -m 0755 scripts/linux-node-lifecycle.sh /usr/local/libexec/atlas-node-lifecycle.sh
sudo install -o root -g root -m 0644 scripts/atlas-node-lifecycle-recover.service /etc/systemd/system/
sudo install -o root -g root -m 0644 scripts/atlas-node-lifecycle-recover.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-node-lifecycle-recover.timer
systemctl is-active atlas-node-lifecycle-recover.timer
```

Run these commands **on the VPS** with the reviewed scripts present. Do not
run them from the Mac against local systemd. An explicit Linux activation or
rollback now refuses to proceed on the production release root unless the
timer is both enabled and active. No timer is enabled or host service changed
merely by merging this code.

An activation writes a root-owned, synced `/opt/atlas-node/.activation-pending`
journal identifying the previous and attempted release **before** changing the
`current` pointer. Successful activation clears it after Node reconnection
and the rollback pointer is committed. If a new version does not reconnect,
the lifecycle script restores the prior release; the marker remains until
that release reconnects. If the lifecycle process is killed, the independent
timer invokes `recover` repeatedly (including shortly after boot), returning
`current` to the original version and restarting **only** `atlas-node.service`.
Pending recovery blocks any new activation. Journal contents are validated
against already installed releases, and recovery never accepts a URL, command
or path from the Node or Atlas Server.

To inspect a stalled update, check `sudo bash /usr/local/libexec/atlas-node-lifecycle.sh status`,
`systemctl status atlas-node-lifecycle-recover.timer`, and
`journalctl -u atlas-node-lifecycle-recover.service`. If needed, run
`sudo bash /usr/local/libexec/atlas-node-lifecycle.sh recover`. Do not manually
delete the pending marker; if the original release is missing or the current
pointer has changed unexpectedly, recovery deliberately fails and needs
operator investigation.

This is **host crash recovery only**, not remote host approval, an autonomous
update executor, or Atlas-side execution reporting. A power-loss drill and a
full operational rollback drill must still be run on a nonproduction Node
before relying on it for production updates.

## Status, activation and rollback

The initial install has a \`/opt/atlas-node/current\` symlink and a running
\`atlas-node.service\` managed by systemd. After staging a new release, transfer
\`scripts/linux-node-lifecycle.sh\` to the VPS or stream it over SSH.

Read-only status from a checkout on your Mac:

\`\`\`bash
./atlasctl vps node-status
\`\`\`

From the VPS (use sudo for status and mutations because diagnostics are owned by the service account):

\`\`\`bash
sudo bash linux-node-lifecycle.sh status
bash linux-node-lifecycle.sh plan v2.0.0-<12-digit-commit-prefix>
sudo bash linux-node-lifecycle.sh activate v2.0.0-<12-digit-commit-prefix>
sudo bash linux-node-lifecycle.sh rollback
\`\`\`

The script refuses unmanaged targets, incomplete dependency trees, absent
credentials, inactive services, a missing recovery watchdog, and concurrent lifecycle commands. Activation
atomically switches the symlink, restarts **only** \`atlas-node.service\`, and
checks the service PID matches a freshly connected Node status report.
If connection is not confirmed within the bounded timeout, it restores the
original symlink and restarts the prior Node. A successful activation stores
a \`previous\` symlink; rollback is an explicit operation using that pointer.

The status file is \`/var/lib/atlas-node/.local/state/atlas/node-status.json\`
in the current Linux deployment. Do not move it without updating the lifecycle
configuration. The Node identity, credential file, workspace roots, Docker
containers and PostgreSQL are never changed by this script.

This is **not** automatic release discovery, staging, download, signature
verification, scheduling, or unattended updates. Continue to use verified
artifacts and review CI results before activation. No remote dashboard mutation
or Linux development execution is enabled by this phase.

The integration tests use temporary directories and mocked systemd actions.
Run on Linux to exercise lifecycle state transitions and rollback. Validate
health/restart behavior on a nonproduction host before changing live software.

## Release discovery (operator-run, nonprivileged)

From a Mac checkout with authenticated GitHub CLI, use
`bash scripts/atlas-node-release-check.sh --check` to discover the latest
successful main-branch packaging run, or
`bash scripts/atlas-node-release-check.sh --download /path/to/empty-directory`
to download and verify the archive checksum. This does not deploy or restart the
VPS Node. GitHub Actions artifacts expire after their configured retention
period; rerun the packaging workflow if the latest artifact has expired.

After separately reviewing the source and running the Linux installer to stage a
new version, use `sudo atlas-node-lifecycle plan vVERSION-SHA` and then the
explicit `activate` command. Do not reinstall the current version or activate
the old vulnerable release. The updater is deliberately not yet an unattended
remote-root process.
