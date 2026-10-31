# macOS Node launchd lifecycle

This is an **operator-confirmed** macOS Node activation/rollback tool. It
operates under the **existing logged-in user**, not root, and retains the
existing Node identity, credential file and Workspace roots by preserving
the LaunchAgent's `ATLAS_NODE_ENV_FILE` environment variable and original
plist settings.

**Do not use on your live Mac Node until the disposable-host launchd and
Server-connection acceptance below is completed.** This CLI is intentionally
not wired into Atlas Web or an unattended updater.

## Prerequisites

1. Stage a signed immutable Node release with
   `python3 scripts/macos-node-stage.py stage node-vVERSION-SHA` per
   [MAC_NODE_RELEASE_STAGING.md](MAC_NODE_RELEASE_STAGING.md).
2. Confirm `./atlasctl launchd status` shows the *single* existing hosted
   Node (managed label `com.affank1020.atlas.node`). Stop any separate
   terminal-managed or local-development Node before attempting a cutover.
3. Keep the checkout that hosts `apps/node/.env.node` present: the existing
   Node ID, credential and workspace roots remain in that original file.
   **Do not copy or generate a different identity.**
4. Use a disposable **macOS login user/host** before production deployment.
   All Node changes, watchdog installation and rollback must be explicitly
   approved in that user session.

## Commands

```bash
# No launchd/service mutation:
python3 scripts/macos-node-lifecycle.py status
python3 scripts/macos-node-lifecycle.py plan vVERSION-SHA

# Operator action: installs only the per-user recovery watchdog, no Node restart:
python3 scripts/macos-node-lifecycle.py install-watchdog

# Separate explicit operator confirmation, once acceptance is complete:
python3 scripts/macos-node-lifecycle.py activate vVERSION-SHA --confirm

# If required, explicitly undo the last successful activation:
python3 scripts/macos-node-lifecycle.py rollback --confirm

# Manual recovery from an abandoned pending transaction:
python3 scripts/macos-node-lifecycle.py recover
```

Only the exact versioned **pre-staged** release is eligible for activation.
The tool checks the recorded staging receipt and Node manifest (source commit,
protocol v2, platform) and refuses symlinks or unexpected paths. The staging
receipt is **not immutable cryptographic evidence** of the installed files:
the original signed archive was verified during staging, but the files remain
mutable by this user. They must not be treated as a trust boundary against a
compromised local user.

Activation makes an atomic backup of the existing plist in a durable pending
journal *before* changing the LaunchAgent. The candidate plist preserves the
existing environment and Node identity file path, changing only the built
Node entrypoint and working directory. It then unloads and bootstraps the
**same** launchd label, first waiting for the prior Node PID to exit
so two Node processes cannot briefly share the same identity. A surviving
orphaned process blocks recovery until it is safely reconciled. A successful
operation requires a **different** launchd MainPID and a newer `node-status.json` entry reporting
`state=connected` with that PID. A local `connected` file is **not**
independent Server-side registration; real-host acceptance must check the
Server's authenticated Node presence separately.

For a failed activation, the tool attempts to restore the previous plist and
verify its fresh local reconnect. If that also fails (or the CLI is killed),
the pending journal stays on disk. The separate per-user recovery LaunchAgent
runs `recover` at login and every 60 seconds, with a 100-second grace period.
Recovery is deliberately **rollback-directional**: interrupted explicit
rollback is completed, rather than reactivating rejected code. A successful
rollback records the prior version as a potential next manual target; there
is no automatic upgrade/install policy.

State files and the copied recovery script live under the private
`~/Library/Application Support/Atlas/NodeSoftware/activation/` directory.
The watchdog plist is a separate user LaunchAgent
`~/Library/LaunchAgents/com.affank1020.atlas.node.recover.plist`.
The tool refuses a missing/unloaded/outdated watchdog before attempting to
switch the existing Node. The interactive macOS updater can explicitly
refresh an already-loaded older watchdog under the lifecycle lock and
durable rollback journal, after the operator approves the exact update.
The direct lifecycle commands `refresh-watchdog --confirm` and
`restore-watchdog --confirm` support safe manual replacement and recovery;
an interrupted refresh blocks activation until the old watchdog has been
restored. This migration changes only the per-user recovery LaunchAgent,
never the Node identity or active Node LaunchAgent. If an initial watchdog `launchctl bootstrap` fails,
run `install-watchdog` again after fixing the macOS login session: the CLI
can retry only when both existing files match the expected current script and
plist exactly, under the same user. It refuses to overwrite a loaded watchdog
or a modified installation; those cases require operator inspection. If the
currently running Node exits between preflight and journalling, activation
refuses before creating any pending transaction.

