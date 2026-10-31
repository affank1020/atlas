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
   `verifiedPrimaryViaLegacyLocal`, `snapshotObservedAt`, failure counts,
   and the report's scope. A local-fallback count above zero means verified
   primary reads still depend on a legacy disk volume; do not describe
   those Files as physically present in primary R2. The *recovery R2*
   bytes are nevertheless verified against the source metadata.
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


## 6. Project and Portfolio independent recovery (operator-only)

These Stage 5/6 commands are **tools, not production acceptance evidence**.
Use them only after a trusted operator has confirmed environment isolation,
independent Cloudflare ownership, a verified PostgreSQL snapshot and a
documented application write-quiescence boundary. The legacy Files tools
still cover Workspace/Application-owned Files excluded from Project storage.

On a reviewed source checkout with the primary PostgreSQL/R2 configuration
and legacy Files mount, build then capture immutable, SHA-256 verified
Project/Portfolio metadata without making any R2 backup PUT:

~~~sh
npm run build:server

ATLAS_PROJECT_RECOVERY_CAPTURE_ENABLED=1 \
npm run files:r2:project-recovery -- \
  --capture --project=PROJECT_UUID --confirm=CAPTURE_PROJECT_RECOVERY

# Optional only after EVERY Stage 4B key copy has a verified receipt:
ATLAS_PROJECT_RECOVERY_CAPTURE_ENABLED=1 \
npm run files:r2:project-recovery -- \
  --capture --project=PROJECT_UUID --versioned-run=KEY_RUN_UUID \
  --confirm=CAPTURE_PROJECT_RECOVERY

# Read-only preview. Maximum five objects per batch:
npm run files:r2:project-recovery -- \
  --dry-run --project=PROJECT_UUID --run=RECOVERY_RUN_UUID --max-files=5

# Only after separate explicit approval to populate offsite R2:
ATLAS_PROJECT_RECOVERY_SEED_ENABLED=1 \
npm run files:r2:project-recovery -- \
  --seed --project=PROJECT_UUID --run=RECOVERY_RUN_UUID \
  --confirm=SEED_PROJECT_RECOVERY --max-files=5
~~~

Every authorised seed batch stores immutable, per-object SHA-256/size
verification receipts **after** independent recovery R2 readback. On a
six-object manifest, the first five-object invocation is partial; the final
one-object invocation reports completed only when all six durable receipts
are present and match the manifest. The receipts survive process restarts.
To inspect complete coverage across all prior batches, without R2 access:

~~~sh
npm run files:r2:project-recovery -- \
  --status --project=PROJECT_UUID --run=RECOVERY_RUN_UUID
~~~

This read-only, metadata-only status reports totalEntries, verifiedEntries,
the earliest unverified nextOrdinal, and complete/incomplete. It requires no
primary or backup R2 credentials. It **does not** re-read current offsite
bytes, assert current recoverability, or replace the separate isolated
restoration drill. Dry-run writes no receipts. A failed/ambiguous PUT leaves
its batch unreceipted until the objects are reverified on retry.

Continue with --from=NEXT_ORDINAL when a run reports missing receipts;
review each batch before an approved seed. The implementation preflights
all source and existing recovery bytes before any atomic create-only PUT,
then re-reads the remote object. It never overwrites a corrupt recovery copy
or deletes source bytes. Preserve the privately recorded run ID, Project,
catalogue digest, manifest digest, all page reports and exceptions. A
legacy-only manifest does NOT certify already-copied versioned keys.

For isolated verification, separately obtain an offsite encrypted
PostgreSQL archive, verify it and restore onto a physically separate
recovery host. The existing one-shot postgres-restore-drill script removes
its disposable container: the combined check requires an independently
reviewed, accessible disposable restored database. Do not relax the
existing Docker daemon isolation checks to expose that container.

The offline host must have ONLY ATLAS_RESTORED_DATABASE_URL, the recovery
R2 endpoint/bucket/scoped credentials, ATLAS_R2_PRIMARY_ACCOUNT_ID (public
account identity only), and ATLAS_RECOVERY_HOST_APPROVED=1. No DATABASE_URL,
primary R2 keys, server .env or production R2 mounts are permitted.
On that recovery host, verify the entire saved manifest:

~~~sh
npm run files:r2:project-recovery -- \
  --isolated-verify --project=PROJECT_UUID --run=RECOVERY_RUN_UUID \
  --max-files=2000
~~~

Only a nonempty full run with status passed and no missing or corrupt
object bytes is an object-recovery verification. A page beginning after
ordinal 0 reports partial even when the sampled bytes are valid.
The restored database must contain the exact recovery-run rows: a snapshot
captured before those rows exist fails, as does catalogue drift. No primary
bucket access or R2 PUT is permitted in this mode.

**Not yet proven by code or CI:** live offsite custody of ciphertext and age
identity, a matching PostgreSQL/R2 consistency boundary, physical recovery
host isolation, the excluded legacy Workspace/Application Files inventory,
full backup coverage for each Project, replacement Atlas startup, measured
RPO/RTO, and approval for metadata cutover or retention. Keep these gated.


