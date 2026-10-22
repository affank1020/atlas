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
  echo "Usage: atlas-node-lifecycle status | plan <version> | activate <version> [--expect-current <version>] | rollback | recover"
  echo "Version example: v2.0.0-78840cd92a90 (must already be installed and verified)."
}
die() { echo "Atlas Node lifecycle: $*" >&2; exit 1; }
[[ "$ROOT" == /* && "$ROOT" != / ]] || die "Invalid release root."
# Compare against the canonical filesystem path, not the environment string.
# Otherwise /opt/atlas-node/, /opt/atlas-node/., or a symlink alias could
# access the production tree while skipping root ownership and watchdog gates.
command -v realpath >/dev/null || die "realpath is required."
canonical_root="$(realpath -m -- "$ROOT")" || die "Cannot resolve release root."
[[ "$ROOT" == "$canonical_root" ]] ||
  die "Release root must be a canonical absolute path (no trailing slash, traversal or aliases)."
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] && (( TIMEOUT >= 1 && TIMEOUT <= 120 )) || die "Timeout must be 1-120 seconds."
action="${1:-}"
case "$action" in
  status|rollback|recover) [[ $# -eq 1 ]] || { usage >&2; exit 2; } ;;
  plan) [[ $# -eq 2 ]] || { usage >&2; exit 2; } ;;
  activate)
    [[ $# -eq 2 || ( $# -eq 4 && "$3" == --expect-current ) ]] ||
      { usage >&2; exit 2; }
    if [[ $# -eq 4 ]]; then
      [[ "$4" =~ ^v[0-9]+[.][0-9]+[.][0-9]+(-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$ ]] ||
        die "Invalid expected current release name."
    fi
    ;;
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
# A root-owned, persistent marker is written and synced BEFORE touching current.
# A separate systemd timer runs 'recover' after a killed or interrupted updater.
# The journal contains release directory names and a fixed action, never secrets or commands.
PENDING_FILE="$ROOT/.activation-pending"
valid_name() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$ ]]
}
write_pending() {
  local temp
  [[ ! -e "$PENDING_FILE" && ! -L "$PENDING_FILE" ]] || return 1
  temp="$(mktemp "$ROOT/.activation-pending.XXXXXXXX")" || return 1
  if ! printf '%s\n%s\n%s\n' "${1##*/}" "${2##*/}" "$3" > "$temp" ||
     ! chmod 0600 -- "$temp" ||
     ! mv -Tf -- "$temp" "$PENDING_FILE" ||
     ! sync -f "$ROOT"; then
    rm -f -- "$temp"
    return 1
  fi
}
read_pending() {
  [[ -f "$PENDING_FILE" && ! -L "$PENDING_FILE" ]] || return 1
  if [[ "$ROOT" == /opt/atlas-node ]]; then
    [[ "$(stat -c '%u' -- "$PENDING_FILE")" == 0 ]] || return 1
    local mode
    mode="$(stat -c '%a' -- "$PENDING_FILE")" || return 1
    (( (8#$mode & 8#077) == 0 )) || return 1
  fi
  mapfile -t pending < "$PENDING_FILE" || return 1
  [[ "${#pending[@]}" -eq 3 ]] && valid_name "${pending[0]}" &&
    valid_name "${pending[1]}" && [[ "${pending[0]}" != "${pending[1]}" ]] &&
    [[ "${pending[2]}" == activate || "${pending[2]}" == rollback ]]
}
clear_pending() {
  rm -- "$PENDING_FILE" && sync -f "$ROOT"
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
  if [[ -e "$PENDING_FILE" || -L "$PENDING_FILE" ]]; then echo "  Recovery: pending"; fi
  if healthy; then echo "  WebSocket: connected (live PID verified)"
  else echo "  WebSocket: not confirmed"; fi
}
if [[ "$action" == status ]]; then show_status; exit 0; fi
if [[ "$action" == plan ]]; then
  old="$(current)" || die "No valid current symlink."
  valid_name "$2" || die "Invalid version."
  candidate="$ROOT/releases/$2"
  valid_release "$candidate" || die "Target is not a verified, installed Node release."
  echo "Current: $old"
  echo "Target:  $candidate"
  echo "Operation would restart only $SERVICE after switching the current symlink."
  echo "An independent recovery timer must restore an interrupted activation."
  exit 0
fi

if [[ "$ROOT" == /opt/atlas-node && "$EUID" -ne 0 ]]; then
  die "Activation and recovery require sudo."
fi
if [[ "$ROOT" == /opt/atlas-node ]]; then
  [[ ! -L "$ROOT" && "$(stat -c '%u' -- "$ROOT")" == 0 ]] ||
    die "Release root must be a root-owned directory, not a symlink."
  root_mode="$(stat -c '%a' -- "$ROOT")" || die "Cannot inspect release root."
  (( (8#$root_mode & 8#022) == 0 )) || die "Release root must not be writable by non-root."
fi
command -v flock >/dev/null || die "flock is required."
exec 9>"$LOCK_FILE" || die "Cannot open lifecycle lock."
flock -n 9 || { [[ "$action" == recover ]] && exit 0; die "Another Node lifecycle operation is already running."; }

if [[ "$action" == recover ]]; then
  [[ -e "$PENDING_FILE" || -L "$PENDING_FILE" ]] || exit 0
  read_pending || die "Invalid pending activation journal; manual intervention required."
  original="$ROOT/releases/${pending[0]}"
  attempted="$ROOT/releases/${pending[1]}"
  valid_release "$original" && valid_release "$attempted" ||
    die "Pending activation references an invalid release; refusing recovery."
  observed="$(current)" || die "Invalid current release; manual intervention required."
  [[ "$observed" == "$original" || "$observed" == "$attempted" ]] ||
    die "Current release differs from pending activation; refusing recovery."
  # An interrupted upgrade must revert to the original version; an
  # interrupted explicit rollback must FINISH the rollback instead of
  # reintroducing the version the operator chose to roll back.
  desired="$original"
  if [[ "${pending[2]}" == rollback ]]; then desired="$attempted"; fi
  if [[ "$observed" != "$desired" ]]; then
    echo "Recovering interrupted ${pending[2]}: switching to ${desired##*/}."
    atomic_link "$desired" current || die "Could not restore desired release."
  fi
  # A healthy PID may still be executing a different version. Always
  # restart to prove the desired release is actually running.
  systemctl restart "$SERVICE" && wait_healthy ||
    die "Desired release is not connected; recovery will retry."
  if [[ "${pending[2]}" == rollback ]]; then
    # Complete the same previous-pointer update as a normal explicit rollback.
    atomic_link "$original" previous ||
      die "Rollback connected, but previous release pointer was not committed."
  fi
  clear_pending || die "Could not clear pending activation marker."
  echo "Recovery completed; desired Node connection confirmed."
  exit 0
fi

[[ ! -e "$PENDING_FILE" && ! -L "$PENDING_FILE" ]] ||
  die "Pending activation must be recovered before another lifecycle operation."
[[ -f /etc/atlas-node/node.env || "$ROOT" != /opt/atlas-node ]] ||
  die "Node credential config missing; refusing activation."
if [[ "$ROOT" == /opt/atlas-node ]]; then
  systemctl is-enabled --quiet atlas-node-lifecycle-recover.timer &&
    systemctl is-active --quiet atlas-node-lifecycle-recover.timer ||
    die "Recovery timer must be installed, enabled and running before activation."
fi
old="$(current)" || die "No valid current symlink: refusing activation."
# The optional source guard is evaluated INSIDE the existing lifecycle flock.
# It is used by the root-only update executor after its Server claim: a
# concurrent manual activate/rollback using this same lifecycle must never
# replace the source release after the administrator approved that exact build.
if [[ "$action" == activate && $# -eq 4 ]]; then
  [[ "$old" == "$ROOT/releases/$4" ]] ||
    die "Current release no longer matches the host-approved starting release."
fi
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
write_pending "$old" "$target" "$action" || die "Could not write durable pending activation; no release changed."
atomic_link "$target" current || die "Could not switch current release."
if systemctl restart "$SERVICE" && wait_healthy; then
  atomic_link "$old" previous || die "Node connected, but recording rollback release failed."
  clear_pending || die "Node connected, but activation journal could not be cleared."
  echo "Node update succeeded; WebSocket registration confirmed."
  show_status
  exit 0
fi
if [[ "$action" == rollback ]]; then
  # An explicit rollback must never silently re-activate the rejected version.
  # Leave the intended rollback target and journal for the host watchdog.
  echo "Rollback target did not reconnect; host recovery will retry the chosen release." >&2
  exit 1
fi
echo "New Node did not connect within ${TIMEOUT}s; restoring previous release." >&2
atomic_link "$old" current || die "URGENT: automatic rollback symlink failed."
if systemctl restart "$SERVICE" && wait_healthy; then
  clear_pending || die "Rollback connected, but activation journal could not be cleared."
  echo "Rollback completed; previous Node reconnected." >&2
else
  echo "URGENT: previous Node did not reconnect; inspect systemctl and journalctl." >&2
fi
exit 1
