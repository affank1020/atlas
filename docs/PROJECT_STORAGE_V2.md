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

Migration `034_project_portfolio_catalog.sql` adds the
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
