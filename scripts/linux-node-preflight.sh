#!/usr/bin/env bash
# Read-only Linux host readiness check for Atlas Node. Never reads .env files.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: bash scripts/linux-node-preflight.sh [--json|--check|--help]
  --json    Machine-readable host capacity and prerequisites
  --check   Fail if the initial (non-building) Atlas Node has too little capacity
Default    Human-readable diagnostic, no changes to services or files
HELP
}
mode="${1:---report}"
case "$mode" in --report|--json|--check) ;; --help|-h) usage; exit 0;; *) usage >&2; exit 2;; esac
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Atlas Linux Node preflight must run on the Linux VPS.' >&2
  exit 2
fi
if [[ ! -r /proc/meminfo ]]; then
  echo 'Linux /proc/meminfo is unavailable.' >&2
  exit 2
fi

read_mem_kb() { awk -v k="$1:" '$1 == k { print $2; exit }' /proc/meminfo; }
mem_total_kb="$(read_mem_kb MemTotal)"
mem_available_kb="$(read_mem_kb MemAvailable)"
swap_total_kb="$(read_mem_kb SwapTotal)"
swap_free_kb="$(read_mem_kb SwapFree)"
if [[ ! "$mem_total_kb" =~ ^[0-9]+$ || ! "$mem_available_kb" =~ ^[0-9]+$ ||
      ! "$swap_total_kb" =~ ^[0-9]+$ || ! "$swap_free_kb" =~ ^[0-9]+$ ]]; then
  echo 'Failed to read numeric memory counters.' >&2
  exit 2
fi
disk_kb="$(df -Pk / | awk 'NR==2 { print $4 }')"
if [[ ! "$disk_kb" =~ ^[0-9]+$ ]]; then
  echo 'Failed to read available VPS disk space.' >&2
  exit 2
fi
cpus="$(getconf _NPROCESSORS_ONLN)"
if [[ ! "$cpus" =~ ^[0-9]+$ ]]; then cpus=0; fi
node_major=0
node_version="unavailable"
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version 2>/dev/null || true)"
  if [[ "$node_version" =~ ^v([0-9]+)\. ]]; then node_major="${BASH_REMATCH[1]}"; fi
fi
systemd=false
command -v systemctl >/dev/null 2>&1 && systemd=true
git_present=false
command -v git >/dev/null 2>&1 && git_present=true

# Conservative limits for the initial read-only Node, not for code builds.
minimum_memory_kb=$((768 * 1024))
minimum_disk_kb=$((3 * 1024 * 1024))
ready=true
(( mem_available_kb >= minimum_memory_kb )) || ready=false
(( disk_kb >= minimum_disk_kb )) || ready=false
(( node_major >= 20 )) || ready=false
[[ "$systemd" == true && "$git_present" == true ]] || ready=false

if [[ "$mode" == --json ]]; then
  printf '{"ready":%s,"memoryTotalMiB":%d,"memoryAvailableMiB":%d,"swapTotalMiB":%d,"swapFreeMiB":%d,"diskAvailableMiB":%d,"cpus":%d,"nodeMajor":%d,"systemd":%s,"git":%s}\n' \
    "$ready" "$((mem_total_kb / 1024))" "$((mem_available_kb / 1024))" \
    "$((swap_total_kb / 1024))" "$((swap_free_kb / 1024))" "$((disk_kb / 1024))" \
    "$cpus" "$node_major" "$systemd" "$git_present"
else
  printf 'Atlas Linux Node readiness (no changes made)\n'
  printf '  RAM:       %d / %d MiB available\n' "$((mem_available_kb / 1024))" "$((mem_total_kb / 1024))"
  printf '  Swap:      %d / %d MiB free\n' "$((swap_free_kb / 1024))" "$((swap_total_kb / 1024))"
  printf '  Root disk: %d MiB available\n' "$((disk_kb / 1024))"
  printf '  CPUs:      %d\n' "$cpus"
  printf '  Node.js:   %s (requires >=20)\n' "$node_version"
  printf '  systemd:   %s\n  Git:       %s\n' "$systemd" "$git_present"
  printf '  Initial Node prerequisites: %s\n' "$ready"
  if [[ "$ready" != true ]]; then
    echo '  Do not install until insufficient resources or missing prerequisites are resolved.'
  else
    echo '  Initial Node looks viable. Build/test sandbox capacity has NOT been established.'
  fi
fi
if [[ "$mode" == --check && "$ready" != true ]]; then exit 1; fi
