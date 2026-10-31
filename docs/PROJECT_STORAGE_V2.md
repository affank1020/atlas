# Project Storage V2 — architecture and staged delivery

## Ownership contract

Atlas **Projects** are the sole owners of persistent user- and application-managed files. A Project ID is an immutable UUID; display names never enter object keys. Applications operate against their parent Project's file namespace, and Workspaces or Nodes may upload only through an explicitly authorised Project destination. Workspace checkouts and system artifacts are not automatically replicated to R2.

PostgreSQL is authoritative for file and folder metadata. R2 stores opaque bytes in the live `atlas-files` bucket. Recovery backups are independently held in the separate `atlas-recovery-private` account and are **not** another user-files namespace. System artifacts can continue using releases and package/container distribution.

Conceptual future object keys (not yet activated):

```text
projects/<immutable-project-uuid>/objects/<immutable-file-uuid>/v1
projects/<immutable-project-uuid>/objects/<immutable-file-uuid>/variants/<stable-variant>/v1
```

File versions use an explicit `vN` component; variants are stable subordinate objects, not extra file owners. Folder names, folder hierarchy and file display names exist only in PostgreSQL. Renaming or moving within a Project does not move object bytes. Authorization must be checked by Atlas; R2 prefixes alone grant no access.

The existing shared object adapter **currently accepts only legacy flat object keys**. Its allowlist, local-path safety, signed R2 URL semantics, listing and recovery contracts must be extended and tested together before writing keys with slashes. Do not enable the new format merely by broadening a regex.

## Current audit and migration hazards

- `atlas_files` stores `owner_kind` = `project | workspace | application`, with `owner_id` as text. Its uploads currently use opaque `files-<uuid-without-dashes>-<sha256>` keys. It remains the source for private Files download/restore and legacy recovery tools.
- `media_assets` and `media_variants` are a separate Portfolio catalog, using flat content-addressed object keys and public `/api/media/:id/:variant` delivery. Portfolio references, archived originals and generated variants need a reversible mapping, not a destructive in-place rewrite.
- `/api/files/*` uses private admin HTTP access and validates the requested owner. Moving owner authorization to Projects requires updating both the API and its callers, not only a UI change.
- `node-file-ingest.ts` authenticates enrolled Nodes and actively assigned Workspaces; retries, upload receipts, quota locks, resumable checkpoints and the default-off `ATLAS_NODE_FILES_ENABLED` gate depend on Workspace identity. Do not map a Workspace to an arbitrary Project without rechecking membership and rights under the same transaction.
- Independent R2 recovery seeding and verification currently scan `atlas_files`, not Portfolio media; backups must eventually cover both catalogs and all variants (including archived assets) during the transition. A restored PostgreSQL snapshot alone does not prove a matching object-recovery set.
- The operator-reported inventory before this project was 0 `atlas_files` rows, 31 Portfolio originals and around 87 total live objects. Treat those as a **historical observation**, not a replacement for fresh object-by-object integrity verification before migration.

## PR 1: additive metadata foundation (this change)

Migration `032_project_storage_foundation.sql` adds `atlas_file_folders` with stable folder UUIDs, a Project UUID foreign key, nullable parent, status and timestamps. Its composite parent FK prevents cross-Project nesting; separate case-insensitive partial unique indexes handle active root and sibling names. Folder identifiers and parents are immutable; an ancestry trigger prevents cycles. Invalid path segments are rejected.

A nullable `atlas_files.folder_id` represents the Project root when absent. An explicit trigger rejects any non-null folder reference unless the file is Project-owned **and** the folder belongs to that same Project. Current Workspace/Application Files keep `folder_id = NULL`; no owner or storage key is rewritten. A restrictive FK prevents deleting a referenced folder. There is no HTTP folder API, new user-facing upload destination, physical key change, data backfill or live R2 operation in PR 1.

Folder `status` is a foundation field, not a complete lifecycle API. Archiving nonempty folders, restoration conflicts, descendant visibility, folder moves and metadata-only file moves must be implemented and tested before exposing corresponding actions. Legacy `owner_kind` remains accepted only for compatibility until the Node and application migration paths are safe.

