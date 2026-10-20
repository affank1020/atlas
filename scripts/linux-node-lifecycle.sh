#!/usr/bin/env bash
# Activate or roll back an already verified Atlas Linux Node release.
# Only atlas-node.service is restarted. Server, PostgreSQL and credentials
# are never modified. A Node must confirm its live WebSocket registration.
set -euo pipefail

ROOT="${ATLAS_LIFECYCLE_ROOT:-/opt/atlas-node}"
SERVICE="atlas-node"
STATUS_FILE="${ATLAS_LIFECYCLE_STATUS_FILE:-/var/lib/atlas-node/.local/state/atlas/node-status.json}"
LOCK_FILE="${ATLAS_LIFECYCLE_LOCK_FILE:-/run/lock/atlas-node-lifecycle.lock}"
TIMEOUT="${ATLAS_LIFECYCLE_TIMEOUT:-45}"

usage() {
  echo "Usage: atlas-node-lifecycle status | plan <version> | activate <version> | rollback"
  echo "Version example: v2.0.0-78840cd92a90 (must already be installed and verified)."
}
die() { echo "Atlas Node lifecycle: $*" >&2; exit 1; }
[[ "$ROOT" == /* && "$ROOT" != / && "$ROOT" != */../* ]] || die "Invalid release root."
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] && (( TIMEOUT >= 1 && TIMEOUT <= 120 )) || die "Timeout must be 1-120 seconds."
action="${1:-}"
case "$action" in
  status|rollback) [[ $# -eq 1 ]] || { usage >&2; exit 2; } ;;
  plan|activate) [[ $# -eq 2 ]] || { usage >&2; exit 2; } ;;
  *) usage >&2; exit 2 ;;
esac

# A release must be a root-owned, immutable package in the approved tree.
# Reject malformed versions and targets outside /opt/atlas-node/releases.
valid_release() {
  local path="$1" target name dir
  target="$(realpath -e -- "$path" 2>/dev/null)" || return 1
  dir="$(realpath -e -- "$ROOT/releases" 2>/dev/null)" || return 1
  [[ "$target" == "$dir/"* ]] || return 1
  name="${target##*/}"
  [[ "$name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$ ]] || return 1
  [[ "$target" == "$dir/$name" && -f "$target/atlas-node-release.json" &&
      -f "$target/apps/node/dist/platforms/desktop/main.js" &&
      -f "$target/node_modules/ws/package.json" ]] || return 1
  # Production release directories and metadata must not be mutable by the
  # unprivileged Node process; otherwise an update would execute untrusted JS.
  if [[ "$ROOT" == /opt/atlas-node ]]; then
    local item
    for item in "$dir" "$target" "$target/atlas-node-release.json" "$target/apps/node/dist/platforms/desktop/main.js"; do
      [[ "$(stat -c '%u' -- "$item")" == 0 ]] || return 1
      local mode
      mode="$(stat -c '%a' -- "$item")" || return 1
      (( (8#$mode & 8#022) == 0 )) || return 1
    done
  fi
  # Validate metadata and exact directory name; no credential is inspected.
  node - "$target/atlas-node-release.json" "$name" <<'NODE'
const fs = require('node:fs');
try {
  const info = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const expected = 'v' + info.version + '-' + info.commit.slice(0, 12);
  if (info.application !== '@atlas/node' || info.protocol !== 2 ||
      !/^[0-9a-f]{40}$/.test(info.commit) || expected !== process.argv[3] ||
      info.entrypoint !== 'apps/node/dist/platforms/desktop/main.js') process.exit(1);
} catch { process.exit(1); }
NODE
}
current() {
  [[ -L "$ROOT/current" ]] || return 1
  local p
  p="$(realpath -e -- "$ROOT/current" 2>/dev/null)" || return 1
  valid_release "$p" || return 1
  printf '%s\n' "$p"
}
previous() {
  [[ -L "$ROOT/previous" ]] || return 1
  local p
  p="$(realpath -e -- "$ROOT/previous" 2>/dev/null)" || return 1
  valid_release "$p" || return 1
  printf '%s\n' "$p"
}
healthy() {
  systemctl is-active --quiet "$SERVICE" || return 1
  local pid
  pid="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -f "$STATUS_FILE" ]] || return 1
  node - "$STATUS_FILE" "$pid" <<'NODE'
const fs = require('node:fs');
try {
  const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (data.state !== 'connected' || data.pid !== Number(process.argv[3])) process.exit(1);
} catch { process.exit(1); }
NODE
}
wait_healthy() {
  local i
  for ((i=0; i<TIMEOUT; i++)); do
    if healthy; then return 0; fi
    sleep 1
  done
  return 1
}
atomic_link() {
  local new="$1" name="$2" next
  next="$ROOT/.$name.next.$$"
  ln -s -- "$new" "$next" || return 1
  if ! mv -Tf -- "$next" "$ROOT/$name"; then rm -f -- "$next"; return 1; fi
}
show_status() {
  echo "Atlas Linux Node lifecycle"
  echo "  Current:  $(current 2>/dev/null || echo 'missing or invalid')"
  echo "  Previous: $(previous 2>/dev/null || echo 'not recorded')"
  echo "  Service:  $(systemctl is-active "$SERVICE" 2>/dev/null || echo 'unavailable')"
  if healthy; then echo "  WebSocket: connected (live PID verified)"
  else echo "  WebSocket: not confirmed"; fi
}
if [[ "$action" == status ]]; then show_status; exit 0; fi
old="$(current)" || die "No valid current symlink: refusing to mutate an uninitialised service."
if [[ "$action" == plan ]]; then
  [[ "$2" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$ ]] || die "Invalid version."
  candidate="$ROOT/releases/$2"
  valid_release "$candidate" || die "Target is not a verified, installed Node release."
  echo "Current: $old"
  echo "Target:  $candidate"
  echo "Operation would restart only $SERVICE after switching the current symlink."
  echo "It will verify WebSocket connection and automatically restore the previous version on failure."
  exit 0
fi

if [[ "$ROOT" == /opt/atlas-node && "$EUID" -ne 0 ]]; then
  die "Activation and rollback require sudo."
fi
command -v flock >/dev/null || die "flock is required."
exec 9>"$LOCK_FILE" || die "Cannot open lifecycle lock."
flock -n 9 || die "Another Node lifecycle operation is already running."
[[ -f /etc/atlas-node/node.env || "$ROOT" != /opt/atlas-node ]] || die "Node credential config missing; refusing activation."
if [[ "$action" == rollback ]]; then
  target="$(previous)" || die "No valid previous release recorded."
else
  [[ "$2" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$ ]] || die "Invalid version."
  target="$ROOT/releases/$2"
  valid_release "$target" || die "Target release missing or malformed."
fi
[[ "$target" != "$old" ]] || { echo "Already running requested release."; exit 0; }
systemctl is-active --quiet "$SERVICE" || die "Service is not active; manual recovery required."
# Do not silently install dependencies or mutate the versioned target.
(cd "$target" && npm ls --omit=dev --depth=0 >/dev/null) || die "Target dependency tree is incomplete."
echo "Switching $SERVICE: ${old##*/} -> ${target##*/}"
atomic_link "$target" current || die "Could not switch current release."
if systemctl restart "$SERVICE" && wait_healthy; then
  atomic_link "$old" previous || die "Node connected, but recording rollback release failed."
  echo "Node update succeeded; WebSocket registration confirmed."
  show_status
  exit 0
fi
echo "New Node did not connect within ${TIMEOUT}s; restoring previous release." >&2
atomic_link "$old" current || die "URGENT: automatic rollback symlink failed."
if systemctl restart "$SERVICE" && wait_healthy; then
  echo "Rollback completed; previous Node reconnected." >&2
else
  echo "URGENT: previous Node did not reconnect; inspect systemctl and journalctl." >&2
fi
exit 1
