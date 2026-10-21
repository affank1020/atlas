# Atlas Files — shared object storage and private browser

## Foundation (merged in PR #25)

- `apps/server/src/server/file-storage.ts` is the shared byte/object adapter,
  supporting local storage and optionally private Cloudflare R2.
- `apps/server/src/server/atlas-files.ts` stores Files metadata in PostgreSQL
  (`018_atlas_files.sql`) and enforces owner-scoped reads, downloads and archives.
- A file belongs to exactly one project, workspace or application. Owner IDs and
  object keys are validated and storage keys are generated only by the server.
- Existing Portfolio media remain separate: public `/api/media/:id/:variant`
  routes, processing, metadata, SQL and legacy-local fallback are unchanged.

## Private Files HTTP API and UI (this worktree)

- `#/files` is the Atlas Web Files browser. It lists existing projects,
  workspaces and applications, and lets the admin upload, download and archive
  their private files, with per-owner search and skeleton loading states.
- The endpoints `POST /api/files/{list,upload,download,archive,restore}` accept JSON
  with `owner: { kind, id }`. Upload uses `{ fileName, mimeType, base64 }`;
  download, archive and restore require `fileId`. List accepts optional
  `status: 'active' | 'archived'` (default `active`).
- These routes are deliberately **not MCP tools**, and are **not public Portfolio
  routes**. Production /api/files/* is covered by Caddy's existing admin Basic
  Auth, and Atlas Server is bound to the container network and VPS loopback,
  not exposed directly on a public port. Do not add /api/files/* to the public
  Caddy matcher. Outside the single-admin deployment, add application-user
  sessions/permissions before enabling these routes.
- The server checks that the requested project, workspace or application exists
  and is active, then AtlasFilesService scopes every file query to that owner.
  There is one administrative identity for all owners, not tenant-based access
  controls. File IDs cannot be used to read another owner's objects.
- Only the **private** visibility can be created through the API, regardless of
  submitted JSON. Downloads are attachments with `application/octet-stream`,
  `no-store`, `nosniff` and a restrictive CSP. The responses never include
  object keys, R2 credentials or raw bucket URLs.
- Non-approved browser origins, opaque-origin sandboxed Views and cross-site
  POSTs are denied. For local Vite live development, only explicitly allowed
  `ATLAS_WORKSPACE_ORIGINS` receive non-wildcard CORS.
- The Web browser now uploads raw bytes with `POST /api/files/upload-binary`
  (`application/octet-stream`). This removes base64 transfer overhead and avoids
  `FileReader`'s full-file encoded copy. Ownership, percent-encoded file name,
  and MIME type travel in `X-Atlas-Owner-Kind`, `X-Atlas-Owner-Id`,
  `X-Atlas-File-Name`, and `X-Atlas-File-Type` headers. The server independently
  validates all metadata, owner existence and private visibility.
- Existing `POST /api/files/upload` JSON/base64 clients remain supported.
  Both paths are **limited to 25 MiB** per file. Server memory still buffers the
  bounded upload; this is **not yet resumable, multipart or direct-to-R2**.
  Multiple selected files are transferred sequentially.
- File downloads verify both the stored byte count and SHA-256 checksum
  before returning bytes. A missing or altered object fails closed rather
  than delivering an incomplete screenshot or document.
- `OPTIONS /api/files/*` now returns only approved, narrow-origin CORS
  responses, including the binary-upload headers. Private endpoints stay
  behind the same Caddy admin authentication.
- Development without Cloudflare keys stores the new Files bytes in the
  configured `ATLAS_MEDIA_DIR`. When all four existing `ATLAS_R2_*` variables
  are set, new Files uploads use the configured private R2 bucket.

## Archive recovery (PR follow-up)

- Atlas Files now offers an **Active / Archived** filter scoped to the same
  project, workspace or application. Archive retains PostgreSQL metadata and
  original bytes; archived entries are not directly downloadable.
- `POST /api/files/restore` reactivates only an archived file belonging to
  the specified active owner. It reads and verifies the retained object's byte
  length and SHA-256 checksum **before** restoring metadata. Missing or corrupt
  bytes cannot be restored. This works with existing local storage and R2's
  configured local fallback.
- Restore does not expose files, delete bytes, or bypass admin authentication.
  Multiple files with the same name remain independently addressable by ID.
- **No automatic purging or expiry is enabled.** Before adding destructive
  garbage collection, establish and test off-site backups, database/object
  reconciliation, a minimum retention period, and a dry-run operation.

## Native Node upload foundation (opt-in)

- `POST /node/files/upload` accepts one binary file from an enrolled Atlas
  Node. It is **disabled by default** (`ATLAS_NODE_FILES_ENABLED=false`)
  and does not grant access to any other Files API operation.
- This endpoint is deliberately outside Caddy's *human* Basic Auth, like
  `/node/connect`, but it **requires** the existing per-Node Bearer credential.
  Browser Origin headers are denied; no CORS is provided. The Server validates
  the credential **before reading upload bytes**, then rechecks the active
  credential and Workspace placement in a database transaction before saving.
- Required request headers: `Authorization: Bearer <Node credential>`,
  `Content-Type: application/octet-stream`, `X-Atlas-Node-Id`,
  `X-Atlas-Workspace-Id`, `X-Atlas-Upload-Id` (stable UUID),
  `X-Atlas-File-Name` (percent-encoded), and `X-Atlas-File-Type`.
  The body is raw bytes. Success returns `{ file, replayed }`.
  A new upload returns HTTP 201; an exact retry returns HTTP 200.
- A Node can upload **only to a currently active Workspace assigned to it**.
  Projects, applications and other Nodes' Workspaces are not valid targets.
  Files remain private, and every upload is capped at 25 MiB.
- Retries must reuse the original upload ID. A durable PostgreSQL receipt
  prevents duplicate Files records when the response to an earlier success is
  lost. Reusing an upload ID with different bytes, metadata or Workspace is
  rejected with HTTP 409. Receipt IDs are scoped per Node. A transaction-scoped
  receipt lock precedes the Workspace quota lock to serialize concurrent
  uploads even across multiple Workspaces on the same Node.
- Node-initiated uploads have a conservative **1 GiB lifetime cap per Workspace**,
  including archived files, so uploads cannot silently exhaust the VPS.
- On object-store or metadata failures, Atlas attempts idempotent deletion of
  the uniquely generated, uncommitted object. If receipt insertion or COMMIT
  fails after the object PUT, Atlas first rolls back and checks the durable
  Files metadata on an independent database connection before deleting. If
  it cannot prove the object is uncommitted, Atlas deliberately retains the
  bytes and logs a cleanup warning rather than risk destroying a committed
  file. Both local storage and R2 support signed object DELETE.
  Regression tests inject SQL failures after the PUT.
- **Crash safety is not yet complete.** Sudden power loss, ambiguous remote
  writes, or an unavailable object store can still leave untracked bytes;
  physical object reconciliation and backups remain necessary before
  switching this feature on in production.
- `apps/node/src/core/file-transfer.ts` provides a transport primitive for
  future desktop/mobile capture queues. The native client must persist the
  upload UUID until the server acknowledges it and retry with the same UUID.
  Non-local Node HTTP transfers require HTTPS.
- The one-shot route still sends a complete file. A separate resumable
  protocol is described below; persistent mobile offline queues, retry
  scheduling, R2 backup/recovery and production enablement remain future work.

## Mobile-node readiness

- Screenshot and document bytes now have a binary transport that mobile and
  desktop browsers can use with less overhead. **Native mobile Nodes cannot
  call the admin-only Files HTTP endpoints with Node credentials.** A reviewed,
  per-Node authenticated transfer route with explicit destination-owner
  authorisation is required before mobile Nodes can upload directly.
- Native mobile uploads should support resumable/chunked transfers, idempotent
  retries, bounded concurrency and device offline queues, especially for large
  photos/videos and changing network conditions. Do not copy Caddy admin
  credentials onto Nodes or expose private Files endpoints publicly.
- Before depending on R2 for mobile assets, configure R2 privately and verify
  live round-trip upload/download, storage metrics, backup and restore.

## Resumable native Node transfers (feature-flagged)

- `POST /node/files/resumable/{init,status,chunk,complete,abort}` accepts
  authenticated native Node requests only; all routes use the existing
  `ATLAS_NODE_FILES_ENABLED` gate (default **off**), Node bearer credential,
  active assigned Workspace check, and no CORS. The original one-shot route
  remains supported.
- A caller persists a stable upload UUID and SHA-256 of the **entire** file.
  `init` reserves a transfer for one Node and one Workspace, including
  immutable filename, MIME type, byte length and checksum. `status` returns
  received chunk indexes; the native Node helper sends only missing 1-MiB
  chunks, each authenticated and SHA-256-verified. A duplicated chunk with
  different data conflicts rather than overwriting saved bytes.
- Checkpoints are stored as PostgreSQL `bytea` rows in
  `node_file_transfer_parts`, not temporary R2 objects. This makes
  interrupted transfers recoverable across server restarts and replicas,
  with a strict **25 MiB** file limit and **64 MiB active staging reservation**
  per Workspace. Actual database/WAL usage can exceed raw byte totals.
- `complete` requires all chunks and re-verifies the whole-file checksum.
  It durably claims the session, **releases its PostgreSQL client**, and only
  then invokes Node ingest (1 GiB retained-data quota, private Files object,
  receipt-based idempotency). Final checkpoint recording uses a fresh
  transaction, avoiding connection-pool deadlocks with concurrent completions.
  A crashed finalizer can be reclaimed after a 10-minute claim lease, and
  the existing ingest receipt deduplicates retries. Temporary chunk rows
  are removed on success; a duplicate completion returns the same file ID.
  `abort` explicitly frees staging for unfinished active transfers.
- Updating a Workspace's Node assignment, archived timestamp, or status
  transactionally removes unfinished checkpoints and their chunk bytes via
  a database trigger, even when the old Node can no longer authenticate.
  Completed Files and receipts are unaffected.
- Active transfers do not automatically expire. Lost/abandoned sessions
  can exhaust the 64 MiB staging allowance until explicitly aborted, except
  when their Workspace is moved/archived. A stalled `finalizing` claim can
  be retried after 10 minutes, but cannot clean itself without a retry.
  Add a reviewed expiry/reconciliation policy before production enablement.
  There is **no background queue, retry scheduler or automatic garbage
  collection** in this PR. Client storage of upload UUID and original bytes
  remains the responsibility of the future native mobile offline queue.
- These PostgreSQL checkpoints are intended for bounded screenshots and
  documents, not large videos or high-volume media. Larger assets should
  eventually use an explicitly reviewed, protected R2 multipart protocol.
- Continue to keep `ATLAS_NODE_FILES_ENABLED=false` in production until
  reviewed R2 backup/restore and end-to-end native-node security testing.

## Operator maintenance for abandoned resumable checkpoints

- Build the server (`npm run build:server`) and run
  `npm run files:staging:maintenance` on the trusted server host.
  **This defaults to a read-only dry run.** It reports stale active checkpoint
  counts, reserved payload bytes, and actual staged chunk bytes. Stale
  `finalizing` sessions are separately reported **but never deleted**.
  No personal file contents, Node credentials or object-store secrets are
  exposed.
- A checkpoint becomes eligible after **seven full days without a successful
  chunk write or a transfer-state update**. A new `init`, received chunk or
  finalization claim updates `updated_at`; merely reading status does not
  silently extend retention. This interval cannot be shortened by the CLI.
- Cleanup is a **separate, explicit operator action**:
  `npm run files:staging:maintenance -- --apply --confirm=DELETE_STALE_NODE_CHECKPOINTS`.
  It removes **at most 25 sessions** per invocation by default; operators can
  set `--max-sessions=1..100`. The batch limit is enforced inside the
  service. No scheduled job, API route, MCP action or Atlas Worker is added.
- The apply transaction rechecks the age and `active` state under PostgreSQL
  `FOR UPDATE SKIP LOCKED` row locks. Concurrent chunk writes or completions
  cannot lose their checkpoints halfway through a transfer; rows already
  locked by another transaction are skipped. Only selected
  `node_file_transfer_sessions` rows and their `ON DELETE CASCADE`
  `node_file_transfer_parts` bytes are deleted. In the **same transaction**,
  Atlas inserts a tiny persistent `node_file_expired_upload_ids` tombstone
  containing only the Node UUID, upload UUID and expiry time. It retains no
  filename, checksum, Workspace, Node secret or chunk bytes. The transaction
  rolls back entirely if writing the replay fence or deleting a checkpoint fails.
- **Not a general Files garbage collector:** this command never touches
  committed `atlas_files` records, completed upload receipts, archived files,
  R2/local object bytes or backups. Once an upload's checkpoints have
  expired, **all retries of that Node-scoped upload UUID receive HTTP 409**,
  including identical metadata and attempts via the one-shot endpoint.
  The device must start a new transfer using a **new upload UUID**.
  Tombstones are retained indefinitely to preserve the identity contract
  for arbitrarily delayed offline retries; monitor their small but growing
  PostgreSQL row count. An old `finalizing` row could represent an
  ambiguous successful PUT and must be investigated/retried rather than
  automatically deleted.
- Operators should review the dry-run report and the production database
  backup before any `--apply`. This adds a safe manual cleanup primitive,
  not a production-ready unattended expiry policy. Node file uploads remain
  disabled until live R2 and recovery verification are completed.

## Encrypted offline Node upload queue (desktop / headless Nodes)

- The macOS and Linux Node now have an **opt-in** durable local queue.
  It is **disabled by default** with `ATLAS_NODE_FILE_QUEUE_ENABLED=0`.
  Turning it on in a Node alone does not enable server uploads; the separate
  Atlas Server flag `ATLAS_NODE_FILES_ENABLED` remains **off by default**.
- The local Node CLI provides explicit admission of a selected file only:
  `npm run build:node`, then
  `npm run files:node:enqueue -- <workspace-uuid> <file-path> <MIME-type> [display-name]`.
  Inspect aggregate counts with `npm run files:node:queue-status`.
  With the queue enabled, the desktop Node flushes up to four jobs serially
  after authenticated WebSocket registration and once per minute while online.
  No Node RPC, webhook, browser request or folder watcher can enqueue data.
- Selected payloads and file names are stored in authenticated
  **AES-256-GCM encrypted** queue records, in a `0700` directory with `0600`
  files beneath the Node's local status directory (Application Support on
  macOS, XDG state on Linux). Encryption keys derive via HKDF from the
  existing enrolled Node credential and Node ID; **credentials and keys are
  never written to queue files**. Credential rotation/loss makes queued
  content unreadable, not recoverable by falling back to plaintext.
- The queue is bounded to **8 pending files, 128 MiB encrypted disk bytes,
  25 MiB per file**. Admission uses an exclusive short-lived producer lock and
  file-sync plus atomic rename; an interrupted writer may leave a hidden
  temporary file that requires operator inspection. A stale `.enqueue-lock`
  must be reviewed and removed manually, never automatically stolen.
  There is no multi-process upload-worker lease: run only one Node service
  instance per queue directory. Avoid filesystem backups of these private
  capture bytes unless appropriately encrypted and retention-controlled.
- Every job retains its original UUID and bytes through network failures and
  process restarts. The existing authenticated resumable HTTP protocol reports
  received 1-MiB chunks, so retries resend only missing chunks. Transient
  errors get exponential retry backoff from 30 seconds to 1 hour, persisted
  across restarts. HTTP 400/401/403/404/409/413/507 pause delivery for manual
  inspection rather than looping on denied/expired IDs.
- A blocked upload is *never* silently re-identified: check Atlas Files and
  server receipts first to avoid duplicating an ambiguously completed upload.
  Only with explicit operator action, run
  `npm run files:node:queue-restart -- <upload-uuid>` to issue a new UUID;
  `npm run files:node:queue-discard -- <upload-uuid>` discards the
  encrypted local copy. Neither command removes remote Atlas Files.
- **Android is not integrated here.** The current Android app has no
  authorized binary-send workflow, and its future offline queue must use
  Android Keystore and scoped app storage rather than reuse Node.js
  filesystem/credential-handling code. This PR does not add permissions,
  auto-capture, or background work to Android.
- This is not a production-enablement PR. Live R2 roundtrip, backup and
  restore verification remain prerequisites.

## Safe inventory reconciliation — read-only

- Build the server once (`npm run build:server`), then run
  `npm run files:audit` from the trusted server host/container. The compiled
  CLI also accepts `--dry-run --max-objects=N` with 1–5000 objects **per
  source** (default 2000). The command requires the normal server
  `DATABASE_URL`, `ATLAS_MEDIA_DIR` and optional `ATLAS_R2_*` secrets,
  but does not expose a public HTTP/MCP endpoint.
- This is an **inventory-only** audit. It lists only server-generated
  `files-<id>-<checksum>` object keys from local storage and (when configured)
  private R2. It compares each scanned key against all committed
  `atlas_files` rows, including archived entries. It reports referenced,
  recent unreferenced and **possible orphan** counts and byte totals.
- A fixed 24-hour grace period excludes recent unreferenced objects from the
  orphan candidate category. Every report contains a `truncated` flag for
  each source; a limited or failed scan must never be treated as complete.
  **A missing or unmounted local storage root aborts the entire audit** instead
  of reporting a clean, empty scan. An existing but empty directory is valid.
  R2 unconfigured is shown explicitly rather than silently considered empty.
  Reports include at most 25 sample keys per source; they never include file
  contents, Node credentials or R2 tokens.
- R2 discovery uses signed, read-only S3 ListObjectsV2 requests with bounded
  page sizes. Keys matching the broad `files-` LIST prefix but not Atlas's
  exact generated file-key format are skipped, including older or unrelated
  objects. LIST page accounting still includes these keys; page-budget
  exhaustion aborts the audit rather than claiming a complete scan.
  **These are billable Class A operations**, so the scan must be
  run manually rather than on every dashboard refresh. At the default scan
  limit there are at most three list requests; maximum is six.
- **This code cannot delete objects.** Candidate status is advisory, not
  authorization for deletion. Upload races, ambiguous writes, backups and
  restore timing must be addressed by a separate reviewed two-phase
  reconciler and verified backups before any destructive cleanup policy.
- No scheduled job, automatic deletion, production flag changes or R2
  credential modifications are included.

## Limitations and further work

- Archive and restore update PostgreSQL metadata only. They **do not delete bytes** from
  R2 or local storage. There is no retention timer, physical garbage collection,
  automatic backup, quota enforcement or per-owner storage billing yet.
- No public CDN delivery, presigned uploads or client-side R2 credentials.
  Public assets must be separated from private Files before a public R2
  hostname or CDN is enabled.
- Portfolio's existing media rows are not automatically migrated into the
  generic Files catalogue.
- Cloudflare GraphQL Analytics integration is independent of the R2 S3 keys.
  `ATLAS_CF_ACCOUNT_ID` and `ATLAS_CF_ANALYTICS_TOKEN` remain optional
  read-only inputs to Data page storage metrics.
