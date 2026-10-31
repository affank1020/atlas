# macOS Node: signed release staging

Atlas's existing macOS LaunchAgent (`com.affank1020.atlas.node`) is created
by `./atlasctl launchd install` and currently executes compiled Node code
from a **development checkout**. Its plist and `apps/node/.env.node` contain
the existing configuration, including Node identity and workspace roots.
They must not be replaced merely because a new Node release is available.

## First delivery: prepare a verified release, do not activate it

`scripts/macos-node-stage.py` can download and prepare a specifically
selected **stable immutable** GitHub Node release in a private, versioned
directory on macOS. It never invokes `launchctl`, reads the Node credential
file, edits a LaunchAgent, launches a second Node identity, or changes
Atlas Server/Web/PostgreSQL. Run as the **logged-in macOS user**, never
`sudo`. Requires Python 3.10+, Node.js 20+, npm and GitHub CLI 2.102.0+
authenticated to GitHub for release downloads and attestation verification.

Find the desired immutable Node tag in GitHub Releases or Atlas Software
(the displayed catalog entry is only a candidate, not verified proof).
For example, with an actual, published tag:

```bash
python3 scripts/macos-node-stage.py stage node-v2.0.0-<12-character-source-sha>
```

The tool performs the following security checks **before** admitting a staged
directory:

1. Retrieve the exact tag from `github.com`; require a published, immutable,
   non-prerelease version, matching full source commit and exactly one each of
   the expected archive and SHA-256 assets.
2. Download to a private temporary directory, verify the GitHub asset digest
   and the exact checksum sidecar, and verify the signed archive manifest's
   version, full source SHA, protocol version and macOS platform support.
3. Refuse absolute/traversal paths, symlinks/hardlinks, special files, duplicate
   archive entries, excessive member sizes/counts, and missing runtime files.
4. Verify GitHub Sigstore build provenance, pinned to repository
   `affank1020/atlas`, source `refs/heads/main`, the exact source commit and
   `.github/workflows/node-package.yml`, with self-hosted runners denied.
5. Unpack into a **new** private versioned directory and install only the
   signed Node dependencies via `npm ci --omit=dev --ignore-scripts` using
   the signed Node-only lockfile. The updater doesn't run lifecycle hooks from
   dependencies. It records source/digest metadata after successful staging.

Prepared releases reside under:

```text
~/Library/Application Support/Atlas/NodeSoftware/releases/vVERSION-SHA/
```

The receipt is staging evidence for operator diagnosis, **not a permanent
cryptographic attestation of mutable installed files**. No pre-existing
directory is reused. Network/install failure leaves the running Node alone;
the private temporary directory is removed. The command's cross-platform
unit tests run in normal Atlas CI, and on macOS during Node packaging.

## Activation and rollback

The separately delivered lifecycle and the interactive
[macOS Node updater](MAC_NODE_UPDATE.md) now provide explicit
operator-confirmed launchd cutover, rollback and a one-command
\`check\` / \`update\` experience. The first migration from the developer
checkout requires \`update --migrate\`; unattended installation is **off**.

The signed-staging command in this document is still useful when preparing
a specific immutable release without touching launchd. The coordinator
reuses the same staging verification and lifecycle recovery rather than
introducing a new installer. The standalone scripts currently depend on a
repository checkout for invocation, and production activation remains gated
on real-host acceptance.

Before enabling activation, test on an actual disposable macOS user/host:

- Good signed staging and launchd cutover; verify new PID, exact staged release
  and authenticated Server connection using the existing Node ID.
- Invalid checksum, wrong attestation signer/workflow/ref, wrong source SHA,
  malformed tar path, and existing/partial target fail without restart.
- Missing Node.js or npm, offline GitHub, rejected update, Gatekeeper/
  permissions and incompatible Node protocol fail without changing identity.
- Broken startup/reconnect, killed update process and login/reboot recovery
  restore the previous working release and preserve credentials/workspaces.
- Root-equivalent privileges aren't needed for a per-user LaunchAgent;
  background check/installation policy requires explicit user approval.

Track the complete macOS rollout in [#167](https://github.com/affank1020/atlas/issues/167)
and the fleet Software status in [#168](https://github.com/affank1020/atlas/issues/168).
Linux-specific real-host acceptance remains separately required by
[#111](https://github.com/affank1020/atlas/issues/111).