## 7. Cutover preflight is not cutover approval

After one Project has a fully copied and byte-verified Stage 4B run and a
fully seeded Stage 5/6 recovery manifest **including that same key-copy
run**, a trusted operator can run the read-only assessment documented in
PROJECT_STORAGE_V2.md. It checks exact metadata identity, SHA-256 receipts
and at most five entries per bounded live byte pass, across both primary
legacy/new keys and both independent recovery legacy/new keys.

The result must be recorded privately with the Project and both run IDs,
the observed page ordinals, checksum status, blockers and the approved code
revision. Multiple passed pages are a collection of time-separated
observations, not one atomic snapshot. Reconcile new writes, archive/restore
changes and variants again after a real writer-quiescence boundary.

No value emitted by that assessment authorises an UPDATE to atlas_files,
media_assets or media_variants. It cannot establish independent recovery of
the encrypted PostgreSQL archive, a rebuilt Atlas application, or tested
rollback. Keep production key metadata unchanged until the real DR drill
and operator approval are complete. No deletion or retention changes follow
automatically.


## 8. Disposable PostgreSQL key-switch and reversal rehearsal

Before proposing any live cutover, use the Stage 8 simulation on a local
disposable recovery database whose catalogues and key-copy/recovery manifests
are internally consistent. Follow the exact command and isolation guard
requirements in PROJECT_STORAGE_V2.md. The operation temporarily runs
conditional UPDATEs within one transaction, verifies all forward keys, then
reverses all keys and verifies the original snapshot digest. **ROLLBACK is
mandatory on success and failure.** The database, source R2, independent
R2 and public URLs are untouched after execution.

Record the reviewed commit, database origin/time, Project and immutable
manifest IDs, simulated forward/reverse row count per table, measured
transaction outcome, and source catalogue SHA-256 without secrets.

A simulated transaction is *not* a substitute for a verified offsite
PostgreSQL snapshot, matching recovery R2 bytes, offline Atlas startup, a
quiesced production write boundary or explicit operator approval. It does
not offer a production apply/commit mode or retention/deletion commands.


## 9. Isolated Workspace/Application Files recovery-only verification

**Coverage gap:** Stage 5/6 Project recovery manifests cover Project-owned
Files and Portfolio originals/variants, including archived assets. Historical
Workspace- and Application-owned Atlas Files are outside those per-Project
manifests and require a separate recovery-only verification.

On an approved *physically isolated* host, using an independently restored
PostgreSQL database and only recovery credentials, supply the same environment
required by the existing Project isolated verifier: a localhost
ATLAS_RESTORED_DATABASE_URL pointing to an atlas_recovery database,
ATLAS_RECOVERY_HOST_APPROVED=1, ATLAS_R2_PRIMARY_ACCOUNT_ID (account ID only)
and independent ATLAS_R2_RECOVERY_* variables. Never load production .env,
DATABASE_URL, primary R2 credentials or the local Files fallback volume.

~~~sh
npm run build:server
npm run files:r2:isolated-legacy-files -- \
  --verify-legacy --max-records=2000
~~~

This command performs PostgreSQL SELECT and independent recovery R2 GET
only. It selects **all active and archived** Workspace/Application Files,
validates their legacy keys, SHA-256 and byte sizes, verifies the independent
R2 bytes and checks the catalogue again. Network, access-denied, timeout
and oversized response errors abort rather than masquerading as absent keys.

Result interpretation: **passed** = a nonempty complete legacy catalogue
(at most 2,000 records) independently verified; **empty** = no legacy
Workspace/Application records in the restored DB, not positive byte
evidence; **partial** = the catalogue exceeds the chosen bound and full
coverage cannot be claimed; **failed** = missing/corrupt objects, invalid
metadata, or detected catalogue drift. **Only passed exits 0.** Empty,
partial and failed each exit 2 while retaining their distinct JSON statuses,
so scripts checking exit codes cannot treat a zero-object restored snapshot
as successful recovery. Environment/configuration errors exit 1. An empty
result can only be accepted as an explicit, independently documented
zero-legacy-file inventory; it never proves recovered object bytes.
The summary reports counts and an
inventory SHA-256 only, not individual file names, object keys or owner IDs.
If more than 2,000 records exist, do not claim full verification without a
separately reviewed expanded coverage mechanism.

Record privately the outcome, checked/archived/active counts, inventory
fingerprint, snapshot ID, code revision, operator and time. Run this alongside
complete Project/Portfolio isolated verification for **every** Project with
files, offsite encrypted PostgreSQL snapshot custody and decryption evidence,
a matching writer-quiescence boundary and real Atlas application/read smoke
tests. Neither this verifier nor a collection of green CI checks proves
that a full isolated disaster-recovery drill was completed.

No live backup, R2 seed, production database restore, key migration,
retention or cutover happens by running or merging this code.
