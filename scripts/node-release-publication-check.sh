#!/usr/bin/env bash
# Check whether a packaged Node source commit is superseded by a newer change
# to an input that would itself trigger the Node packaging workflow.
# stdout: "current" or "superseded"; nonzero means cannot safely decide.
set -euo pipefail

[[ "$#" == 3 ]] || { echo "Usage: $0 REPO SOURCE_SHA MAIN_REF" >&2; exit 2; }
repo="$1"
source_sha="$2"
main_ref="$3"
[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected full source SHA." >&2; exit 2; }
git -C "$repo" merge-base --is-ancestor "$source_sha" "$main_ref" ||
  { echo "Source is not an ancestor of current main." >&2; exit 1; }

# The filter must remain identical to the 'push.paths' entries in
# .github/workflows/node-package.yml. A Web-only or docs-only commit cannot
# suppress the release because it won't trigger a replacement build.
changed_paths="$(git -C "$repo" diff --name-only "$source_sha" "$main_ref")"
if grep -Eq '^((apps/node|packages/protocol)/|package(-lock)?\.json$|scripts/(package-node-release\.mjs|node-release-publication-check\.sh|macos-node-(update|stage|lifecycle|operator)\.py|linux-node-host-updater\.py)$|\.github/workflows/node-package\.yml$)' <<< "$changed_paths"; then
  echo superseded
else
  echo current
fi
