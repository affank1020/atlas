# Manual, append-only R2 recovery backup seeding

Atlas Files has a read-only recovery verification drill (`npm run files:r2:verify-recovery`).
That drill **does not create a backup**. This page describes the separate,
**manual** recovery seeder. It copies *currently committed* private Atlas Files
objects into an operator-provisioned R2 recovery bucket. It is **not** an
automatic backup job, PostgreSQL snapshot, restore tool or complete disaster
recovery guarantee.

## Prerequisites

1. Provision a private R2 backup bucket with credentials **different from the
   primary credentials**. Use a separately administered Cloudflare account for
   resilience against primary-account loss. Two buckets in one Cloudflare
   account are not account-independent disaster recovery.
2. On the trusted operator host, configure `DATABASE_URL` and the primary
   `ATLAS_R2_ENDPOINT`, `ATLAS_R2_BUCKET`,
   `ATLAS_R2_ACCESS_KEY_ID`, `ATLAS_R2_SECRET_ACCESS_KEY`.
   Configure the recovery bucket through `ATLAS_R2_RECOVERY_ENDPOINT`,
   `ATLAS_R2_RECOVERY_BUCKET`, `ATLAS_R2_RECOVERY_ACCESS_KEY_ID`,
   `ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY`. The seeder **fails closed** if
   the recovery configuration is missing, points to the same endpoint/bucket,
   or shares either access-key ID or secret with the primary.
3. Grant minimum required primary **GET** access and recovery **GET + PUT**
   access on the respective buckets. Keep both buckets private; do not add
   DELETE permissions to the seeding credential. Confirm your recovery bucket
   access, retention/lock policies and operational key custody separately.
   The seeder itself has no delete operation and cannot override existing
   backup objects. The trusted host must also have the legacy `ATLAS_MEDIA_DIR`
   mounted/configured correctly: committed Files created before primary R2
   was enabled can exist **only** on local disk. The seeder follows the live
   Files source read order (primary R2, then bounded local fallback only on
   confirmed `NoSuchKey`). Any missing local storage root, symlink object,
   unreadable/oversized local file or R2 bucket error aborts as inconclusive.
   A local source is checksum-validated before any backup PUT.

## Dry-run first

Build the server and inspect a small batch **before** authorizing any writes:

```sh
npm run build:server
npm run files:r2:seed
npm run files:r2:seed -- --max-files=5
```

The default is a read-only dry run, with at most **3** committed File records;
`--max-files=1..10` sets a hard per-run upper bound. Archived records remain
in scope. Reads include the destination copy if present and, if missing, the
primary bytes. Every retrieved object is checked against the committed
PostgreSQL SHA-256 and byte size before it is trusted.

The JSON report includes `mode`, `status`, `checked`, `existingVerified`,
`planned`, `createdVerified`, `racedVerified`, `invalidMetadata`,
`primaryMissing`, `primaryCorrupt`, `backupCorrupt`, `bytesRead`,
`bytesUploaded`, `writesAttempted`, `remaining`, `nextCursor` and up to ten
opaque failure file IDs. No file names, file bytes, R2 secrets or signed
headers are printed.

**Investigate any** `failed` / `empty` report, absent/corrupt source,
or corrupt existing backup before applying. A backup copy that exists but
fails checksum verification is never replaced by this tool. R2 404 responses
with `NoSuchBucket` or an unknown/malformed error body are *not* treated
as absent objects: only an explicit `NoSuchKey` can trigger local fallback
or planning a new backup copy.

## Explicit manual apply

Only after reviewing the dry run and confirming bucket isolation, run:

```sh
npm run files:r2:seed -- --apply --confirm=SEED_R2_RECOVERY
```

You may supply `--max-files=N` to limit the batch further. The parser
rejects `--apply` without **that exact confirmation**, rejects mixing
`--apply` with `--dry-run`, and rejects unknown arguments.

The command never overwrites a backup object. For each valid catalog row:

- Existing destination: read and checksum it; if corrupt, report a failure
  and do **not** touch it.
