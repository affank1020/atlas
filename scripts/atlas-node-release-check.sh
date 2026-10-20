#!/usr/bin/env bash
# Discover and download the last successful Atlas Node package.
# Never installs software or accesses the VPS.
set -euo pipefail
usage() {
  echo 'Usage: atlas-node-release-check.sh [--check|--download DIRECTORY]' >&2
}
mode="${1:---check}"
case "$mode" in
  --check) [[ $# -le 1 ]] || { usage; exit 2; } ;;
  --download) [[ $# -eq 2 ]] || { usage; exit 2; } ;;
  *) usage; exit 2 ;;
esac
for cmd in gh shasum; do
  command -v "$cmd" >/dev/null || { echo "Required command missing: $cmd" >&2; exit 1; }
done
repo='affank1020/atlas'
result="$(gh run list --repo "$repo" --workflow node-package.yml --branch main --status success --limit 1 --json databaseId,headSha --jq '.[0] | [.databaseId, .headSha] | @tsv')"
IFS=$'\t' read -r run_id sha <<< "$result"
[[ "$run_id" =~ ^[0-9]+$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'No successful main-branch Node Package workflow available.' >&2; exit 1;
}
echo "Node package run: $run_id"
echo "Commit: $sha"
echo "Workflow: https://github.com/$repo/actions/runs/$run_id"
[[ "$mode" == --download ]] || exit 0
out="$2"
[[ -n "$out" && "$out" != / ]] || { echo 'Choose a safe output directory.' >&2; exit 2; }
if [[ -e "$out" ]]; then
  [[ -d "$out" && ! -L "$out" ]] || { echo 'Output is not a regular directory.' >&2; exit 2; }
  [[ -z "$(find "$out" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    echo 'Output directory must be empty.' >&2; exit 2;
  }
else
  (umask 077; mkdir -p -- "$out")
fi
gh run download "$run_id" --repo "$repo" --name "atlas-node-$sha" --dir "$out"
files=()
while IFS= read -r file; do files+=("$file"); done < <(find "$out" -maxdepth 1 -type f -name 'atlas-node-v*.tar.gz' -print)
[[ ${#files[@]} == 1 ]] || { echo 'Expected exactly one Node archive.' >&2; exit 1; }
archive="${files[0]}"
base="${archive##*/}"
[[ "$base" =~ ^atlas-node-v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?-([a-f0-9]{12})\.tar\.gz$ ]] || {
  echo 'Unrecognised Node archive name.' >&2; exit 1;
}
[[ "${BASH_REMATCH[2]}" == "${sha:0:12}" ]] || {
  echo 'Archive does not match the successful workflow commit.' >&2; exit 1;
}
checksum="$archive.sha256"
[[ -f "$checksum" && ! -L "$checksum" && ! -L "$archive" ]] || {
  echo 'Missing archive/checksum or unexpected symlink.' >&2; exit 1;
}
[[ "$(wc -l < "$checksum")" == 1 ]] || { echo 'Expected a single checksum line.' >&2; exit 1; }
read -r expected filename < "$checksum"
[[ "$expected" =~ ^[a-f0-9]{64}$ && "$filename" == "$base" ]] || {
  echo 'Invalid checksum manifest.' >&2; exit 1;
}
actual="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
[[ "$expected" == "$actual" ]] || { echo 'SHA-256 checksum mismatch.' >&2; exit 1; }
echo "Verified Node archive: $archive"
echo "SHA-256: $actual"
echo 'No installation or activation was performed.'
