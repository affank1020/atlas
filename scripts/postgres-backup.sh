#!/usr/bin/env bash
# Operator-only Linux PostgreSQL snapshot. No unencrypted file is written.
set -euo pipefail
umask 077
mode=''
confirmed=false
out_dir="$HOME/atlas-private-backups"
usage() {
  printf 'Usage: bash scripts/postgres-backup.sh [--dry-run] [--out-dir=/absolute/path] OR --apply --confirm=BACKUP_POSTGRES [--out-dir=/absolute/path]\n'
}
die() { printf 'PostgreSQL backup aborted: %s\n' "$1" >&2; exit 1; }
for arg in "$@"; do
  case "$arg" in
    --dry-run) [[ -z "$mode" ]] || die 'duplicate or conflicting mode'; mode=dry-run ;;
    --apply) [[ -z "$mode" ]] || die 'duplicate or conflicting mode'; mode=apply ;;
    --confirm=BACKUP_POSTGRES) [[ "$confirmed" == false ]] || die 'duplicate confirmation'; confirmed=true ;;
    --out-dir=*) out_dir="$(printf '%s' "$arg" | sed 's/^--out-dir=//')" ;;
    --help) usage; exit 0 ;;
    *) usage >&2; die 'unrecognized option' ;;
  esac
done
[[ -n "$mode" ]] || mode=dry-run
if [[ "$mode" == apply ]]; then
  [[ "$confirmed" == true ]] || die '--apply requires --confirm=BACKUP_POSTGRES'
else
  [[ "$confirmed" == false ]] || die 'confirmation only belongs to --apply'
