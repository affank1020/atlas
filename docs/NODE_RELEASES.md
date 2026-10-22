# Atlas Node release packaging

Atlas Nodes are compiled independently of Atlas Server and Web. The packaging
job `.github/workflows/node-package.yml` runs on relevant changes to main
and can also be dispatched manually.

The job builds `@atlas/protocol` and `@atlas/node`, regenerates an isolated
Node-only npm lockfile (no Server/Web workspaces or Handlebars), packages the compiled
code and required npm workspace manifests, and uploads a tarball + SHA-256
checksum as GitHub Actions artifacts (14-day retention). After a successful
main-branch packaging run, the workflow also attests the archive with GitHub
Sigstore build provenance and publishes **immutable-by-name** GitHub Release
assets under `node-v<version>-<12-character-source-commit>`. Publication
refuses to overwrite an existing tag. Publication is serialized and checks
whether any Node packaging input changed between the packaged commit and
current `main`. Web-only and docs-only changes must not suppress the
last valid Node build; newer Node/protocol/packaging changes supersede it.
Each successful publication includes a monotonic GitHub Actions run number
(`Atlas-Node-Release-Sequence`) in its release notes.
Prerelease SemVer builds may be packaged and tested but are
**never published to the stable channel**. Enable GitHub's **immutable releases**
repository setting before treating the channel as production-grade. The
published release has no Server/Web files, credentials or environment config.

Atlas discovers only published **immutable** stable Node bundles from GitHub Releases metadata,
validating archive naming, matching checksum assets, canonical download URLs,
GitHub-provided SHA-256 digests, full source commit IDs and unique source commits.
The stable catalogue excludes SemVer prereleases even if GitHub's prerelease
flag is false. For different stable versions it compares SemVer; for builds
sharing the same version it sorts by the publisher's monotonic workflow
sequence, never by completion/publication timestamps. An entry with no valid
sequence or full matching source commit is not offered. Conflicting sequences
fail closed. Catalogue refresh requires only the single GitHub Releases list
request; it does not perform per-release Git comparison requests.
The catalogue
does **not** import expiring workflow artifacts or debug APKs and does not
install, restart, or re-enrol Nodes.

**Trust boundary:** The catalogue checks published release metadata and
GitHub's asset SHA-256 digest but does **not** cryptographically verify the
build-provenance attestation or its workflow/source identity. It labels every
entry `provenance: unverified`, including an archive manually published without
an attestation. Download does not imply safe installation. Before using any
archive, verify the checksum against the downloaded bytes **and** run
`gh attestation verify`; check that the attestation comes from the expected
`affank1020/atlas` main-branch `.github/workflows/node-package.yml` build.
If provenance verification fails or the expected workflow identity differs,
do not install or activate the release. A subsequent phase may add verified
attestation handling server-side; the catalogue must not claim it until then.

On a supported macOS/Linux machine, an operator can inspect and verify a
downloaded archive before installation:

```bash
shasum -a 256 -c atlas-node-v*.tar.gz.sha256
gh attestation verify atlas-node-v*.tar.gz --repo affank1020/atlas
mkdir -p /path/to/atlas-node-release
tar -xzf atlas-node-v*.tar.gz -C /path/to/atlas-node-release
cd /path/to/atlas-node-release
npm ci --omit=dev --ignore-scripts --workspace @atlas/node --workspace @atlas/protocol --include-workspace-root=false
```

An independent, authenticated Node config and lifecycle service must then be
configured on the host; **do not** copy an existing Node ID, credential, or
workspace roots. Existing macOS launchd runtime remains unchanged by this job.

The initial bundle is built on Linux using platform-neutral JS. The Node
runtime preserves macOS status reporting and uses XDG state directories on
Linux. It advertises its package version (and the release commit when packaged).
Linux service supervision, secure execution isolation and VPS integration are
still pending, so this packaging workflow does not install a production Node.