**Acceptance:** migration applies on clean PostgreSQL; tests prove root/sibling uniqueness, cross-Project isolation, invalid-segment rejection, cycle prevention, and legacy Files compatibility; existing Files/Node/Portfolio tests and builds remain green.

## Planned bounded PR sequence

1. **Project Storage foundation:** this additive migration, compatibility/physical-key contract, SQL-level scope tests and delivery plan; no production data writes or object migration.
2. **Project Files API and browser:** Project-only destinations for new admin uploads, folder create/rename/archive/restore, folder navigation, file relocation within the same Project, and server-side authorization plus lifecycle tests. Preserve read-only access to legacy Workspace/Application records through a deliberate compatibility path until migrated. Never list Workspaces or Applications as competing owners in the new Project browser.
3. **Portfolio catalog integration:** add a reversible mapping from existing Portfolio assets/variants to Project-owned shared metadata, retaining public media URLs, publication references, originals and variant byte identity; no automatic deletion.
4. **Physical key migration:** dry-run-first, resumable, create-only copy to versioned Project keys, source and destination SHA-256/size verification, recorded checkpoints, old-key reads during transition and protected rollback. Do not activate until the adapter supports both formats safely.
5. **Unified independent R2 backup:** full paginated catalog inventory of Project Files plus Portfolio originals/variants and archived assets; append-only recovery writes, SHA-256 checks, fail-closed missing/corrupt object handling and legacy/new key support.
6. **Isolated end-to-end recovery test:** restore matching PostgreSQL metadata plus complete object set from independent recovery credentials **without** access to the live bucket. Document catalog/snapshot consistency boundary, failure modes and acceptance evidence; only after success consider scheduled backup/retention/cleanup.

## Rollout and security gates

- Review and merge PRs individually; do not auto-merge or make live changes as part of code implementation.
- Schema first, dual-read compatibility next, carefully gated new writes after that, physical migration and finally retirement of old paths. No silent ownership reassignment.
- Back up all content, including variants and archived files, before deleting any legacy object; destruction, garbage collection and automatic retention remain out of scope.
- Never put either R2 account's credentials in code, PRs, logs or chat. Production credentials need not be accessed for development.
- Before any live physical migration, reconcile current object inventory and prove independent recoverability of source and destination material.

## PR 2A: Project Folder API and integrity (reviewable backend slice)

The private administrative `/api/files/*` API adds `folders-list`, `folders-create`,
`folders-rename`, `folders-archive`, `folders-restore`, and `file-move`.
All accept an explicitly validated Project owner. Newly uploaded files can
specify a `folderId`; filtered listing accepts `folderId: null` for the
Project root. Omitting the field on existing list callers retains historical
whole-owner listing behaviour. Binary uploads optionally use `x-atlas-folder-id`.

Folder IDs are immutable, as are parent-child links in the foundation schema.
Creation supports arbitrary nesting, but moving an entire folder is deferred.
Renaming is metadata-only. A folder can be archived only after all immediate
active children and active files have been archived or relocated; archiving
does not delete objects or metadata. Restoring requires an active parent and
a conflict-free sibling name. File moves are metadata-only and strictly within
the original Project. The new migration protects active file attachment and
reactivation using shared row locks, preventing a race with folder archival
through the admin service.

Existing admin Files routes retain legacy Workspace/Application operations
for compatibility with the still-deployed Files browser. Folder-specific routes
and destinations **only** accept Project ownership. PR 2B must replace the
browser's owner picker and enforce Project-only new uploads only after it can
no longer issue Workspace/Application writes; legacy read paths must remain
available through an explicit compatibility mechanism. The internal Node
ingest path is not changed and its existing Workspace authorization, receipts,
idempotency and default-off upload gate remain in effect; conversion of Node
uploads to Project ownership needs its own reviewed migration. Portfolio
media remains separate.

**PR 2B (next):** update the Files web client to present Projects rather than
three competing owner classes, add nested-folder navigation, folder actions,
destination selection and in-Project file moves. Until 2B, the existing web
browser does not yet expose the new folder endpoints. No R2 key migration,
backup changes, production upload enablement or Cloudflare action occurs.

## PR 2B — Project-first Files browser