- Missing destination: read the primary R2 object or, only when that key is
  confirmed absent, the matching local legacy object from `ATLAS_MEDIA_DIR`.
  Both reads enforce the 25 MiB cap and exact SHA-256/byte-length validation.
  A truly missing or corrupt source is not uploaded. Remote bucket or
  permission errors are **not** permission to fall back to local storage.
- Authorized copy: use signed `PutObject` with **`If-None-Match: *`**. R2
  checks this condition atomically at commit. A concurrent writer can cause
  HTTP 412; in that case, re-read and verify the winning copy.
- After a successful PUT, also re-read the destination and checksum it.
  If the PUT outcome, subsequent GET, credentials or network state is
  uncertain, stop rather than pretending an intact backup exists.

At most ten records are visited per run. No R2 DELETE/COPY, object overwrite,
PostgreSQL update, background job, API route, scheduler or Atlas Worker is
introduced. Source R2 content is unchanged. GET and PUT requests are billable.

## Pagination and interpretation

If `remaining: true`, the report contains `nextCursor`, an *Atlas File UUID*
(not an arbitrary object key). The following batch can be previewed and then
applied using the same cursor:

```sh
npm run files:r2:seed -- --cursor=<nextCursor>
npm run files:r2:seed -- --apply --confirm=SEED_R2_RECOVERY --cursor=<nextCursor>
```

A cursor run is always marked `partial`, even when every visited object is
verified. `ready` (uncursored dry run) and `completed` (uncursored apply) only
mean the bounded query reached the end of the currently committed catalog.
They are **not** a complete historical coverage or recovery-point guarantee.
Concurrent Files changes may require a new pass. Invalid metadata is counted,
including empty object keys; a malformed key cannot be used to skip later
UUIDs.

A status of `failed` or `empty` exits with code 2; a configuration or remote
failure exits with code 1 and redacted details. `partial` exits 0 but must not
be considered proof of complete seeding.

## Whole-catalog verification after seeding

For a recoverability check across the *whole bounded catalog*, rather than
manually repeating the small sampled verifier's cursor, run:

```sh
npm run build:server
npm run files:r2:verify-catalog
# If the report indicates a cap hit, rerun with a larger limit (up to 200):
npm run files:r2:verify-catalog -- --max-records=200
```

This is a **read-only** command: one PostgreSQL `SELECT` captures up to
`maxRecords+1` committed Files metadata rows from a single SQL statement
snapshot. Only the first `maxRecords` rows (default **100**, maximum **200**)
are checked sequentially using bounded R2 GETs against both the primary and
recovery buckets. No DB transaction is held during remote network requests.
No seed/PUT/DELETE, plaintext download to disk, server route or scheduler is
introduced. Note that a run may download up to 25 MiB per object **from each
bucket**, so R2 request/transfer costs and operator runtime apply.

A report may be `passed` **only** if all captured rows fit under the limit,
the catalog is nonempty, and every row passed checksum/metadata validation for
**both** copies. `partial` means the cap was reached; `failed` means at
least one invalid, missing or corrupt object; `empty` is not a pass. Only
`passed` exits 0; any other result exits 2, and an unexpected DB/R2 error
exits 1 without leaking endpoints/credentials. At most ten opaque File IDs
appear as failure examples; no filenames or object bytes are logged.

**Scope matters:** The report describes the database metadata visible to its
*one SELECT statement*; later writes are not covered. This is evidence for
object-level recoverability **at that observation**, not a shared
PostgreSQL/R2 point-in-time snapshot or proof of full application recovery.
Re-run after recent writes or seeding changes, and use the isolated
PostgreSQL recovery drill plus the operator
[recovery acceptance runbook](RECOVERY_ACCEPTANCE.md) before claiming DR ready.

The existing `npm run files:r2:verify-recovery` remains available for
targeted small-batch debugging with explicit cursors. Neither verifier
creates or updates backup copies.

Finally, plan and test an isolated restore of both PostgreSQL metadata and
objects, credential recovery, retention, and periodic scheduling. Seeding
and object verification alone do not provide those protections.