For local packaging development, use:
```bash
npm run build:node
ATLAS_ALLOW_DIRTY_NODE_PACKAGE=1 node scripts/package-node-release.mjs
```
Never use a dirty-checkout artifact as a production release. The normal
packaging command refuses to label uncommitted modifications as immutable.

## Pinned provenance verification and Linux trusted staging

The SHA-256 sidecar verifies **integrity against a supplied checksum**, not
authenticity. Before trusting an archive for Linux, use the dedicated host
helper:

```bash
# GitHub CLI >= 2.102.0, tar, node and Linux required.
# Download bundle as your normal GitHub CLI-authenticated user (NOT sudo):
archive="atlas-node-v2.0.0-<12-character-commit>.tar.gz"  # replace with your release filename
gh attestation download "$archive" -R affank1020/atlas
bundle="sha256:$(sha256sum "$archive" | awk '{print $1}').jsonl"
bash scripts/linux-node-trusted-stage.sh verify "$archive" "$archive.sha256" "$bundle"
sudo bash scripts/linux-node-trusted-stage.sh install "$archive" "$archive.sha256" "$bundle"
```

The helper first checks the portable archive format, checksum, and embedded
source commit. It then uses `gh attestation verify` to pin **all** of:
the exact `affank1020/atlas` repository, the source ref
`refs/heads/main`, the **full source commit SHA**, the signing certificate
identity
`https://github.com/affank1020/atlas/.github/workflows/node-package.yml@refs/heads/main`,
the SLSA v1 provenance predicate, and a GitHub-hosted runner. It fails closed
when the attestation is unavailable, unsigned or does not match. This
requires authenticated GitHub access from the **unprivileged user**
for `gh attestation download`, but not from the root installer: it verifies
the signed bundle locally with `gh attestation verify --bundle`. The bundle is
untrusted input and cannot bypass certificate/source constraints. The installer
refuses an absent bundle; never pass GitHub tokens through sudo or use
`sudo -E`. GitHub CLI may fetch or refresh Sigstore trust roots, but does not
require root API authentication for bundle verification. Offline verification
cannot independently detect whether a repository has since been renamed or its
old name reused; verify repository identity online during procurement.

The root-only `install` action copies the archive, checksum and
attestation bundle into a private root-owned staging directory **before**
verifying the bundle locally without a root GitHub CLI login, then passes
those same copied archive/checksum bytes to the existing `linux-node-release.sh install`
installer, preventing a caller from changing the artifact between checks.
It installs into `/opt/atlas-node/releases` but **never** modifies the
`current`/`previous` symlinks, systemd service, credentials, Atlas Server,
PostgreSQL or workspaces. Continue to use the separate, administrator-reviewed
`linux-node-lifecycle.sh plan/activate/rollback` for activation.

**Note:** GitHub's catalogue currently marks the first PR #46 release
`immutable: false`. It is intentionally ineligible for Atlas's software
catalogue until the repository's immutable-release setting is enabled and a
**new** build is published. This host verifier does not override the
catalogue's immutability requirement.

## Platform lifecycle and planned control-plane updates

- **Linux**: after verifying this published archive, use existing
  `scripts/linux-node-release.sh install` to stage it and
  `scripts/linux-node-lifecycle.sh plan/activate` for health-checked
  activation and rollback. `./atlasctl vps node-upgrade` still uses the
  existing Actions artifact discovery until an audited Atlas-initiated
  lifecycle adapter supersedes it.
- **macOS**: the same portable JS archive can be installed with npm. It is
  **not** a notarized .app/.pkg installer and does not replace the existing
  launchd wrapper. Its Sigstore provenance signs the archive supply chain,
  not a native macOS binary. A safe host-side lifecycle agent and rollback
  still need implementation.
- **Android**: debug APKs are not stable releases. Require a durable signing
  identity, increasing versionCode, compatibility checks and a signed,
  tested APK before including Android in the catalogue.
- **Versions**: Server, desktop Node, Node protocol and Android app are
  independent. The current desktop Node archive targets Node protocol v2.
  An installed runtime reports its version plus the packaged source SHA.