The Files UI now shows **Projects only**, reflecting Project ownership of
managed storage. Workspaces and Applications are not storage-owner choices.
Within each Project, folder navigation uses immutable folder IDs and a
breadcrumb trail. The private API provides folder lists, nested creation,
renaming, archive/restore, root- or folder-scoped file listings, binary uploads
to the selected folder and metadata-only relocation of active files within
that same Project.

The active and archived views expose file lifecycle independently. Archived
folders are accessible in the Archived view and can be restored subject to
the server's active-parent and uniqueness guards. In an archived folder the
UI disables uploads and folder creation. A file whose containing folder has
been archived must have that folder restored before the file can be restored.
Folder archival requires immediate active contents to be moved or archived,
and **never** deletes stored bytes. Existing API and Node integrations may
still read legacy Workspace/Application records during future migration;
the Project-first UI does not silently reassign them.

The web demo client mirrors Project folder metadata operations for UI
development without R2. The browser does not expose physical keys, perform
cross-Project moves or enable the default-off Node upload pipeline. Portfolio
media remains in its specialised application until the separately reviewed
catalog unification phase.

## PR 3 — Portfolio Project storage catalogue (read-only, reversible)

Migration `036_project_portfolio_catalog.sql` adds the
`atlas_project_storage_objects` **read-only SQL view**. This is a single
Project-scoped metadata catalogue for native Project Files, Portfolio media
originals and every existing Portfolio derivative. Identity is the tuple
`(project_id, source, file_id, variant)`, not a rewrite of media asset IDs or
an assumption that variant names can become file IDs. Portfolio originals
retain their `media_assets.id`; variants retain their existing names and
object keys. All future Portfolio metadata changes are reflected automatically
by the view, without a one-time backfill or duplicate editable rows.

For the Portfolio Project (`d99a6c45-a4ec-5ef6-8f22-c07d31f8bb38`),
the private `/api/files/portfolio-catalog` route returns a bounded read-only
list of originals with metadata for their variants. The Project Files UI
displays them separately at the Project root, labelled as read-only and
managed by Portfolio. Active assets retain their original
`/api/media/<asset-id>/original` delivery URLs; archived assets have no
open link. No `storage_key` or R2 credentials are sent to the browser. Other
Projects receive an empty Portfolio projection; active-Project
authorization precedes the query. There are no Portfolio archive, folder-move,
upload or overwrite buttons in this projection.

**Object integrity limit:** the Portfolio original has an existing SHA-256
checksum and byte size, but the legacy `media_variants` table contains size,
MIME type and storage key **without a variant SHA-256**. The view explicitly
projects `NULL` for variant checksums; it must **never** be treated as
independent byte verification or permission to delete the original. The
later backup/recovery milestone must read and hash actual variant bytes and
prove coverage from both catalogues before any cutover. The API currently
fails closed if Portfolio contains more than 500 originals; server-side
pagination will be needed before growing past that bound.

Rollback is non-destructive: remove the new view, optional service route and
Files UI projection. No existing `media_assets`, `media_variants`,
`atlas_files`, revision/publication records, public media endpoints, local
files or R2 objects were mutated or copied by this change.

## Stage 4A — versioned key compatibility and guarded, copy-only migration

**No automatic migration or key cutover.** Both object adapters now validate
the exact `projects/<project-uuid>/objects/<file-uuid>/v1` and
`projects/<project-uuid>/objects/<file-uuid>/variants/<variant>/v1`
formats alongside legacy flat keys. Identifiers are immutable UUIDs; variant
segments are a bounded ASCII slug. All other paths, encodings, dot segments,
alternative versions such as `v01`, and noncanonical IDs fail closed.
Cloudflare SigV4 requests encode each path component separately. Local fallback
stores the logical slash-containing key as an encoded **single filename**, never
as attacker-controlled directory segments, and refuses symlink leaf reads.

The manual command is installed as `npm run files:r2:project-key-copy -- ...`
(after building the server package). It reads the existing
`atlas_project_storage_objects` view and processes at most **five** objects
per invocation, including **archived** Portfolio originals/variants and native
Project Files. The default is a bounded **read-only dry run** that reads and
SHA-256 hashes source bytes, verifies any existing target, and reports planned
missing targets. A variant has **no stored checksum**, so its SHA-256 is
calculated from bounded source bytes and compared byte-for-byte by digest
against any destination. Unsupported/malformed metadata, oversized/missing
objects, source mismatches or corrupt existing targets **fail closed**.

