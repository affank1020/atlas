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
credentials, inactive services, and concurrent lifecycle commands. Activation
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
