# macOS Node updates

The operator CLI combines release discovery, signed staging and the existing
crash-safe launchd cutover. It does not operate as a background updater, enable
an automatic policy, migrate credentials, or update Atlas Server/Web.

**Before changing the real Mac Node:** perform the disposable-login-user
launchd acceptance in [MAC_NODE_LIFECYCLE.md](MAC_NODE_LIFECYCLE.md).
A passing CI runner with mocked launchctl cannot prove live host safety.

## Bootstrap the standalone updater once

Requirements: a logged-in non-root macOS user, Python 3.10+, Node.js 20+,
npm, GitHub CLI 2.102.0+ with release/attestation access, and an existing
Atlas Node LaunchAgent. An initial **reviewed checkout** is used only to
stage and provision the signed operator. This does **not** migrate or
restart the existing Node.

Choose a **published, immutable Node release built after this operator
bundle was added**. Older releases do not carry the required scripts and
are intentionally refused. Replace the placeholder with the real signed tag:

```bash
# One-time bootstrap from a reviewed Atlas source checkout:
python3 scripts/macos-node-stage.py stage node-vVERSION-SHA
python3 scripts/macos-node-operator.py install vVERSION-SHA --confirm
```

The installer checks the signed staging receipt and the manifest-bound SHA-256
of **all five bundled updater scripts**. It then atomically selects them
under a private per-user directory and creates one executable wrapper at:

```text
~/Library/Application Support/Atlas/NodeSoftware/bin/atlas-node-mac
```

The wrapper always resolves a previously signed-staged release, **not the
source checkout**. No new privileged service, scheduled auto-install policy,
additional Node identity or background job is created. The original Node
credential file path remains unchanged.

## Routine commands (no checkout required)

```bash
operator="$HOME/Library/Application Support/Atlas/NodeSoftware/bin/atlas-node-mac"
"$operator" status
"$operator" check
"$operator" check --json

# First migration of the existing development-checkout-managed Node:
"$operator" update --migrate

# Subsequent updates, confirmed against a specific signed release:
"$operator" update

# Explicit rollback (still requires confirmation):
"$operator" rollback
```

The CLI source pointer advances **only after a successful Node activation**,
when the newly staged release has a valid signed operator bundle. Before
switching that pointer, the lifecycle lock checks that the loaded recovery
LaunchAgent is compatible with the **new** signed operator. When the
lifecycle script changed across versions, the operator migrates the loaded
watchdog to the new signed script using its existing journal and failure
rollback. If replacement fails, the CLI pointer remains on its previous
release, so routine updates and rollback remain accessible.

A killed updater can leave the old CLI pointer paired with the newer
watchdog between those two steps. The confirmed `rollback` command
reconciles the watcher to its own signed lifecycle before rolling back the
Node, and the operator's explicit `sync --confirm` can finish aligning
the updater with the active signed runtime. The active Node may already
have updated successfully even if operator promotion did not complete;
do not repeat the cutover blindly. If interrupted between Node cutover
and operator promotion, explicitly sync from the **currently active**
verified release (not a fresh network candidate):

```bash
python3 "$HOME/Library/Application Support/Atlas/NodeSoftware/operator/current/macos-node-operator.py" sync --confirm
```

The standalone CLI isn't an auto-updater: each runtime update remains
interactive. The operator and its compatibility are verified in CI, but the
first real macOS login-session migration still requires disposable-host
acceptance.

## Optional hourly update discovery

After installing the signed standalone operator, the Mac can check for new
public releases every hour **without** staging archives, installing updates,
changing the Node's LaunchAgent, or opening a privileged tool. This is
deliberately opt-in, similar to Linux's existing check-only timer.

```bash
operator="$HOME/Library/Application Support/Atlas/NodeSoftware/bin/atlas-node-mac"
"$operator" monitor status
"$operator" monitor status --json
"$operator" monitor enable    # interactive: ENABLE CHECKS
"$operator" monitor disable   # interactive: DISABLE CHECKS
```

Enabling installs a *separate*, same-user LaunchAgent
`com.affank1020.atlas.node.update-check` with `StartInterval=3600` and
`RunAtLoad=true`. It uses the installed, signed Python operator via the
private `operator/current` symlink, so future operator promotions do not
require replacing the checker job. It never grants root access or performs
downloads and installations. It does not run while the user is logged out
and cannot be relied upon for unattended host recovery.

The checker writes a private JSON observation to
`~/Library/Application Support/Atlas/NodeSoftware/release-check.json`:
`checkedAt`, `state`, installed version and candidate tag (when known).
Public GitHub catalogue discovery runs **outside** the Node lifecycle lock,
so slow network requests cannot block updates. Its final operator version
check, pending-recovery check and atomic observation write happen **inside**
that same lock, preventing an old checker from publishing a candidate after
an operator promotion. If a promotion wins first, the old check writes an
explicit `unavailable` observation instead of an obsolete candidate.
Its `verification: catalogue-only` value explicitly means this is
**unverified metadata**, not approval or signed-byte verification. If GitHub
is unreachable, the configured Node cannot be inspected, or the local
recovery journal is pending, the stored state is `unavailable` or
`needs-attention`, not an invented up-to-date status. It never writes
credentials, Node UUIDs, exception details, or filesystem paths into the
observation. A last-check record may be stale; consult its timestamp.

