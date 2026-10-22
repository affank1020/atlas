# Operator-only encrypted PostgreSQL backup

This is the **first manual PostgreSQL backup milestone**, not yet a full
disaster-recovery implementation. It creates a consistent, encrypted,
locally stored archive without modifying the database. It does **not**
automatically create off-host backups, test restores, enforce retention, or
schedule jobs.

## Prerequisites

- Trusted Linux VPS, running the Atlas production Compose stack.
- From the `~/atlas-deploy` directory, the private
  `infra/production.env` and production Compose manifest must exist.
- Install the trusted `age` CLI and standard Linux `sha256sum`.
- Generate an age X25519 private identity on **another secure device**. Keep
  its private identity offline and out of the VPS, git, logs, Docker and CI.
  Set **only its public recipient** in the operator's environment:
  `export ATLAS_PG_BACKUP_RECIPIENT='age1...'`.
- Copy the reviewed `scripts/postgres-backup.sh` to the VPS operator
  directory. Use an operator-owned private destination (mode 0700) with
  room for the archive. Never place it in the source repository.

## Run

```bash
cd ~/atlas-deploy
# Read-only configuration check; prints only the active database name.
bash scripts/postgres-backup.sh

# Explicitly produce one encrypted custom-format snapshot.
bash scripts/postgres-backup.sh --apply --confirm=BACKUP_POSTGRES
```

Optional `--out-dir=/absolute/private/path` changes the default destination
from `$HOME/atlas-private-backups`. The tool rejects symlinked or
improperly permissioned destination directories, unsafe database names and
missing explicit confirmation.

The script examines the running Server container's effective
`DATABASE_URL` **before** invoking the local Compose `postgres` container.
For this deliberately limited local-Compose implementation, the URL must
use PostgreSQL protocol, host exactly `postgres`, port `5432` (or no
explicit port), username exactly `atlas`, an alphanumeric/underscore
database name, and **no query-string routing overrides or fragment**.
A missing or mismatched endpoint fails closed. Nothing prints the complete
URL or credentials. This prevents both backing up the retired empty
`atlas` database and falsely labelling a stale local database as an
offsite/alternate production instance. For an external database or different
Compose service, do not bypass the guard: add a reviewed backup transport
that actually reaches that database.

It then runs PostgreSQL 16 `pg_dump` in custom format, with MVCC
transactionally consistent snapshot semantics, and streams its output
directly through `age --recipient`. No raw database dump file is created
by this command. With `pipefail`, failure of either subprocess aborts the
snapshot; private partial output is removed. Private, mode-0600 temporary
stderr captures are removed on exit; any warnings or failures produce
**whitelisted diagnostic categories only** (e.g. permission, lock
contention or connection). Raw diagnostic text is never printed because
it may include passwords, SQL fragments, paths or other secrets.
Warnings are visible but do not alone establish the dump is restorable.

Successful output consists of atomically create-only hardlinked paths:
`*.dump.age` ciphertext, mode 0600, and `*.dump.age.json` manifest with
timestamp, database name, size and ciphertext SHA-256. It sets
`verifiedRestore: false` deliberately: snapshot/encryption success is **not**
proof that restoration works. The SHA-256 is a transport-integrity check only.

## Isolated restore drill

The operator-only [PostgreSQL restore drill](POSTGRES_RESTORE_DRILL.md)
supports dry-run checks and an explicit restore into a disposable, networkless
PostgreSQL 16 Docker instance **on a separate recovery host**. It consumes a
verified age-encrypted snapshot and offline-held identity without writing a
plaintext archive or touching production. Passing this drill proves only that
one database snapshot restored; it does not verify offsite copy custody, R2
objects or coordinated application recovery.

## Publish encrypted backups to independent R2

After obtaining an encrypted archive and sidecar, the operator can use the
[manual append-only R2 publisher](POSTGRES_OFFSITE_R2.md) from a trusted host
to place both artifacts in a **different Cloudflare account**. It validates
the local ciphertext and manifest before every publication, uses conditional
create-only PUT, and independently reads back the remote ciphertext and
metadata. This is distinct from the Atlas Files R2 seeding tool and does not
perform restores or create automatic backups.

## Recovery and retention work still required

1. **Off-site copy:** Transfer both the ciphertext and manifest, with
   create-only semantics, to a private independent recovery account/bucket or
   trusted offsite host. Compare the destination SHA-256. An encrypted copy
   left only on the VPS is not disaster recovery. Never store the age
   private key alongside the backup.
2. **Isolated restoration:** On a separate trusted recovery host, with the
   private age identity and a disposable PostgreSQL 16 database, decrypt and
   feed the custom archive to `pg_restore`. An example *only after creating
   and verifying an isolated `atlas_recovery` target*:
   ```bash
   set -o pipefail
   age --decrypt --identity /secure/offline/identity.txt atlas-...dump.age |
     pg_restore --no-owner --no-acl --exit-on-error --dbname atlas_recovery
   ```
   **Never run this against live Atlas production.** Validate representative
   records, schema, referential integrity and Atlas startup. Record the
   exact SHA-256 tested and restore result.
3. **Retention:** Before introducing deletion, adopt a policy at the
   independent destination (for example, daily copies for 30 days and
   monthly checkpoints for 12 months), with immutable protection where
   supported, plus restore-proven safety checks. This script never prunes or
   overwrites copies. Backups must be copied off-host before local cleanup.
4. **Application-wide consistency:** A `pg_dump` is a consistent DB
   snapshot, not a transactionally atomic backup with R2 objects or legacy
   local Files. Plan an explicit writer-quiescence/capture boundary or
   record a recovery manifest linking DB snapshot to immutable object copies.
5. **Other recovery data:** A DB dump does not include global PostgreSQL
   roles, secrets, Docker configuration, Caddy state, local media volumes,
   age private keys, or independent R2 objects. These need separate custody
   and isolated restore testing.

This PR makes no database writes and adds no route, scheduler, retention
deletion, R2 mutation, deployment change or unapproved operational command.
