# Linux Node lifecycle (manual rollout)

The Linux Node runs independently of Atlas Server and PostgreSQL. Install and
audit a checksum-verified release first with \`scripts/linux-node-release.sh\`.
Each immutable release is stored beneath \`/opt/atlas-node/releases\`.

## VPS-local upgrade without a Mac checkout (staged rollout)

The standalone host-local `scripts/linux-node-host-updater.py` replaces routine
Mac → SCP → VPS steps with a **VPS-side** update command. It uses the existing
immutable GitHub Release channel and requires a verified GitHub build-provenance
attestation. An operator must explicitly confirm activation; **no unattended
updates, Atlas Web install button, host service, or production configuration
are enabled by merging this script**.

After inspecting the helper scripts from a reviewed checkout on the VPS, install
the operator CLI and its required trusted, root-owned lifecycle helpers.
The `status` command invokes the reviewed root-owned lifecycle status helper
through `sudo`: the service account's private heartbeat is not readable by
a normal VPS user, and the tool must not falsely show an online Node as offline.

```bash
sudo install -o root -g root -m 0755 scripts/linux-node-host-updater.py /usr/local/bin/atlas-node-update
sudo install -o root -g root -m 0755 scripts/linux-node-trusted-stage.sh /usr/local/libexec/linux-node-trusted-stage.sh
sudo install -o root -g root -m 0755 scripts/linux-node-release.sh /usr/local/libexec/linux-node-release.sh
# Keep /usr/local/libexec/atlas-node-lifecycle.sh and its recovery watchdog
# installed exactly as documented below; do not replace the lifecycle with
# an arbitrary copy after validating the host.
```

As the **normal non-root** VPS account, the read-only release check now
uses the public GitHub HTTPS API without GitHub credentials. The interactive
`update` command still requires an authenticated recent GitHub CLI
(`gh` >= 2.102.0) for downloads and signed attestation verification. Then:

```bash
atlas-node-update status
atlas-node-update check
atlas-node-update update
# Only after inspecting a failed deployment or deliberately rolling back:
atlas-node-update rollback
```

`check` is read-only. It lists the installed version and newest eligible
immutable stable release; same-version ordering is based on the CI release
sequence rather than GitHub publication date. It deliberately refuses an
unknown same-version installed build or a truncated release list instead of
guessing. `update` downloads exact fixed release assets as the non-root user,
checks the GitHub digest and sidecar, pins Sigstore source repo/workflow/ref/SHA,
asks for an explicit typed confirmation, and delegates to root-owned verified
staging and the existing lifecycle activate/rollback watchdog.

**Existing target releases are intentionally refused**, even when the name and
metadata look correct: an older checksum-only installer could have staged
different unsigned bytes at the same path. The updater cannot authenticate
a pre-staged directory simply by checking its ownership or manifest.
An operator must inspect any such release and arrange supervised removal or
recovery before a fresh signed staging attempt. **Never delete the active
`current` or `previous` rollback target simply to make an update succeed.**
The root installer also refuses a target that appears concurrently.

Credentials, workspaces, Server/Web, and PostgreSQL are not modified. A missing
watchdog, invalid helper ownership, unverified artifact or failed reconnect
stops the update (with lifecycle recovery/rollback where applicable).

**Acceptance gate:** run healthy, wrong-signature, corrupt-release,
interrupted-update and failed-reconnect drills on a disposable Linux host before
provisioning this on the live VPS. Unattended update policies, scheduled checks,
host-root evidence reconciliation and Atlas Software UI integration remain
tracked in [#111](https://github.com/affank1020/atlas/issues/111),
[#167](https://github.com/affank1020/atlas/issues/167) and
[#168](https://github.com/affank1020/atlas/issues/168).

## Optional scheduled release detection (no automatic installation)

This is an **operator-provisioned, read-only** Linux systemd timer: it
checks GitHub's public release catalogue once per hour, without a GitHub
token, sudo, Node credentials, access to private user homes, or a writable
system filesystem. It does **not** download the release archive, request root
authorization, touch the running Node, or activate anything. A published
candidate is only a *catalogue hint*, not a verified artifact until the
separate interactive `update` command validates its signed provenance.

From a reviewed checkout **on a disposable Linux host first**, provision
the checked-in service and timer. Replace `ubuntu` with the name of an
existing, unprivileged operator account that can read
`/opt/atlas-node/current` and its release directory.

```bash
# First install the reviewed atlas-node-update CLI as documented above.
sudo install -o root -g root -m 0644 scripts/atlas-node-update-check@.service /etc/systemd/system/
sudo install -o root -g root -m 0644 scripts/atlas-node-update-check@.timer /etc/systemd/system/
sudo systemctl daemon-reload
# Review effective sandbox and exact selected user before enabling:
systemctl cat atlas-node-update-check@ubuntu.service
sudo systemctl enable --now atlas-node-update-check@ubuntu.timer