The schedule can be disabled without stopping the Atlas Node or changing its
credentials. Unknown or modified LaunchAgent plists and symlinked status files
are rejected. If a Python upgrade removes the interpreter recorded in the
checker's existing LaunchAgent, `monitor status` reports `needs-attention`.
Use `monitor disable` followed by `monitor enable` to intentionally
re-provision it with the current Python; the old missing interpreter does
not prevent disabling the job. If the LaunchAgent plist is installed but `launchctl` cannot
find a loaded checker job, `monitor status` reports `needs-attention`
rather than `enabled`. Scheduled checks are **not automatic installation**;
`"$operator" update` still requires its original exact-release confirmation.


**There is no automatic installation.** The command displays the exact stable
release tag and requires typing `UPDATE node-vVERSION-SHA`. It checks the
public release catalogue twice, including full source SHA, asset digest,
monotonic same-version release sequence and the observed launchd entrypoint.
It then downloads and verifies the selected archive against immutable release
metadata and a pinned GitHub Sigstore build attestation before touching the
Node process. If an identical release was previously signed-staged, its
recorded source and archive digest must match the catalogue candidate;
the existing on-disk receipt is *not* a cryptographic trust boundary against
a compromised local macOS user.

After the exact update is confirmed, the coordinator ensures the non-root
recovery watchdog is installed. If an older watchdog is already loaded, it
uses an operator-approved watchdog refresh under the existing lifecycle lock:
validate the previous per-user LaunchAgent, durably journal its original
script and plist, boot it out and wait for its process to exit, install the
new script, then rebootstrap and verify it loaded. A failed bootstrap
automatically tries to restore the previous loaded watchdog; a killed
updater leaves an explicit restore operation instead of silently
overwriting running code. The coordinator then delegates to
the already-tested launchd lifecycle. That lifecycle uses one exclusive lock,
journals changes before cutover, checks old PID termination, requires a fresh
local connected heartbeat with a new PID and rolls back on failure. The
coordinator pins the expected pre-update entrypoint inside that same lifecycle
lock so concurrent `atlasctl` or lifecycle operations cannot silently turn
the approved upgrade into a downgrade.

It preserves the original `ATLAS_NODE_ENV_FILE` path, LaunchAgent label,
Node identity and workspaces. It doesn't copy the credential into the release
folder or install a second Node. A fresh *local* heartbeat is **not** proof of
authenticated Server-side registration. Verify the existing UUID in Atlas
Nodes after any real-host drill; verify sharing and Workspaces too.

## Status and recovery

`status --json` reports local install kind, current entrypoint, PID, pending
recovery and whether a rollback plist exists. `check --json` adds the latest
catalogue candidate, full source, archive digest and candidate-only verification
state. A catalogue entry is **not verified signed code** until staging.

The updater refuses noninteractive updates, unconfirmed migration, an offline
hosted launchd Node, pending recovery, downgrades, stale or ambiguous
same-version builds, changed candidates, unexpected watchdog jobs/plists
and unfinished watchdog refreshes. An offline GitHub release check fails
without changing the Node.

If recovery is pending, use:

```bash
python3 "$HOME/Library/Application Support/Atlas/NodeSoftware/operator/current/macos-node-lifecycle.py" recover
"$HOME/Library/Application Support/Atlas/NodeSoftware/bin/atlas-node-mac" status
```

If a previous watcher refresh was interrupted, **do not manually delete its
journal or files**. Restore the previous working watchdog explicitly:

```bash
python3 "$HOME/Library/Application Support/Atlas/NodeSoftware/operator/current/macos-node-lifecycle.py" restore-watchdog --confirm
"$HOME/Library/Application Support/Atlas/NodeSoftware/bin/atlas-node-mac" status
```

The restore command holds the lifecycle lock, checks the durable backup,
waits for any loaded watchdog process to exit, then reinstalls and loads
the original plist/script. If its bootstrap fails, the journal remains for
operator inspection/retry. A loaded watchdog with unexpected job settings,
symlinked paths or unsafe ownership is rejected rather than overwritten.
Never manually change the watchdog while the LaunchAgent is loaded.

The standalone macOS operator is versioned inside the same signed Node
release, but no updater or Node activation happens merely by merging the PR.
The original checkout hosting the credential file must remain readable even
after the runtime is release-managed. Real-host acceptance remains required
before enabling automatic installation. Linux's host-local updater is
independent and unaffected; neither platform's automatic installation is enabled.

See [issue #167](https://github.com/affank1020/atlas/issues/167) and
[issue #111](https://github.com/affank1020/atlas/issues/111).
