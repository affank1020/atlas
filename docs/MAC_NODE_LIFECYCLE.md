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
**same** launchd label. A successful operation requires a **different**
launchd MainPID and a newer `node-status.json` entry reporting
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
switch the existing Node; replacing an already-installed watchdog needs a
separately inspected maintenance action.

## Operational caveats and acceptance

The standard `./atlasctl launchd install` still manages a **development
checkout**. Do not rerun it over a release-managed plist: restore the previous
config using this lifecycle's rollback or follow an explicit manual recovery
procedure. If an update fails to restore local connectivity, the pending
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

Track [#167](https://github.com/affank1020/atlas/issues/167) and
[#111](https://github.com/affank1020/atlas/issues/111). Nothing is
automatically deployed by merging this change.
