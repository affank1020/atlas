# macOS Node updates

The operator CLI combines release discovery, signed staging and the existing
crash-safe launchd cutover. It does not operate as a background updater, enable
an automatic policy, migrate credentials, or update Atlas Server/Web.

**Before changing the real Mac Node:** perform the disposable-login-user
launchd acceptance in [MAC_NODE_LIFECYCLE.md](MAC_NODE_LIFECYCLE.md).
A passing CI runner with mocked launchctl cannot prove live host safety.

## Commands

Requirements: macOS logged-in non-root user, Python 3.10+, Node.js 20+,
npm, GitHub CLI 2.102.0+ with release/attestation access, the existing hosted
LaunchAgent, and the updater scripts from this repository.

Run from the repository checkout:

\`\`\`bash
python3 scripts/macos-node-update.py status
python3 scripts/macos-node-update.py check
python3 scripts/macos-node-update.py check --json

# First use: explicit migration from a checkout-managed LaunchAgent
python3 scripts/macos-node-update.py update --migrate

# Subsequent versioned release updates
python3 scripts/macos-node-update.py update

# Roll back to the preceding LaunchAgent, with interactive confirmation
python3 scripts/macos-node-update.py rollback
\`\`\`

**There is no automatic installation.** The command displays the exact stable
release tag and requires typing \`UPDATE node-vVERSION-SHA\`. It checks the
public release catalogue twice, including full source SHA, asset digest,
monotonic same-version release sequence and the observed launchd entrypoint.
It then downloads and verifies the selected archive against immutable release
metadata and a pinned GitHub Sigstore build attestation before touching the
Node process. If an identical release was previously signed-staged, its
recorded source and archive digest must match the catalogue candidate;
the existing on-disk receipt is *not* a cryptographic trust boundary against
a compromised local macOS user.

On the first confirmed update, the coordinator installs the existing
non-root recovery watchdog if absent and unmodified. It then delegates to
the already-tested launchd lifecycle. That lifecycle uses one exclusive lock,
journals changes before cutover, checks old PID termination, requires a fresh
local connected heartbeat with a new PID and rolls back on failure. The
coordinator pins the expected pre-update entrypoint inside that same lifecycle
lock so concurrent \`atlasctl\` or lifecycle operations cannot silently turn
the approved upgrade into a downgrade.

It preserves the original \`ATLAS_NODE_ENV_FILE\` path, LaunchAgent label,
Node identity and workspaces. It doesn't copy the credential into the release
folder or install a second Node. A fresh *local* heartbeat is **not** proof of
authenticated Server-side registration. Verify the existing UUID in Atlas
Nodes after any real-host drill; verify sharing and Workspaces too.

## Status and recovery

\`status --json\` reports local install kind, current entrypoint, PID, pending
recovery and whether a rollback plist exists. \`check --json\` adds the latest
catalogue candidate, full source, archive digest and candidate-only verification
state. A catalogue entry is **not verified signed code** until staging.

The updater refuses noninteractive updates, unconfirmed migration, an offline
hosted launchd Node, pending recovery, downgrades, stale or ambiguous
same-version builds, changed candidates, and modified loaded watchdogs. An
offline GitHub release check fails without changing the Node.

If recovery is pending, use:

\`\`\`bash
python3 scripts/macos-node-lifecycle.py recover
python3 scripts/macos-node-update.py status
\`\`\`

If the watchdog is loaded but outdated or modified, stop and inspect the
existing installation. Do not delete/replace it while launchd is active.
The updater will not attempt to force-repair it.

The scripts currently run from a repository checkout, although the staged
Node runtime is release-managed. A separately provisioned updater bundle
and real macOS login-host validation remain required before treating macOS CD
as fully rolled out. Linux's host-local updater is independent and unaffected;
neither platform's automatic installation is enabled by this PR.

See [issue #167](https://github.com/affank1020/atlas/issues/167) and
[issue #111](https://github.com/affank1020/atlas/issues/111).
