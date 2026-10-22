#!/usr/bin/env bash
# Operator-only restore drill. No mounts, published ports or production DB writes.
set -euo pipefail
umask 077
mode=''
confirmed=false
archive=''
identity=''
usage() {
  printf 'Usage: bash scripts/postgres-restore-drill.sh --archive=/absolute/file.dump.age [--dry-run] OR --archive=/absolute/file.dump.age --identity=/absolute/age-identity --apply --confirm=ISOLATED_PG_RESTORE\n'
}
die() { printf 'Isolated PostgreSQL restore drill aborted: %s\n' "$1" >&2; exit 1; }
for arg in "$@"; do
  case "$arg" in
    --dry-run) [[ -z "$mode" ]] || die 'duplicate or conflicting mode'; mode=dry-run ;;
    --apply) [[ -z "$mode" ]] || die 'duplicate or conflicting mode'; mode=apply ;;
    --confirm=ISOLATED_PG_RESTORE) [[ "$confirmed" == false ]] || die 'duplicate confirmation'; confirmed=true ;;
    --archive=*) [[ -z "$archive" ]] || die 'duplicate archive'; archive="$(printf '%s' "$arg" | sed 's/^--archive=//')" ;;
    --identity=*) [[ -z "$identity" ]] || die 'duplicate identity'; identity="$(printf '%s' "$arg" | sed 's/^--identity=//')" ;;
    --help) usage; exit 0 ;;
    *) usage >&2; die 'unrecognised argument' ;;
  esac
