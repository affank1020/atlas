#!/usr/bin/env bash
# Verify the provenance of a portable Atlas Node archive before trusted staging.
# This is NOT an update trigger: no command in this script restarts a service,
# changes "current"/"previous", accesses Node credentials, or accepts a URL.
set -euo pipefail

usage() {
  echo "Usage: bash scripts/linux-node-trusted-stage.sh verify|install <archive.tar.gz> <archive.tar.gz.sha256>" >&2
}
die() { echo "Atlas Node trusted staging: $*" >&2; exit 1; }
[[ $# -eq 3 ]] || { usage; exit 2; }
action="$1"
[[ "$action" == verify || "$action" == install ]] || { usage; exit 2; }
[[ "$(uname -s)" == Linux ]] || die "Linux is required."
script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
archive_input="$2"
checksum_input="$3"
[[ -f "$archive_input" && ! -L "$archive_input" && -f "$checksum_input" && ! -L "$checksum_input" ]] ||
  die "Archive and checksum must be regular files, not symlinks."
archive_input="$(realpath -e -- "$archive_input")" || die "Archive missing."
checksum_input="$(realpath -e -- "$checksum_input")" || die "Checksum missing."
archive_name="$(basename -- "$archive_input")"
[[ "$archive_name" =~ ^atlas-node-v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}\.tar\.gz$ ]] ||
  die "Stable Atlas Node archive name is required."
[[ "$(basename -- "$checksum_input")" == "$archive_name.sha256" ]] ||
  die "Checksum filename does not match the archive."

command -v gh >/dev/null || die "GitHub CLI is required for provenance verification."
gh_version="$(gh --version)" || die "Unable to determine GitHub CLI version."
[[ "$gh_version" =~ ^gh[[:space:]]version[[:space:]]([0-9]+)\.([0-9]+)\.([0-9]+) ]] ||
  die "Unexpected GitHub CLI version output."
major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"
if (( major < 2 || (major == 2 && minor < 102) )); then
  die "GitHub CLI 2.102.0+ is required to reject known attestation identity bypasses."
fi

# Verify both the checksum and the actual release manifest before asking
# Sigstore to verify the archive. A SHA-256 sidecar alone is not authenticity.
verify_archive() {
  local archive="$1" checksum="$2" source_sha
  bash "$script_dir/linux-node-release.sh" verify "$archive" "$checksum" ||
    die "Archive content or checksum verification failed."
  source_sha="$(tar -xOzf "$archive" ./atlas-node-release.json | node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      body += chunk;
      if (body.length > 16384) process.exit(1);
    });
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (!/^[a-f0-9]{40}$/.test(data.commit)) process.exit(1);
        process.stdout.write(data.commit);
      } catch { process.exit(1); }
    });
  ')" || die "Unable to read source commit from signed archive."
  [[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || die "Invalid source SHA."
  # Pin the source identity to the expected repository, main branch, exact
  # build workflow AND immutable source commit. A valid digest is insufficient.
  GH_HOST=github.com gh attestation verify "$archive" \
    --repo affank1020/atlas \
    --cert-identity 'https://github.com/affank1020/atlas/.github/workflows/node-package.yml@refs/heads/main' \
    --source-ref refs/heads/main \
    --source-digest "$source_sha" \
    --predicate-type https://slsa.dev/provenance/v1 >/dev/null ||
    die "Build-provenance verification failed. Release was not installed."
  echo "Verified GitHub build provenance for source $source_sha."
}

if [[ "$action" == verify ]]; then
  verify_archive "$archive_input" "$checksum_input"
  exit 0
fi

[[ "$EUID" -eq 0 ]] || die "Install requires root. Run verify without sudo first."
# Root owns the staging directory, eliminating a time-of-check/time-of-use
# swap between attestation verification and the existing installer. Only
# these copied files, not the caller's originals, reach the root installer.
root=/opt/atlas-node
[[ ! -L "$root" ]] || die "Refusing symlinked Atlas Node root."
if [[ -d "$root" ]]; then
  [[ "$(stat -c '%u' -- "$root")" == 0 ]] || die "Release root is not owned by root."
  mode="$(stat -c '%a' -- "$root")" || die "Cannot inspect release root."
  (( (8#$mode & 8#022) == 0 )) || die "Release root is writable by group or others."
else
  install -d -o root -g root -m 0755 "$root"
fi
stage="$(mktemp -d "$root/.signed-stage.XXXXXXXX")" || die "Cannot create root-owned staging."
cleanup() { if [[ -n "$stage" && -d "$stage" ]]; then rm -rf -- "$stage"; fi; }
trap cleanup EXIT
chmod 0700 -- "$stage"
install -m 0600 -- "$archive_input" "$stage/$archive_name"
install -m 0600 -- "$checksum_input" "$stage/$archive_name.sha256"
verify_archive "$stage/$archive_name" "$stage/$archive_name.sha256"
bash "$script_dir/linux-node-release.sh" install "$stage/$archive_name" "$stage/$archive_name.sha256" ||
  die "Release installation failed; the running Node was not changed."
echo "Trusted release staged. Activation requires a separate explicitly authorised lifecycle operation."