fi
[[ "$out_dir" == /* && "$out_dir" != / && "$out_dir" != *$'\n'* ]] ||
  die 'output directory must be an absolute non-root path'
[[ -r infra/production.env && -r infra/docker-compose.production.yml ]] ||
  die 'run from the VPS atlas-deploy directory, with private production.env'
command -v docker >/dev/null || die 'docker is missing'
command -v age >/dev/null || die 'age encryption tool is missing'
command -v sha256sum >/dev/null || die 'sha256sum is missing'
recipient="$(printenv ATLAS_PG_BACKUP_RECIPIENT || true)"
[[ "$recipient" == age1* && "$recipient" != *[[:space:]]* ]] ||
  die 'ATLAS_PG_BACKUP_RECIPIENT must be an age X25519 public recipient; keep the identity offline'
# Validate the recipient with the real age parser before claiming dry-run ready.
# The probe encrypts a fixed harmless string to /dev/null and never accesses DB data.
printf 'atlas-public-recipient-check' | age --recipient "$recipient" >/dev/null 2>/dev/null ||
  die 'age rejected the configured public recipient'
[[ ! -L "$out_dir" ]] || die 'backup directory must not be a symlink'
if [[ -e "$out_dir" ]]; then
  [[ -d "$out_dir" && -O "$out_dir" ]] || die 'backup directory must be operator-owned'
  [[ "$(stat -c %a "$out_dir")" == 700 ]] || die 'backup directory must have mode 0700'
elif [[ "$mode" == dry-run ]]; then
  [[ -d "$(dirname "$out_dir")" ]] || die 'output parent directory missing'
fi

# Restrict this operator command to the documented local Compose postgres.
# Fail closed on external hosts, custom ports, URL overrides or other DB users.
# Inspect inside the *running* Server so stale local env cannot select a
# different database. Never print the URL or any credentials.
db="$(docker compose --env-file infra/production.env -f infra/docker-compose.production.yml \
  exec -T server node -e 'try { const raw=process.env.DATABASE_URL; if(!raw) process.exit(2); const u=new URL(raw); if(!["postgres:","postgresql:"].includes(u.protocol) || u.hostname!=="postgres" || (u.port!=="" && u.port!=="5432") || u.username!=="atlas" || u.search || u.hash) process.exit(3); const db=decodeURIComponent(u.pathname.slice(1)); if(!/^[A-Za-z0-9_]+$/.test(db)) process.exit(4); process.stdout.write(db); } catch { process.exit(5); }' 2>/dev/null)" ||
  die 'active Server DATABASE_URL is invalid or does not target the local postgres:5432 service as atlas'
[[ "$db" =~ ^[A-Za-z0-9_]+$ ]] || die 'invalid active database name'
if [[ "$mode" == dry-run ]]; then
  printf 'DRY RUN: active_database=%s; encrypted_destination=%s; recipient_configured=true; no dump created\n' "$db" "$out_dir"
  exit 0
fi

# No filesystem mutations until the active Server endpoint is confirmed.
# Recheck the target after mkdir, including ownership and permissions.
if [[ ! -e "$out_dir" ]]; then
  [[ ! -L "$out_dir" ]] || die 'backup directory must not be a symlink'
  mkdir -m 700 -- "$out_dir" || die 'cannot create private backup directory'
fi
[[ ! -L "$out_dir" && -d "$out_dir" && -O "$out_dir" ]] || die 'unsafe backup directory'
[[ "$(stat -c %a "$out_dir")" == 700 ]] || die 'backup directory permissions changed'
tmp="$(mktemp "$out_dir/.atlas-pg-$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")"
tmp_meta=''
# Capture stderr privately until exit. Never echo raw stderr: PostgreSQL/age
# errors can contain connection strings, SQL text, paths or other secrets.
pg_diagnostics="$(mktemp "$out_dir/.atlas-pg-stderr-XXXXXXXX")"
age_diagnostics="$(mktemp "$out_dir/.atlas-age-stderr-XXXXXXXX")"
cleanup() {
  rm -f -- "$tmp" "$pg_diagnostics" "$age_diagnostics"
  if [[ -n "$tmp_meta" ]]; then rm -f -- "$tmp_meta"; fi
}
trap cleanup EXIT
# Show only fixed, whitelisted diagnostic categories, never operator-
# supplied content. Any other stderr is reported as 'other'.
report_pg_diagnostics() {
  [[ -s "$pg_diagnostics" ]] || return 0
  local kind=diagnostic
  if grep -Eqi '(^|[[:space:]])warning:' "$pg_diagnostics"; then kind=warning; fi
  local category=other
  if grep -Eqi 'permission denied|must be owner|insufficient privilege' "$pg_diagnostics"; then
    category=permissions
  elif grep -Eqi 'lock timeout|lock not available|could not obtain lock' "$pg_diagnostics"; then
    category=lock-contention
  elif grep -Eqi 'connection refused|could not connect|connection failure|connection to server failed|no such file or directory' "$pg_diagnostics"; then
    category=connection
  elif grep -Eqi 'authentication failed|password authentication failed' "$pg_diagnostics"; then
    category=authentication
  fi
  printf 'pg_dump %s reported (category: %s; raw diagnostic suppressed).\n' "$kind" "$category" >&2
}
# pg_dump uses a single consistent PostgreSQL MVCC snapshot; pipefail treats
# errors from either process as failure and never publishes partial output.
if docker compose --env-file infra/production.env -f infra/docker-compose.production.yml \
  exec -T postgres pg_dump -U atlas -d "$db" --format=custom --compress=6 \
    --no-owner --no-acl --lock-wait-timeout=5000 2>"$pg_diagnostics" |
    age --recipient "$recipient" > "$tmp" 2>"$age_diagnostics"; then
  report_pg_diagnostics
  if [[ -s "$age_diagnostics" ]]; then
    printf 'age emitted diagnostic output (content suppressed); review backup before trusting it.\n' >&2
  fi
else
  report_pg_diagnostics
  if [[ -s "$age_diagnostics" ]]; then
    printf 'age failed or reported diagnostics (content suppressed).\n' >&2
  fi
  die 'pg_dump or encryption failed; partial encrypted output removed'
fi
bytes="$(stat -c %s "$tmp")"
[[ "$bytes" -gt 128 ]] || die 'encrypted backup was unexpectedly small'
sha="$(sha256sum < "$tmp" | awk '{print $1}')"
[[ "$sha" =~ ^[a-f0-9]{64}$ ]] || die 'ciphertext checksum could not be computed'
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
unique="$(basename "$tmp" | sed 's/^\.atlas-pg-//')"
final="$out_dir/atlas-$db-$unique.dump.age"
manifest="$final.json"
tmp_meta="$(mktemp "$out_dir/.atlas-meta-XXXXXXXX")"
printf '{"schemaVersion":1,"kind":"postgres-custom-age","database":"%s","createdAt":"%s","bytes":%s,"ciphertextSha256":"%s","verifiedRestore":false}\n' \
  "$db" "$stamp" "$bytes" "$sha" > "$tmp_meta"
# Atomic create-only publishing: never overwrite an earlier backup or manifest.
ln -- "$tmp" "$final" || die 'cannot publish backup without overwrite'
if ! ln -- "$tmp_meta" "$manifest"; then
  rm -f -- "$final"
  die 'could not publish backup manifest'
fi
printf 'Encrypted PostgreSQL snapshot: %s\nCiphertext SHA-256: %s\nBytes: %s\nRestore tested: no\n' "$final" "$sha" "$bytes"