Operator flow (not authorised to run on production by merging code):

```sh
# 1. Check database / primary R2 configuration, inventory and independent
#    recovery readiness. These commands never perform an Atlas production copy.
npm run build:server
npm run files:r2:project-key-copy -- --dry-run --project=PROJECT_UUID --max-files=3

# 2. Only after separate operator approval and backup verification:
#    ATLAS_PROJECT_KEY_COPY_ENABLED=1, --apply, exact --confirm, and an
#    explicit --project scope are all REQUIRED. Keep credentials private.
ATLAS_PROJECT_KEY_COPY_ENABLED=1 npm run files:r2:project-key-copy -- \
  --apply --confirm=CREATE_PROJECT_KEY_COPIES --project=PROJECT_UUID --max-files=3

# 3. Save the receipt with its nextCursor. Resume by adding
#    --cursor=OPAQUE_NEXT_CURSOR to the same command and Project.
#    On any ambiguous write, repeat the CURRENT batch without advancing.
```

**Apply copies only** to the *existing primary* R2 bucket, with an atomic
SigV4 `If-None-Match: *` conditional PUT and bounded read-after-write
size/SHA-256 verification. An existing object is accepted only after verifying
its exact contents; no overwrite, delete or metadata update is supported.
Every bounded batch is completely preflighted **before any write**, reducing
partial writes from corrupt source metadata. Unexpected errors or lost
acknowledgements fail closed and **never return a new checkpoint cursor**;
rerunning the original batch rechecks copied bytes and is idempotent. Each
completed batch returns a deterministic identity-tuple `nextCursor` receipt
for operator retention, but **there is no durable server-side checkpoint
ledger or catalog-wide consistency snapshot yet**. A completed page is not
evidence that the entire catalog, independent backups or a matching database
snapshot are complete.

**Required before production activation or switching reads to new keys:**
review copy receipts, independently verify all Portfolio variants and archived
objects, account for catalog changes during paging, establish durable
audit/checkpoint evidence, prove recovery-only restore without live primary
access, and explicitly approve a separate metadata-cutover/rollback design.
Legacy `storage_key` rows, public `/api/media` delivery, Node ingest,
credentials, source objects, cleanup and retention remain unchanged. The
existing R2 Files inventory tool remains **legacy-prefix-only**; do not infer
that it inventories Project-versioned objects until Stage 5 implements a
unified catalog-based verifier.


## Stage 4B — durable copy manifest, checkpoint receipts and independent re-audit

Migration **037_project_key_checkpoints.sql** adds three separate operator-only
tables: **atlas_project_key_runs**, **atlas_project_key_manifest** and
**atlas_project_key_receipts**. These do not change Atlas Files, Portfolio media,
public URLs, old storage keys, Node uploads or application APIs.

A bounded immutable metadata manifest (maximum **1,000 objects per Project**)
is captured inside a repeatable-read PostgreSQL transaction. The digest
includes Atlas Files and every Portfolio original and variant (including
archived assets), source and destination keys, checksum when known, size,
MIME type and status. Empty, malformed, oversized, cross-Project or
duplicate catalogues fail closed. The entire manifest commits atomically.

Each explicit apply batch starts at the first missing **durable receipt**,
rather than relying on an operator to remember an untrusted cursor. The
current catalogue must match the captured digest before copying. The ledger
supplies the **exact immutable manifest rows** to the copy engine; it never
reselects a mutable live-catalogue page to decide which keys can be copied.
After bounded source/destination preflight, the current catalogue fingerprint
is checked again **before the first create-only PUT**. Detected drift aborts
without copy or checkpoint. The check cannot exclude later concurrent
metadata edits, but any resulting copy remains scoped to the saved manifest;
subsequent drift checks and the independent byte audit remain mandatory.
After completion, the ledger re-reads source and destination for actual
SHA-256 and size and commits the receipts together. An inconclusive copy
does not advance the ledger. A retry rechecks any previously copied R2
object and does not overwrite it. Conflicting concurrent checkpoint progress
fails closed.

Operator-only command (never scheduled; no HTTP or MCP API):

~~~sh
npm run build:server

