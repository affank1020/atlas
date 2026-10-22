# Atlas recovery acceptance: manual evidence and decision gate

**Status:** Operational acceptance procedure; never mark disaster recovery
ready just because a backup script, restore script, or green CI exists.

The reviewed tooling covers encrypted PostgreSQL snapshots
([POSTGRES_BACKUP.md](POSTGRES_BACKUP.md)), their create-only offsite
publication ([POSTGRES_OFFSITE_R2.md](POSTGRES_OFFSITE_R2.md)), independent
Atlas Files R2 seeding ([R2_BACKUP_SEEDING.md](R2_BACKUP_SEEDING.md)) and
isolated PostgreSQL restoration
([POSTGRES_RESTORE_DRILL.md](POSTGRES_RESTORE_DRILL.md)). This runbook joins
their **manual** evidence, but does not automate an application-wide
recovery point or constitute a completed disaster-recovery exercise.

## 1. Independent custody: stop unless verifiable

- Independently administered Cloudflare account and private R2 recovery
  bucket, **not** just a second bucket in the primary account. Dedicated
  bucket-scoped recovery credentials; documented owner and access process.
  Never paste tokens or age identities into chat or store them in Git.
- A separate trusted Linux recovery host or other suitable physically
  isolated host. The offline age private identity is available to the
  recovery operator, **not** placed on the production VPS.
- Evidence of how production bootstrap configuration, PostgreSQL roles,
  infrastructure settings, node credentials and local legacy Files volumes
  can be reconstructed. Those are not included in a SQL data archive.
- Verify production R2 and PostgreSQL monitoring are healthy. Primary
  storage analytics are **not** independent backup evidence.

If any prerequisite is missing, record **blocked**, do not invent an
availability or restore status.

## 2. Capture and publish one PostgreSQL snapshot

On the authorised production operator host, follow POSTGRES_BACKUP.md and
perform its initial read-only dry run. Only then explicitly authorize
one encrypted backup. Record the generated ciphertext SHA-256, producer
manifest timestamp and source database **name only** (never a DB URL or
password). Review the command's private output location.

Transfer only the age ciphertext and matching manifest to a trusted
publication host. Use POSTGRES_OFFSITE_R2.md to first verify both local
files, then explicitly upload with create-only conditional PUT, and
separately execute the read-only `--verify` round trip. Record the
offsite account/bucket **identifiers** and exact immutable ciphertext
SHA-256. Success must identify both offsite objects, not a partially
uploaded pair. A copy left on the VPS alone does not count.

## 3. Cover the recoverable Files catalog

From an appropriately trusted host with the correct database connection,
the legacy Files volume and both independent R2 storage configurations:

1. Run the manual R2 Files seeder in **dry-run** mode. Review its bounded
   summary and apply, batch by batch, only after checking credentials and
   source integrity. Existing corrupt backups are never overwritten.
2. Run `npm run files:r2:verify-catalog` read-only. If it reports
   `truncated:true`, rerun with `--max-records=200`; if the catalog
   still exceeds 200, do **not** claim complete verification using this
   command. Use reviewed cursor-scoped verification with an externally
   auditable coverage ledger or extend bounds in a separate review.
3. Accept a `passed` catalog report only when `truncated:false`,
   `verifiedBoth === checked`, the catalog is nonempty, and every
   missing/corrupt/invalid counter is zero. Record `checked`,
   `snapshotObservedAt`, failure counts, and the report's scope.
   A post-snapshot write is **not** covered by the prior report.

The catalog verifier compares backup object bytes against metadata from
one *live* database statement. It cannot prove that a given DB archive
represents the same logical Files state, nor that every older object in an
R2 bucket remains reachable after losing the primary account.

## 4. Demonstrate an actual isolated PostgreSQL restore

Obtain the **independently stored ciphertext** from recovery R2 using an
approved operator method, not a copy of the local production archive.
On the separate recovery host, independently verify ciphertext size and
SHA-256 against the captured manifest, follow
POSTGRES_RESTORE_DRILL.md, set the **local recovery** daemon ID and
explicitly run its guarded restore.

Record the exit status, archive SHA-256, schema/data-check summary and
disposable container cleanup. The isolated restore drill has deliberately
narrow success criteria; validate representative application queries and
the ability to start Atlas against a separately reconstructed test
configuration before declaring an end-to-end exercise.

**Never run restore against production**, do not direct Docker at the
production daemon, and do not weaken the guarded local socket/daemon-ID
checks to work around environment problems.

## 5. Coordination gap and sign-off

A PostgreSQL MVCC snapshot is consistent internally, but it is not
transactionally atomic with R2 uploads. A *real* cross-system recovery
point still needs a documented writer-quiescence window, or a reviewed
capture boundary and a replay/consistency scheme. This runbook does **not**
implement either. The R2 File checks also do not exercise restoring the
objects into a replacement Atlas Files environment after total primary
account loss.

Record these fields in private operational evidence (without secrets):

| Evidence | Value |
| --- | --- |
| Exercise time, operator, reviewed code commit | pending |
| Separate Cloudflare account/bucket provisioned | pending |
| Offline age identity recovery tested | pending |
| PostgreSQL source database name, snapshot timestamp | pending |
| Encrypted ciphertext SHA-256 and offsite read-back | pending |
| Full Files verification count, observed-at timestamp, status | pending |
| Isolated PostgreSQL restore and application smoke test | pending |
| Files availability without primary R2 account | pending |
| DB/Files capture boundary and observed data loss | pending |
| Recovery duration, deviations and cleanup | pending |

**Decision:** Unless all required rows have concrete evidence and the
DB/Files consistency gap is resolved, classify Atlas recovery as
`manual-tooling-complete / disaster-recovery-not-proven`, not
`DR ready`. Do not enable automatic retention deletion based on this
checklist alone.

Once the exercise succeeds, schedule repeat drills, decide realistic
RPO/RTO, add backup automation/retention/alerting and monitor that new
restorable recovery points continue to exist.
