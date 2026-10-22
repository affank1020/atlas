# Manual offsite PostgreSQL ciphertext publication to independent Cloudflare R2

The encrypted snapshot producer ([POSTGRES_BACKUP.md](POSTGRES_BACKUP.md)) and
isolated restore drill ([POSTGRES_RESTORE_DRILL.md](POSTGRES_RESTORE_DRILL.md))
are available, but **neither automatically creates an offsite copy**.
This operator-only command publishes one already-encrypted PostgreSQL archive
plus its immutable manifest to a separate Cloudflare account's private R2
bucket. It does not connect to PostgreSQL, use the age private key, decrypt,
overwrite, delete, apply retention or schedule jobs.

## Independent recovery setup

1. In a **separately administered** Cloudflare account, provision an R2
   bucket exclusively for recovery. Do not reuse the primary Cloudflare
   account, credentials or public access. Record/account for the bucket's
   retention and object protection separately. The script rejects identical
   primary and recovery account IDs, but cannot cryptographically prove
   independent administration.
2. Issue recovery-account R2 credentials scoped to **this bucket** with
   Object Read & Write (GET and conditional PUT; R2's token permissions may
   additionally allow operations the script never invokes). Do not install
   the recovery credential on the live Atlas server where possible.
   **Never grant this script a production R2 key or age private identity.**
3. Copy the encrypted .dump.age file and its .dump.age.json sidecar to a
   trusted *operator* host with Node.js 20+ and adequate memory. Files must
   be owned by the current operator and readable only by that account
   (for example mode 0600). Do not copy unencrypted PostgreSQL dumps.
   The source files may be up to **256 MiB** (manifest 4096 bytes);
   larger encrypted snapshots require a separately reviewed streaming or
   multipart publishing implementation.
4. Configure on this operator host only:

   - ATLAS_R2_ENDPOINT: primary account's public S3 endpoint **without**
     primary credentials (used to reject same-account false independence).
   - ATLAS_R2_RECOVERY_ENDPOINT: separate Cloudflare account's S3 endpoint.
   - ATLAS_R2_RECOVERY_BUCKET: private recovery bucket name.
   - ATLAS_R2_RECOVERY_ACCESS_KEY_ID / ATLAS_R2_RECOVERY_SECRET_ACCESS_KEY:
     the recovery-account bucket-scoped token.

   Use a private operator environment/secret manager. Do not print secrets,
   commit them to Git, paste them in chat or include them in shell history.
   Cloudflare documents S3 endpoints at
   https://developers.cloudflare.com/r2/get-started/s3/.

## Dry-run (default, no network)

Run from a reviewed checkout on the operator host:

    node scripts/postgres-offsite-r2.mjs --archive=/absolute/private/atlas-....dump.age

The tool opens the archive and manifest without following leaf symlinks,
validates their privacy, schema, byte count and SHA-256, and prints **only**
content-addressed planned object keys and metadata. It makes **no**
network requests and does not need R2 credentials for this step.

## Explicit publication

    node scripts/postgres-offsite-r2.mjs --archive=/absolute/private/atlas-....dump.age \
      --apply --confirm=PUBLISH_PG_OFFSITE

The script reads only **two deterministic keys** beneath
`postgres-backups/v1/<ciphertext-sha256>`:

- `.dump.age` — ciphertext, published first.
- `.dump.age.json` — byte-for-byte original producer manifest, published
  **only after** ciphertext is read back and its checksum revalidated.

For both objects, it first GETs and verifies any existing copy against the
local snapshot. It **never overwrites** differing or corrupt copies.
Confirmed missing objects may be created only with signed
`If-None-Match: *` PUT; Cloudflare R2 evaluates this condition atomically
(see https://developers.cloudflare.com/r2/api/s3/extensions/).
A 412 race is re-read and verified. Only a classified S3 `NoSuchKey`
means absent; `NoSuchBucket`, forbidden access, transport uncertainty and
oversized responses stop the operation. If ciphertext has been uploaded but
the manifest has not, it is **incomplete**, not a committed recovery point.
Rerunning safely continues after verifying what already exists.

The script never sends a DELETE, ordinary overwriting PUT, or cloud-side copy.
It may temporarily hold encrypted archive bytes in operator-host memory;
there is no decrypted data path. It emits a small JSON report, with
`restoreVerified:false` even when both remote objects were verified.
Cloudflare R2 request/storage charges apply.

## Independent read-back (no mutations)

    node scripts/postgres-offsite-r2.mjs --archive=/absolute/private/atlas-....dump.age \
      --verify

`--verify` requires recovery GET permission and confirms that the **two**
remote keys still match the local encrypted snapshot. A successful verification
**does not** establish that a private age identity exists or that PostgreSQL
restoration works.

The next operational step is to copy these independently stored ciphertext
objects to a separate recovery host, verify the bytes, and run the isolated
PostgreSQL restore drill. Coordinate with the Atlas Files R2 seeder and
read-only verifier as well. An R2 account can be compromised or deleted, and
a database snapshot is not a transactionally atomic recovery point with
separate Files objects. Do not claim full disaster recovery or enable
retention-based deletion until that combined drill succeeds.