# Query release availability without credentials or privileged execution:
atlas-node-update check --json
sudo systemctl start atlas-node-update-check@ubuntu.service
sudo journalctl -u atlas-node-update-check@ubuntu.service -n 30 --no-pager
```

The JSON contains `schema`, `installed`, `candidate`, `state` and
`verification: catalogue-only`. A successful check reports either
`current` or `available`, both with exit code 0. A network failure,
invalid/truncated catalogue, unknown installed same-version build, or
unparseable metadata exits nonzero, never reporting an update as installed.
The check is bounded by a **hard 20-second wall-clock deadline** for the
entire HTTPS connection and response body, alongside an 8 MiB response
limit. The Python socket timeout alone would not stop a slow-drip response;
the Linux CLI also uses a real-time process alarm and refuses an expired
check without treating the result as a completed update.
Systemd's `RandomizedDelaySec` spreads polls and the timer retains scheduled
checks across host restarts.

**No service or timer is automatically enabled by this PR.** Do not enable
it on the production VPS until a disposable-host check has confirmed the
actual Node service remains unchanged, the sandbox is compatible with
the installed filesystem, and the observed journal distinguishes errors
from available updates. Disabling the timer does not change Node operation:

```bash
sudo systemctl disable --now atlas-node-update-check@ubuntu.timer
```

Unattended automatic **installation** is a separate, security-sensitive
milestone in [#111](https://github.com/affank1020/atlas/issues/111)
and [#167](https://github.com/affank1020/atlas/issues/167);
do not confuse a polling timer with permission for an unattended root
upgrade.

## Previous Mac-initiated one-command upgrade

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
# Replace the legacy PATH command as well, rather than retaining an unsafe old binary.
sudo ln -sfnT /usr/local/libexec/atlas-node-lifecycle.sh /usr/local/bin/atlas-node-lifecycle
sudo test "$(readlink -f /usr/local/bin/atlas-node-lifecycle)" = /usr/local/libexec/atlas-node-lifecycle.sh
sudo install -o root -g root -m 0644 scripts/atlas-node-lifecycle-recover.service /etc/systemd/system/
sudo install -o root -g root -m 0644 scripts/atlas-node-lifecycle-recover.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-node-lifecycle-recover.timer
systemctl is-active atlas-node-lifecycle-recover.timer
```

Run these commands **on the VPS** with the reviewed scripts present. Do not
run them from the Mac against local systemd. The normal `./atlasctl vps
node-upgrade` flow now invokes the **same absolute,
root-owned `/usr/local/libexec/atlas-node-lifecycle.sh`** as the recovery
timer; it fails before staging when that implementation or the timer is
missing. The `/usr/local/bin/atlas-node-lifecycle` compatibility symlink
also replaces the previous PATH executable. Do not execute a stale lifecycle
binary installed elsewhere, including one in `/usr/bin`. An explicit Linux
activation or rollback refuses to proceed on the production release root
unless the timer is both enabled and active. No timer is enabled or host
service changed merely by merging this code.