done
[[ -n "$mode" ]] || mode=dry-run
[[ "$archive" == /* && "$archive" == *.dump.age && "$archive" != *$'\n'* ]] ||
  die 'archive must be an absolute .dump.age path'
[[ -f "$archive" && ! -L "$archive" && -O "$archive" ]] ||
  die 'archive must be a regular operator-owned file, not a symlink'
manifest="$archive.json"
[[ -f "$manifest" && ! -L "$manifest" && -O "$manifest" ]] ||
  die 'matching private manifest not found or unsafe'
for file in "$archive" "$manifest"; do
  permissions="$(stat -c %a -- "$file")" || die 'cannot inspect private file'
  [[ "$permissions" =~ ^[0-7]{3,4}$ ]] || die 'invalid file mode'
  (( (8#$permissions & 0177) == 0 )) || die 'archive and manifest must be readable only by owner'
done
command -v node >/dev/null || die 'Node.js 20+ is required for strict manifest inspection'
command -v sha256sum >/dev/null || die 'sha256sum is required'
metadata="$(node - "$manifest" <<'NODE'
const fs = require('node:fs');
const filename = process.argv[2];
try {
  if (fs.statSync(filename).size > 4096) process.exit(3);
  const m = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (m.schemaVersion !== 1 || m.kind !== 'postgres-custom-age' ||
      typeof m.database !== 'string' || !/^[A-Za-z0-9_]+$/.test(m.database) ||
      typeof m.bytes !== 'number' || !Number.isSafeInteger(m.bytes) || m.bytes < 128 ||
      !/^[a-f0-9]{64}$/.test(m.ciphertextSha256) || m.verifiedRestore !== false ||
      typeof m.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.createdAt)) process.exit(4);
  process.stdout.write([m.bytes,m.ciphertextSha256,m.database].join('\t'));
} catch { process.exit(5); }
NODE
)" || die 'manifest is malformed or violates the approved schema'
IFS=$'\t' read -r expected_bytes expected_sha database <<< "$metadata"
actual_bytes="$(stat -c %s -- "$archive")" || die 'cannot measure ciphertext'
[[ "$actual_bytes" == "$expected_bytes" ]] || die 'ciphertext size does not match manifest'
actual_sha="$(sha256sum -- "$archive" | awk '{print $1}')" || die 'cannot checksum ciphertext'
[[ "$actual_sha" == "$expected_sha" ]] || die 'ciphertext SHA-256 does not match manifest'

if [[ "$mode" == dry-run ]]; then
  [[ "$confirmed" == false && -z "$identity" ]] || die 'identity and apply confirmation are not used in dry-run'
  printf 'DRY RUN PASSED: ciphertext_sha256=%s; encrypted_bytes=%s; database=%s; docker_not_invoked=true; restore_verified=false\n' \
    "$actual_sha" "$actual_bytes" "$database"
  exit 0
fi
[[ "$confirmed" == true ]] || die '--apply requires --confirm=ISOLATED_PG_RESTORE'
[[ "$identity" == /* && "$identity" != *$'\n'* ]] || die 'private identity path must be absolute'
[[ -f "$identity" && ! -L "$identity" && -O "$identity" ]] || die 'private identity must be a regular operator-owned file'
permissions="$(stat -c %a -- "$identity")"
[[ "$permissions" =~ ^[0-7]{3,4}$ ]] || die 'invalid identity file mode'
(( (8#$permissions & 0177) == 0 )) || die 'private age identity must not be accessible to other users'
# The separate recovery host is mandatory; reject accidental execution in
# the live production deploy directory.
[[ ! -e infra/production.env ]] || die 'refusing drill in a production deployment directory; use an isolated recovery host'
command -v age >/dev/null || die 'age decryptor is missing'
command -v docker >/dev/null || die 'Docker is missing'

container="atlas-pg-drill-$(date -u +%Y%m%d%H%M%S)-$RANDOM-$RANDOM"
started=false
cleanup() {
  if [[ "$started" == true ]]; then
    docker rm -f "$container" >/dev/null 2>&1 ||
      printf 'WARNING: failed to stop isolated restore container; remove the drill container manually.\n' >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
# Hard-coded, ephemeral, networkless PostgreSQL 16 container: no bind mounts,
# Compose files or published ports. Never use a supplied database URL.
started=true
docker run --detach --rm --name "$container" --network none \
  --memory 2g --cpus 2 --security-opt no-new-privileges:true \
  --env POSTGRES_DB=atlas_recovery --env POSTGRES_USER=atlas_recovery \
  --env POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null ||
  die 'could not start the isolated PostgreSQL container'
ready=false
for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U atlas_recovery -d atlas_recovery >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || die 'isolated PostgreSQL did not become ready'
# Plaintext exists only in a pipe, never a host file.
if age --decrypt --identity "$identity" "$archive" 2>/dev/null |
   docker exec -i "$container" pg_restore --no-owner --no-acl \
     --exit-on-error --single-transaction -U atlas_recovery -d atlas_recovery >/dev/null 2>/dev/null; then
  :
else
  die 'decryption or isolated pg_restore failed (raw diagnostics suppressed)'
fi
# Representative Atlas schema/data checks, read-only inside disposable DB.
for table in projects stores records; do
  count="$(docker exec "$container" psql -U atlas_recovery -d atlas_recovery \
    -X -A -t -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.$table" 2>/dev/null)" ||
    die 'representative restored Atlas tables could not be queried'
  [[ "$count" =~ ^[0-9]+$ ]] || die 'invalid restored row count'
  if [[ "$table" == projects ]]; then
    (( count > 0 )) || die 'restored Atlas database unexpectedly has zero projects'
  fi
done
post_sha="$(sha256sum -- "$archive" | awk '{print $1}')" || die 'post-restore checksum unavailable'
[[ "$post_sha" == "$expected_sha" ]] || die 'archive changed during restore; result cannot be trusted'
# Remove the database BEFORE reporting success; a cleanup failure is a failure.
docker rm -f "$container" >/dev/null 2>&1 ||
  die 'could not remove isolated restore container; investigate and remove it manually'
started=false
printf '{"status":"isolated_restore_passed","archiveCiphertextSha256":"%s","sourceDatabase":"%s","targetDatabase":"atlas_recovery","postgresMajor":16,"noNetwork":true,"noHostMounts":true,"databaseRestored":true,"r2ObjectsRestored":false}\n' \
  "$expected_sha" "$database"
