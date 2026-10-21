#!/usr/bin/env bash
# Legacy archive integrity/format checker and staging primitive.
# This does NOT verify the build signer! Use linux-node-trusted-stage.sh
# for production, which pins the actual GitHub attestation before install.
# Does not start, restart, enrol or replace an active Node service.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage:
  bash scripts/linux-node-release.sh verify <archive.tar.gz> <archive.tar.gz.sha256>
  sudo bash scripts/linux-node-release.sh install <archive.tar.gz> <archive.tar.gz.sha256>
"install" stages a new release under /opt/atlas-node/releases, but never activates it.
Neither command reads Node credentials or changes Atlas Server/Web containers.
HELP
}
[[ $# == 0 ]] && { usage >&2; exit 2; }
case "$1" in -h|--help) usage; exit 0 ;; verify|install) action="$1"; shift ;; *) usage >&2; exit 2;; esac
[[ $# == 2 ]] || { usage >&2; exit 2; }
archive="$1"
checksum="$2"
[[ "$(uname -s)" == Linux ]] || { echo 'Linux VPS required.' >&2; exit 2; }
for cmd in sha256sum tar node npm; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 2; }
done
[[ -f "$archive" && ! -L "$archive" && -f "$checksum" && ! -L "$checksum" ]] ||
  { echo 'Expected regular archive and checksum files.' >&2; exit 2; }
archive="$(realpath "$archive")"
checksum="$(realpath "$checksum")"
[[ "$(basename "$checksum")" == "$(basename "$archive").sha256" ]] ||
  { echo 'Checksum file name does not match archive.' >&2; exit 2; }
[[ "$(basename "$archive")" =~ ^atlas-node-v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?-[0-9a-f]{12}\.tar\.gz$ ]] ||
  { echo 'Unexpected Node release archive name.' >&2; exit 2; }
[[ "$(wc -l < "$checksum")" -eq 1 ]] || { echo 'Expected exactly one checksum.' >&2; exit 2; }
# sha256sum format is "<digest>  <archive_name>"; shell words are separated by whitespace.
read -r expected supplied_name < "$checksum"
[[ "$expected" =~ ^[a-f0-9]{64}$ && "$supplied_name" == "$(basename "$archive")" ]] ||
  { echo 'Invalid Node release checksum.' >&2; exit 2; }
actual="$(sha256sum "$archive" | awk '{print $1}')"
[[ "$actual" == "$expected" ]] || { echo 'Node release SHA-256 mismatch.' >&2; exit 1; }

# Block traversal, absolute paths and symlinks in the verified archive.
listing="$(tar -tzf "$archive")" || { echo 'Cannot read release archive.' >&2; exit 1; }
while IFS= read -r path; do
  [[ "$path" == '.' || "$path" == './' || "$path" == ./* ]] ||
    { echo 'Unexpected archive path.' >&2; exit 1; }
  case "/$path/" in */../*|*/./../*|*//../*) echo 'Archive path traversal denied.' >&2; exit 1 ;; esac
done <<< "$listing"
if tar -tvzf "$archive" | awk '{t=substr($0,1,1); if (t!="-" && t!="d") bad=1} END {exit (bad?0:1)}'; then
  echo 'Archive contains links or non-regular entries.' >&2
  exit 1
fi
for path in package.json package-lock.json atlas-node-release.json apps/node/package.json packages/protocol/package.json; do
  grep -Fxq "./$path" <<< "$listing" ||
    { echo "Missing required Node bundle file: $path" >&2; exit 1; }
done
metadata="$(tar -xOzf "$archive" './atlas-node-release.json')"
node_info="$(node -e '
const r=JSON.parse(process.argv[1]);
if(r.application!=="@atlas/node" || r.protocol!==2 || r.entrypoint!=="apps/node/dist/platforms/desktop/main.js" ||
!(/^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/.test(r.version)) || !(/^[0-9a-f]{40}$/.test(r.commit)))process.exit(1);
console.log(r.version+"-"+r.commit.slice(0,12));
' "$metadata")" || { echo 'Invalid Node release metadata.' >&2; exit 1; }
[[ "$(basename "$archive")" == "atlas-node-v$node_info.tar.gz" ]] ||
  { echo 'Release metadata does not match archive identity.' >&2; exit 1; }
echo "Verified Atlas Node release: $node_info"

if [[ "$action" == verify ]]; then exit 0; fi
[[ "$EUID" == 0 ]] || { echo 'Install requires root; verify does not.' >&2; exit 2; }
[[ -x /usr/bin/node ]] || { echo 'systemd unit expects /usr/bin/node.' >&2; exit 2; }
[[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" -ge 20 ]] ||
  { echo 'Node.js 20+ required by release runtime.' >&2; exit 2; }
release_dir="/opt/atlas-node/releases"
target="$release_dir/v$node_info"
[[ ! -e "$target" && ! -L "$target" ]] || { echo 'Release already installed; refusing overwrite.' >&2; exit 1; }
install -d -m 0755 -o root -g root "$release_dir"
stage="$(mktemp -d "$release_dir/.incoming.XXXXXXXX")"
cleanup() { if [[ -n "$stage" && -d "$stage" ]]; then rm -rf -- "$stage"; fi; }
trap cleanup EXIT
tar -xzf "$archive" -C "$stage" --no-same-owner --no-same-permissions
(cd "$stage" && npm ci --omit=dev --ignore-scripts --workspace @atlas/node --workspace @atlas/protocol --include-workspace-root=false)
chown -R root:root "$stage"
chmod -R u+rwX,go+rX "$stage"
mv -- "$stage" "$target"
stage=""
echo "Installed but NOT activated: $target"
echo 'To activate, review docs/LINUX_NODE.md; preserve the current symlink for rollback.'
