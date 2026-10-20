#!/usr/bin/env bash
# Bootstrap one preapproved public GitHub repository as the unprivileged Node user.
# Never runs repository scripts, reads deployment credentials or modifies /opt/atlas-node.
set -euo pipefail

ROOT='/srv/atlas/workspaces'
SOURCE='https://github.com/affank1020/portfolio-site.git'
APPROVED_BRANCH='main'
EXPECTED_USER='atlas-node'

usage() { echo 'Usage: linux-node-repo-bootstrap.sh clone portfolio-site | status portfolio-site' >&2; }
[[ $# -eq 2 ]] || { usage; exit 2; }
operation="$1"
slug="$2"
[[ "$operation" == clone || "$operation" == status ]] && [[ "$slug" == portfolio-site ]] || { usage; exit 2; }
[[ "$(id -un)" == "$EXPECTED_USER" ]] || { echo "Run as the dedicated $EXPECTED_USER account, not root." >&2; exit 1; }
[[ -d "$ROOT" && ! -L "$ROOT" ]] || { echo 'Approved workspace root is missing or linked.' >&2; exit 1; }
ROOT="$(realpath -e -- "$ROOT")"
[[ "$ROOT" == /srv/atlas/workspaces ]] || { echo 'Unexpected workspace root.' >&2; exit 1; }
[[ -O "$ROOT" && -w "$ROOT" ]] || { echo 'Workspace root must belong to the Node user.' >&2; exit 1; }
target="$ROOT/$slug"
if [[ "$operation" == status ]]; then
  [[ -d "$target/.git" && ! -L "$target" && ! -L "$target/.git" ]] || { echo 'No managed checkout exists.' >&2; exit 1; }
  [[ "$(realpath -e -- "$target")" == "$target" ]] || { echo 'Checkout path changed.' >&2; exit 1; }
  env -i PATH=/usr/bin:/bin HOME=/var/empty GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 /usr/bin/git -C "$target" -c core.hooksPath=/dev/null \
    status --short --branch
  exit 0
fi
[[ ! -e "$target" && ! -L "$target" ]] || { echo 'Destination exists; refusing to replace it.' >&2; exit 1; }
command -v /usr/bin/git >/dev/null || { echo 'Git is unavailable.' >&2; exit 1; }
# A private staging directory avoids exposing a partially cloned checkout.
umask 077
stage="$(mktemp -d "$ROOT/.atlas-clone.XXXXXXXX")"
cleanup() {
  if [[ -n "$stage" && "$stage" == "$ROOT"/.atlas-clone.* && -d "$stage" && ! -L "$stage" ]]; then
    rm -rf -- "$stage"
  fi
}
trap cleanup EXIT
safe_git() {
  env -i PATH=/usr/bin:/bin HOME=/var/empty GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1 \
    /usr/bin/git -c protocol.file.allow=never -c core.hooksPath=/dev/null \
    -c submodule.recurse=false -c filter.lfs.smudge= -c filter.lfs.required=false "$@"
}
safe_git clone --no-checkout --single-branch --depth 1 --branch "$APPROVED_BRANCH" \
  -- "$SOURCE" "$stage/repo"
[[ "$(safe_git -C "$stage/repo" remote get-url origin)" == "$SOURCE" ]] || {
  echo 'Unexpected Git remote after clone.' >&2; exit 1;
}
# No checkout of Git links or submodule worktrees: all source must remain local.
if safe_git -C "$stage/repo" ls-tree -r HEAD | grep -Eq '^(120000 blob|160000 commit) '; then
  echo 'Repository contains a symlink or submodule; refusing automatic checkout.' >&2
  exit 1
fi
safe_git -C "$stage/repo" checkout --detach --force
safe_git -C "$stage/repo" switch -c 'atlas/bootstrap' || { echo 'Cannot create isolated branch.' >&2; exit 1; }
[[ ! -e "$target" && ! -L "$target" ]] || { echo 'Destination appeared during clone; refusing overwrite.' >&2; exit 1; }
# Move only a completed isolated checkout into the Node workspace root.
mv -T -- "$stage/repo" "$target"
echo "Checkout prepared: $target"
echo 'Branch: atlas/bootstrap (independent of main)'
echo 'Next: register this directory as a new Atlas Workspace on the VPS Linux Node.'
