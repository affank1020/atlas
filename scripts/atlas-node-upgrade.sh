#!/usr/bin/env bash
# One-command, operator-initiated Linux Node upgrade from a verified main build.
# Never edits Node identity/secrets or restarts Atlas Server/PostgreSQL.
set -euo pipefail

die() { echo "Atlas Node upgrade: $*" >&2; exit 1; }
[[ $# -eq 0 ]] || die "Usage: ./atlasctl vps node-upgrade"
root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
host="${ATLAS_VPS_SSH_HOST:-ovh}"
[[ "$host" =~ ^[a-zA-Z0-9_][a-zA-Z0-9._@-]*$ ]] || die "Invalid ATLAS_VPS_SSH_HOST."
for command in gh ssh scp shasum mktemp; do
  command -v "$command" >/dev/null 2>&1 || die "Missing $command."
done
[[ -f "$root/scripts/atlas-node-release-check.sh" &&
   -f "$root/scripts/linux-node-release.sh" ]] || die "Missing verified release tools."

scratch="$(mktemp -d "${TMPDIR:-/tmp}/atlas-node-upgrade.XXXXXXXX")"
remote_dir=""
cleanup() {
  if [[ -n "$remote_dir" ]]; then
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$host" \
      "rm -rf -- '$remote_dir'" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT

# Reuse main-branch workflow selection, tarball provenance and SHA-256 verification.
bash "$root/scripts/atlas-node-release-check.sh" --download "$scratch"
shopt -s nullglob
archives=("$scratch"/atlas-node-v*.tar.gz)
[[ ${#archives[@]} -eq 1 ]] || die "Expected one verified Node release archive."
archive="${archives[0]}"
file="${archive##*/}"
[[ "$file" =~ ^atlas-node-(v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?-[a-f0-9]{12})\.tar\.gz$ ]] ||
  die "Invalid Node release filename."
release="${BASH_REMATCH[1]}"
[[ -f "$archive.sha256" ]] || die "Missing archive checksum."

cat > "$scratch/apply.sh" <<'REMOTE'
#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 && "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$ ]] ||
  { echo "Invalid Node release." >&2; exit 2; }
release="$1"
archive="atlas-node-$release.tar.gz"
cd "$(dirname -- "${BASH_SOURCE[0]}")"
sha256sum -c "$archive.sha256"
# Only the Linux Node service will restart. sudo prompts once over the SSH TTY.
# The root-owned libexec implementation is the SAME one invoked by the
# independent crash-recovery systemd timer. Never call an old PATH executable.
lifecycle=/usr/local/libexec/atlas-node-lifecycle.sh
sudo -v
sudo -n test -x "$lifecycle" ||
  { echo "Recovery-aware Node lifecycle not installed. Provision watchdog first." >&2; exit 1; }
# Refuse to stage/activate before the required watchdog is installed and live.
sudo -n systemctl is-enabled --quiet atlas-node-lifecycle-recover.timer &&
  sudo -n systemctl is-active --quiet atlas-node-lifecycle-recover.timer ||
  { echo "Node recovery watchdog is not enabled and active." >&2; exit 1; }
if ! sudo -n test -d "/opt/atlas-node/releases/$release"; then
  sudo -n bash ./linux-node-release.sh verify "$archive" "$archive.sha256"
  sudo -n bash ./linux-node-release.sh install "$archive" "$archive.sha256"
fi
sudo -n "$lifecycle" plan "$release"
sudo -n "$lifecycle" activate "$release"
sudo -n "$lifecycle" status
REMOTE

echo "Target Linux Node: $release"
remote_dir="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$host" \
  'umask 077; mktemp -d "$HOME/.atlas-node-upgrade.XXXXXXXX"')" ||
  die "Could not create private VPS staging directory."
[[ "$remote_dir" =~ ^/[a-zA-Z0-9_./-]+/\.atlas-node-upgrade\.[a-zA-Z0-9]+$ &&
   "$remote_dir" != *".."* ]] || {
    remote_dir=""
    die "Unexpected VPS staging path."
  }

scp -o BatchMode=yes -o StrictHostKeyChecking=yes \
  "$archive" "$archive.sha256" "$root/scripts/linux-node-release.sh" \
  "$scratch/apply.sh" "$host:$remote_dir/" || die "VPS release transfer failed."

# The SSH connection gets a TTY only for sudo. The lifecycle script already
# implements verified activation and automatic rollback on failed registration.
ssh -tt -o BatchMode=yes -o StrictHostKeyChecking=yes "$host" \
  "cd '$remote_dir' && bash ./apply.sh '$release'" ||
  die "VPS upgrade failed. Check lifecycle status/rollback before retrying."

echo "Linux Node upgraded and WebSocket connection verified: $release"