# Explicit metadata snapshot (writes only the operator checkpoint tables).
ATLAS_PROJECT_KEY_LEDGER_ENABLED=1 npm run files:r2:project-checkpoint -- \
  --capture --project=PROJECT_UUID --confirm=CAPTURE_PROJECT_KEY_MANIFEST

# Read-only checkpoint and catalogue drift status.
npm run files:r2:project-checkpoint -- --status --run=RUN_UUID

# Bounded read-only preview, without receipt or object writes.
npm run files:r2:project-checkpoint -- \
  --dry-run --run=RUN_UUID --project=PROJECT_UUID --max-files=3

# Only after separate approval and recovery-backup verification:
ATLAS_PROJECT_KEY_LEDGER_ENABLED=1 ATLAS_PROJECT_KEY_COPY_ENABLED=1 \
npm run files:r2:project-checkpoint -- \
  --apply --run=RUN_UUID --project=PROJECT_UUID \
  --confirm=CREATE_PROJECT_KEY_COPIES --max-files=3

# Read-only byte re-audit against source and target, paginated by ordinal:
npm run files:r2:project-checkpoint -- \
  --audit --run=RUN_UUID --project=PROJECT_UUID --from=0 --max-files=3
~~~

Status is **metadata-only**. Even **allCopied=true** proves only that all
manifest items have recorded byte-verified copy receipts, NOT that the
independent backup, current live bytes, matching database snapshot or
production cutover have been verified. Audit explicitly re-reads source and
target bytes, including legacy variants with no historical checksum; a
**passed-page** applies only to that bounded page. All pages must be audited,
and catalogue drift must remain absent.

