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
   backup objects.

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

**Investigate any** `failed` / `empty` report, absent/corrupt primary, or
corrupt existing backup before applying. A backup copy that exists but fails
checksum verification is never replaced by this tool.

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
- Missing destination: read the primary object, enforce the 25 MiB maximum,
  and verify its exact SHA-256 and byte length. A missing or corrupt primary
  is not uploaded.
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

**After seeding:** independently run
`npm run files:r2:verify-recovery` against the same destination. The verifier
is read-only and has its own limits and cursor. Separately implement and test
consistent **PostgreSQL** backup, an isolated restore of both metadata and
objects, credential recovery, retention, and periodic scheduling. This CLI
alone does not provide any of those protections.
