# Atlas Node release packaging

Atlas Nodes are compiled independently of Atlas Server and Web. The packaging
job `.github/workflows/node-package.yml` runs on relevant changes to main
and can also be dispatched manually.

The job builds `@atlas/protocol` and `@atlas/node`, packages the compiled
code and required npm workspace manifests, and uploads a tarball + SHA-256
checksum as GitHub Actions artifacts (14-day retention). This is a **build
artifact, not an automatic deployment or a GitHub Release**.

On a supported macOS/Linux machine, an operator can inspect and verify a
downloaded archive before installation:

```bash
sha256sum -c atlas-node-v*.tar.gz.sha256
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

Future stages add published releases, compatibility validation, platform
installers, rollback and Node-side update reporting.