Release discovery and downloads are read-only. Future PRs add Node-targeted,
explicitly authorised update requests, progress/audit, offline handling, a
Linux adapter based on the existing verified lifecycle script, and a separate
macOS safe updater. No dashboard action runs arbitrary shell commands, updates
the Server or modifies PostgreSQL.

## Linux update eligibility preflight (read-only)

Use the per-Node **Check Linux update eligibility** action under Nodes, or the
`plan_node_update` tool with a specific `nodeId`. This is a **read-only
comparison**, not an installation or activation request. No credentials, shell
commands, downloads, service changes, migrations or PostgreSQL writes are
performed.

The plan requires an online, actively enrolled, remote Linux Node. It checks
the server's immutable stable-release catalogue, compares SemVer, and uses the
catalogue's monotonic source order for same-version builds. A missing installed
commit, unknown build or unavailable catalogue produces an explicit unknown or
unavailable state—not a guessed upgrade/downgrade. macOS and Android are not
eligible for this Linux-specific path.

**No plan can authorise installation:** even a valid candidate reports
`canInstall: false`, `canActivate: false`, and
`provenanceVerified: false`. The catalogue only checks GitHub's release
metadata; it does not verify build attestations. The next phase must provide
host-side signed-artifact verification, scoped approval/authorisation,
durable progress/audit and rollback status before Atlas can trigger a Linux
update. Do not equate a read-only update candidate with permission to deploy.

**Bootstrap note:** enabling GitHub immutable releases is a repository
setting, not something the Node catalogue can do. Releases created with
`immutable: false` remain excluded by the catalogue. After enabling the
setting, publish a *new* build through the trusted Node packaging workflow;
the immutable name/tag cannot be overwritten.

## Prepared Linux Node update intentions — durable, non-executable

Atlas now supports `prepare_node_update`, `list_node_update_intents` and
`cancel_node_update_intent`. Selecting an eligible Linux release from the
Node Software card and confirming the action records a **15-minute
non-executable intention** in PostgreSQL; it does **not** grant operator/host
approval or permission to install, activate or restart anything.

The Server refreshes the immutable-release catalogue and re-evaluates Node
version/build ordering before recording. It rechecks the target Node's
persisted active credential, remote Linux platform, and exact expected
installed version/credential update timestamp under a transactional Node row
lock. Only the release identity and SHA-256 digest from Atlas's catalogue
are stored; callers cannot supply archive URLs, paths or shell commands.
At most one unexpired pending request exists for a Node, enforced by a
partial unique index. Expired intentions are cleaned up transactionally
when the next request is prepared. User-visible reads also show expired
requests without changing database state.

Preparation and cancellation append redacted, Node-linked events to the
central `audit_events` stream. Those events identify the **Atlas transport**
rather than claiming to identify the human operator. Since MCP clients may
invoke the same tools, **intent creation is not a privileged approval**.

Nothing subscribes to or executes this ledger. A subsequent host executor
must require a separate host-authorised, single-use approval, verify the
signed release bytes under root ownership, reconcile reconnect/rollback
outcomes durably, and reject expired, cancelled, stale or replayed requests.
In particular, a mere pending intention cannot be consumed as authority to
execute privileged systemd operations. No Node credentials, server deployments,
workspace files or database migrations are changed by preparation itself.


## Host-local Linux approval gate (non-executable)

The separate `scripts/linux-node-update-approval.py` is a Linux-only,
Python 3 standard-library approval ledger. It is **not** a remote update
executor and is not callable through an Atlas Node, MCP, the Web UI or the
Server. Approval does not prove that a release has been signed or downloaded.

From a reviewed checkout, the host administrator may install the helper (this
does **not** deploy an update or install a systemd unit):

```bash
sudo install -D -o root -g root -m 0755 scripts/linux-node-update-approval.py /usr/local/libexec/atlas-node-update-approval
```

Export the exact JSON object returned by `prepare_node_update` into a local
regular file for the administrator to review. **Do not include Node credentials
in this file**. The operator can inspect and consider it from an interactive
root shell:

```bash
sudo /usr/local/libexec/atlas-node-update-approval approve ./intent.json
sudo /usr/local/libexec/atlas-node-update-approval status <intent-uuid>
sudo /usr/local/libexec/atlas-node-update-approval revoke <intent-uuid>
```

The operator must explicitly type `APPROVE <intent-uuid>` for the precise
Node/release/digest displayed. The root-only approval ledger is stored at
`/var/lib/atlas-node-update-approvals` with private permissions, atomic
writes and an exclusive host lock. Approval is bound to the installed release
manifest, the host's Node identity, the full source SHA and target SHA-256;
it expires after **at most five minutes**, never later than the original
15-minute intent expiry. A matching intent cannot be approved twice. Only
one unconsumed non-expired grant is allowed per host Node. Revoked, expired
or claimed grants cannot be reused; the persistent grant records retain
their transition history.

**Critical trust limitation:** The intent JSON is a local snapshot and is
not a signed server receipt. It can become cancelled or stale after it is
exported; the host approval does not verify current server ledger state,
catalogue immutability, or GitHub build provenance. Therefore it never runs
`systemctl`, modifies the active release, stages archives, grants `sudo`
to the Node process, or exposes the internal `claim_once` operation as an
administrator or network command. The next implementation must validate a
live outstanding intent against the trusted Server, verify immutable release
bytes and exact GitHub Sigstore provenance independently, then atomically
claim this approval before any privileged execution. A claimed approval may
**never** be retried; interrupted execution is reconciled through the PR #66
lifecycle journal, not through replay of the grant.

These host approvals are **not** written into the Atlas Server's intent ledger
and must not be represented as remote approval or execution in the Web UI.
Until the separate reconciled host executor is built and tested, requests
continue to show `approved: false` and `executable: false` on Atlas.

## One-shot control-plane claim (host executor prerequisite)

The authenticated native-Node endpoint `POST /node/update-intents/claim`
uses the existing Node-issued Bearer credential and `x-atlas-node-id`
header. **It is disabled by default** (`ATLAS_NODE_UPDATE_CLAIMS_ENABLED=false`); do not enable it on production until the root-owned executor and reconciliation path are separately reviewed and deployed. An API or MCP request cannot enable it. This is **only** a transactional reservation of an existing
`requested` intention, not host approval, an instruction to the Linux Node,
nor a signal that installation has started or succeeded.

A future **root-owned Linux executor** will call this endpoint over the
configured TLS-protected Atlas Server connection, after its independently
reviewed host approval and verified release bytes have been checked.
The JSON body is strictly scoped to:

```json
{
  "intentId": "<intent UUID>",
  "expectedInstalledVersion": "2.0.0+<12-character-source-SHA>",
  "targetSha256": "<64 lowercase hex characters>"
}
```

The Server checks the Node's active credential **inside the same database
transaction** as the claim. It also requires a connected remote Linux Node,
exact installed build and archive digest, a non-expired and uncancelled
request, and no credential rotation since the request was prepared. A row
lock makes concurrent cancellation and claims mutually exclusive. Only the
first valid claim succeeds. Subsequent claims and cancellations fail.
Requests with a `claimed` status still report `approved: false` and
`executable: false`—the Node's credential is **not** a privileged
administrator approval.

The `claimed` state intentionally **blocks further update requests for
that Node** until a future audited completion/reconciliation operation
exists. This is a fail-closed safety fence: a lost HTTP response is
indistinguishable from a committed claim, so callers must inspect the
ledger rather than retrying a potentially consumed one-time request.
Do **not** delete a claimed row, edit its status, or deactivate this
constraint to force another update. The eventual executor must preserve
its own root-owned local records and report a verified outcome; server
claim alone never proves that the host changed releases.

The production and private Node ingress configurations forward this
credential-protected route without human Basic Auth, just like the
existing Node upload endpoints. Browser `Origin` headers are denied,
there is no CORS allowance, credentials are never logged, and the
request is limited to a small exact JSON schema. No scheduler or
remote command is activated by enabling the route.
