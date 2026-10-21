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
refuses to overwrite an existing tag. Enable GitHub's **immutable releases**
repository setting before treating the channel as production-grade. The
published release has no Server/Web files, credentials or environment config.

Atlas discovers only published **immutable** stable Node bundles from GitHub Releases metadata,
validating archive naming, matching checksum assets, canonical download URLs,
GitHub-provided SHA-256 digests and unique source commits. The catalogue
does **not** import expiring workflow artifacts or debug APKs and does not
install, restart, or re-enrol Nodes.

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