A fresh upload, archive or replaced derivative invalidates the manifest.
Create a new manifest and copy idempotently; occupied version-1 keys with
different bytes fail closed until a separately reviewed new-version plan
exists. Installation or running a default command never performs R2 writes
or cuts over old storage keys. Unified independent R2 recovery and an isolated
matching-PostgreSQL restore (issue #109, Stages 5–6) remain mandatory before
any destructive cleanup, automatic cutover or retention.


## Stage 5/6 — independent Project recovery manifests and isolated checks

Migration 038_project_recovery_manifests.sql adds immutable operator recovery
metadata, separate from the Stage 4 key-copy ledger. A capture checks actual
bytes from native Project Files and all Portfolio originals and derivatives,
including archived assets. Variants have no historical SHA-256, so the
operator reads and hashes each bounded source object before storing the
result. The tool rechecks Project catalogue metadata and fails closed on
invalid, absent, corrupt, oversized or changed sources.

Captures can be **legacy-only** before any Project key-copy migration, or
optionally include every versioned object from a *fully receipted* Stage 4B
run. The latter requires matching catalogue identity, checksum and versioned
source bytes for every item. Captures explicitly say whether versioned copies
were included; a legacy-only capture never certifies unreferenced v1 keys.

The independent R2 seeder uses the persisted manifest, with a maximum of
five objects per invocation. Dry-run is read-only; apply requires a separate
environment gate and an exact confirmation. Source and destination bytes
are both preflighted before any create-only conditional PUT. A corrupt
existing backup is never overwritten, and no source objects or rows are
deleted. Each authorised apply batch persists a transactionally committed
per-object SHA-256/size verification receipt after R2 readback. A separate
read-only --status aggregates all receipt ordinals for the immutable
manifest, so a 6+-object run can report seed completion after multiple
five-object pages. A single page cannot prove earlier coverage. Receipt
completeness means historical verification, **not** that current backup
objects remain intact; isolated R2 GET verification is still required.

The **isolated recovery verifier** reads only the restored database and the
independent recovery-account bucket. It explicitly forbids primary R2 and
primary PostgreSQL environment configuration, and does not load server .env.
It verifies the recovered catalogue fingerprint, persisted manifest SHA-256
and actual bytes of each recovered legacy and optional versioned object.
Passing requires a complete full-manifest invocation; a page is partial.
The verifier has no primary object-store argument or object-write methods.

A verified Project recovery manifest still does **not** prove the archive's
offsite custody, host isolation, Atlas boot, matching DB/R2 quiescence, whole
legacy Workspace/Application Files coverage or a production cutover.
Capture, seed and isolated verification must be explicitly run by a trusted
operator and linked to one separately verified encrypted PostgreSQL snapshot.
See RECOVERY_ACCEPTANCE.md for the manual commands and outstanding gates.


## Stage 7 — read-only versioned-key cutover assessment

This is **operator-only read-only assessment**, not versioned-key activation.
It reconciles the current Project catalogue with three sources of evidence:

- A fully receipted Stage 4B key-copy run covering every Project File and
  Portfolio original and derivative, including archived items.
- A Stage 5/6 immutable Project recovery manifest tied to that *exact* key
  run, covering **both legacy and versioned keys**, with complete independent
  R2 verification receipts.
- An optional bounded byte check of **four objects per catalogue entry**:
  effective primary legacy source (R2/confirmed-missing local fallback),
  primary versioned R2 destination, independent recovery legacy bytes, and
  independent recovery versioned bytes. Hash and size must agree with the
  persisted manifests and copy receipts.

The entire bounded metadata catalogue is reconciled before any R2 read,
but each explicit verify operation reads at most **five** catalogue entries
(20 bounded reads, each capped at 25 MiB). Each successful result describes
only its page; a final page is not evidence that earlier pages were checked.

Operator example (no live cutover or object writes):

~~~sh
npm run build:server

# Default/explicit plan: DB metadata only, no R2 credentials required.
npm run files:r2:project-cutover-check -- \
  --plan --project=PROJECT_UUID --key-run=KEY_COPY_RUN_UUID \
  --recovery-run=PROJECT_RECOVERY_RUN_UUID --max-files=5

# Explicit bounded primary + independent R2 GET verification.
npm run files:r2:project-cutover-check -- \
  --verify --project=PROJECT_UUID --key-run=KEY_COPY_RUN_UUID \
  --recovery-run=PROJECT_RECOVERY_RUN_UUID --from=0 --max-files=5
~~~

When the result has remaining=true, repeat at its nextOrdinal. The report
describes catalogue identity, old/new keys, exact authoritative table,
copy/backup receipt status, bounded byte evidence and any blockers.
Source table identities differ: atlas_files and media_assets use file ID,
whereas media_variants is identified by asset ID plus variant name. Public
Portfolio URLs still depend on stable media IDs, not R2 key paths.

Every result unconditionally reports cutoverAuthorized=false,
noDatabaseWrites=true and noObjectWrites=true. No apply flag, key switch,
automatic backup, deletion, retention, owner reassignment or production
credential exposure is introduced. This does **not** prove PostgreSQL/R2
snapshot atomicity, physical recovery-host isolation or a working restored
Atlas service. Actual reversible cutover needs independent recovery
acceptance, a writer-quiescence boundary, new-upload handling, tested
rollback and separate operator approval before any keys are changed.


## Stage 8 — atomic metadata switch/rollback rehearsal, always rolled back

The code-only follow-up to Stage 7 can rehearse the **full Project-wide**
native Files and Portfolio metadata key transition *on a disposable local
PostgreSQL database*. No production activation path is included. It uses
the exact Stage 4B immutable copy-run metadata and Stage 5/6 independent
recovery manifest, and requires **all** old/new copy and recovery receipts
to match before attempting any temporary SQL updates.

The simulator opens one SERIALIZABLE transaction with short lock timeouts,
locks the three existing authoritative catalogue tables against concurrent
writes, and reconciles the whole current Project manifest. It conditionally
swaps each exact old storage key to its versioned target in the correct
table (atlas_files, media_assets or media_variants), checks each target,
then conditionally swaps each row *back* and rechecks the original catalogue
SHA-256. It **always executes ROLLBACK**, even on a successful rehearsal:
no COMMIT or permanent activation operation exists. No object storage
client is instantiated, and no R2 GET/PUT/DELETE occurs. This avoids
constructing a production cutover path before the independent recovery
drill and approval gates are met.

The operator CLI does **not** load the server .env or accept DATABASE_URL.
It requires an explicitly supplied local disposable database URL named
atlas_cutover_rehearsal (optional suffix), the independent environment
gate and the exact simulation-only confirmation. Never run the command on a
production host, a production DB port-forward, or a production-derived
snapshot containing secrets. The hostname and database-name checks are
defence in depth and cannot prove host isolation. The engine additionally
checks, **before BEGIN or table locks**, that PostgreSQL resolves the
authoritative atlas_files, media_assets, media_variants tables, the Project
storage view, and the required Project key/recovery manifest and receipt
tables **inside the selected disposable schema**. A similarly named but
empty test schema prepended to public must fail, even if current_schema()
returns its name. Within the transaction the search_path is restricted to
pg_catalog, that verified schema, then pg_temp; no fallback to public is
allowed. A regression test covers this exact name-resolution pitfall.

~~~sh
# On an isolated, disposable database restored with matching manifests:
npm run build:server

ATLAS_CUTOVER_REHEARSAL_ENABLED=1 \
ATLAS_CUTOVER_REHEARSAL_DATABASE_URL=postgresql://localhost/atlas_cutover_rehearsal \
npm run files:r2:project-cutover-rehearsal -- \
  --simulate --project=PROJECT_UUID \
  --key-run=KEY_COPY_RUN_UUID --recovery-run=RECOVERY_RUN_UUID \
  --confirm=SIMULATE_PROJECT_CUTOVER_ROLLBACK
~~~

An all-passed report demonstrates only that these existing SQL table shapes
support the reversible, atomic metadata swaps under the tested snapshot
conditions. It does not demonstrate that an actual live write freeze is
practical, that the latest production objects remain healthy, or that
Atlas can restore from independent backup. Stage 7 read-only R2 checks
and the independently isolated PostgreSQL/R2 recovery drill are separate
requirements. The next approved cutover design must address new uploads,
post-cutover recovery manifest semantics, live application reads, old/new
URL behavior, source retention and independently observed rollback.
No retention, owner reassignment or source-key retirement is implemented.


## Stage 9 — isolated legacy-owner recovery coverage

The earlier Project/Portfolio immutable recovery manifest deliberately excludes
legacy Workspace/Application-owned rows in atlas_files. The new operator-only
recovery-only verifier reads those remaining active **and archived** Files
from an isolated restored PostgreSQL database and verifies every referenced
object against the *independent* recovery R2 account using bounded reads,
exact checksum/size comparison, and a before/after metadata fingerprint.
It never reads primary R2, never falls back to local Files and has no write
method. Zero legacy rows produces an explicit empty result, not a positive
verification claim; more than 2,000 records is incomplete and must not be
presented as comprehensive.

Use the environment-isolated command and acceptance interpretation in
RECOVERY_ACCEPTANCE.md. This complements, but does not replace, each
Project's independent Project/Portfolio verification, the encrypted DB
snapshot drill, Atlas boot/read testing, and a coherent DB/R2 recovery point.
No cutover, existing owner conversion, Node privilege change, source
retention or cleanup is included.


## Stage 10 — all-owner recovery-only coverage orchestration

After merging #179, Project/Portfolio manifest verification and archived
Workspace/Application Files verification both exist independently. The
operator-facing all-owner suite now discovers all Projects represented in the
restored database's Project storage view, requires one exact Project recovery
run ID for each (no automatic latest-run selection), and independently GETs
all their recovery-manifest objects, alongside the complete legacy-owner
inventory. It checks the full Project catalogue again after reads and
refuses missing/extra Projects, duplicate runs, corrupt/missing bytes,
truncated inventory or unacknowledged empty owner groups. Read-only R2
and restored-DB SELECT access only.

The suite is bounded to 25 Projects, **1,000 total Project/Portfolio source
objects** and 2,000 legacy Workspace/Application Files. An immutable
Project recovery manifest can contain both original and versioned entries
(up to 2,000 manifest entries for 1,000 source objects). The lower-level
key-ledger/recovery limits are unchanged. Going beyond 1,000 Project/Portfolio
source rows requires a separate reviewed capacity extension; the suite fails
before R2 GET rather than claiming unreachable coverage. The report field
`projectEntriesVerified` is the number of SHA-256-verified recovery manifest
entries, **not a byte count**. A verified object-scope
report is deliberately not disasterRecoveryReady, production cutover
approval or replacement Atlas application readiness. See
RECOVERY_ACCEPTANCE.md section 10 for command, acceptance and separate
offline custody/restore requirements.