## Operational caveats and acceptance

The standard `./atlasctl launchd install` still manages a **development
checkout**. All hosted Node and launchd mutations from `atlasctl`
(including install, uninstall, start, stop and restart) now execute under
the **same exclusive per-user filesystem lock** as lifecycle activation,
rollback and watchdog recovery. The lock spans the complete development
build and service mutation, so another terminal cannot switch the release
between a preflight check and launchd bootstrap. A separate Python
supervisor retains this lock for the entire Node CLI operation and also
passes the descriptor to its child, preserving exclusion if the supervisor
crashes. Lock contention is fail-closed; retry the command after the
other operation completes. The previous pending-journal and release-managed
plist guards still apply under that lock. Use this lifecycle's rollback or
an explicit manual recovery procedure to change the selected release. If an update fails to restore local connectivity, the pending
journal is left for recovery; investigate before attempting another update.
The recovery watchdog runs as a per-user LaunchAgent and therefore requires
that the logged-in user session exists; it is **not** an always-on system
daemon.

The test suite
`python3 -m unittest discover -s test -p 'test_macos_node_lifecycle.py' -v`
exercises actual plist writes, private journal, restart sequencing and
identity preservation against disposable paths, with `launchctl` mocked.
Passing tests is **not** acceptance of a real host.

Record these live, disposable-macOS acceptance results before updating a
personal machine: old/new PID and full Node source SHA, actual launchd
bootstrap status, real Atlas Server session under the **same Node UUID**,
Workspace availability, Mac sharing consent, daemon reconnection after
failed startup, SIGKILL during activation and rollback, recovery timer after
logout/login and reboot, missing/outdated watchdog, zero duplicate Node
processes, Gatekeeper and permissions behavior, and retention of the original
credential file. Validate the absence of secrets in evidence/logs.

## Real launchd check-only smoke on disposable CI macOS

The `Atlas macOS Node lifecycle` workflow also runs
`test/test_macos_node_launchd_real.py` on a **GitHub-hosted macOS runner**
with `ATLAS_MACOS_LAUNCHD_SMOKE=1`. This test is different from the
in-memory/mock-`launchctl` unit tests:

- It refuses to run as root or over an existing Atlas NodeSoftware directory,
  runtime LaunchAgent, or recovery LaunchAgent. It requires the explicit CI
  opt-in and a GitHub-hosted macOS user session.
- It creates a local **test-only, not cryptographically signed** release fixture
  and a one-off label under `com.affank1020.atlas.node.update-check.acceptance.*`.
  No production Node LaunchAgent label, credentials, Node PID or workspaces
  are touched.
- It uses **real `launchctl bootstrap` and `bootout`**, checks the loaded
  LaunchAgent, waits for `RunAtLoad` to execute the standalone Python
  checker, verifies a private `unavailable` observation (since no real Node
  exists), then validates removal and cleans the disposable fixture.
- It never stages an actual release archive, installs/upgrades Node, tests
  a 60-minute timer interval, or proves Sigstore verification. The fixture
  only exercises the runtime wiring of a signed-style operator bundle.
- The test must fail if the runner lacks a suitable user `gui/<uid>` domain,
  cannot load the job, or the checker never executes. A skipped or failed
  run must **not** be counted as real-launchd acceptance.

This closes a narrow checker-`launchctl` integration gap; it **does not**
replace the full macOS host drill below. The runtime activation,
watchdog-recovery, SIGKILL, reboot, and authenticated Atlas Server registration
still require a disposable machine/user with a real independently verified
Node release, before updating the personal Mac or enabling unattended installs.

Track [#167](https://github.com/affank1020/atlas/issues/167) and
[#111](https://github.com/affank1020/atlas/issues/111). Nothing is
automatically deployed by merging this change.