An activation writes a root-owned, synced `/opt/atlas-node/.activation-pending`
journal identifying the previous and attempted release plus the fixed
operation (activate/rollback) **before** changing the `current` pointer.
Successful activation clears it after Node reconnection and the rollback
pointer is committed. If a new update version does not reconnect, the lifecycle
script restores the prior release; the marker remains until that release
reconnects. If the lifecycle process is killed, the independent timer invokes
`recover` repeatedly (including shortly after boot): it restores the original
release for an interrupted upgrade, but **completes the requested rollback**
for an interrupted manual rollback. A failed manual rollback stays pending
rather than silently reactivating the rejected version. Recovery restarts
**only** `atlas-node.service`.
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
sudo /usr/local/libexec/atlas-node-lifecycle.sh status
/usr/local/libexec/atlas-node-lifecycle.sh plan v2.0.0-<12-digit-commit-prefix>
sudo /usr/local/libexec/atlas-node-lifecycle.sh activate v2.0.0-<12-digit-commit-prefix>
sudo /usr/local/libexec/atlas-node-lifecycle.sh rollback
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

## Disposable lifecycle acceptance: CI simulation versus real-host proof

Before scheduling unattended Linux upgrades, run the lifecycle's non-root
**integration acceptance** suite on every PR/merge:

```bash
python3 -m unittest discover -s test -p 'test_linux_node_lifecycle_integration.py' -v
```

The suite executes the **actual** `linux-node-lifecycle.sh` using disposable
`/tmp` release trees, valid Node manifests and the real symlink/journal
filesystem operations. Only external `systemctl` and `npm ls` are simulated
with test-local executables. Assertions cover successful activation,
reconnection-gated commit, automatic rollback on a failed heartbeat,
hard process termination after switching symlinks, watchdog-style recovery,
interrupted explicit rollback, stale source checks, malformed pending journals
and missing releases. No host service, root configuration, Node credentials
or production directory is accessed.

This CI suite **does not replace** the following mandatory disposable
Linux VM acceptance before opting into automatic installs:

| Host drill | Required independently observed evidence |
| --- | --- |
| Verified install | Immutable GitHub asset digest **and** pinned Sigstore source/workflow/commit; root stage receipt and exact installed tree |
| Successful activation | Old/new versions and release SHAs, systemd main PID, fresh real Node WebSocket registration, journal cleared and rollback target recorded |
| Invalid artifact | Wrong checksum, signer/workflow/ref, stale commit or untrusted existing target is rejected **before** service restart |
| Failed registration | Simulated Node service fails to reconnect; previous version runs again; root status and actual Server registration agree |
| Interrupted activation | Kill the installer after the journal and symlink switch; the **real enabled recovery timer** restores the previous healthy release after restart/reboot |
| Interrupted rollback | Recovery finishes the chosen rollback, never silently reactivating the rejected version |
| Root approval and audit | For Server-initiated updates only: root-local approval, one-use claim, signed evidence, and independently verified reconciliation under [#111](https://github.com/affank1020/atlas/issues/111) |
| Scheduled checker | The `atlas-node-update-check@.timer` actually runs under the selected non-root account and sandbox; `check --json` neither installs anything nor restarts the service |

Record the test host identity, service state, versions, SHA, verification output,
release signer, command exit status, recovery timer logs and before/after
Node registration. Do not copy credential files into evidence. A unit-test pass
must never be presented as completion of these systemd/Sigstore/host-root
acceptance gates.

**Production gate:** keep the check-only timer optional and unattended
installation disabled until every host drill has reviewable evidence and the
operator explicitly authorises rollout. The acceptance harness does not
install services, alter production, or make an updater privileged by merging.

## Release discovery (operator-run, nonprivileged)

From a Mac checkout with authenticated GitHub CLI, use
`bash scripts/atlas-node-release-check.sh --check` to discover the latest
successful main-branch packaging run, or
`bash scripts/atlas-node-release-check.sh --download /path/to/empty-directory`
to download and verify the archive checksum. This does not deploy or restart the
VPS Node. GitHub Actions artifacts expire after their configured retention
period; rerun the packaging workflow if the latest artifact has expired.

After separately reviewing the source and running the Linux installer to stage a
new version, use `sudo /usr/local/libexec/atlas-node-lifecycle.sh plan vVERSION-SHA` and then the
explicit `activate` command. Do not reinstall the current version or activate
the old vulnerable release. The updater is deliberately not yet an unattended
remote-root process.
