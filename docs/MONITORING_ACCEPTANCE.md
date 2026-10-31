# Monitoring post-merge acceptance matrix

This is a **checklist**, not evidence of a live VPS/browser acceptance test. Apply to the deployed revision after migrations and record results before closing Atlas #110.

| Area | Required acceptance | Evidence |
| --- | --- | --- |
| Project scope | A Project's Activity cannot be replaced by a forged Project ID in its URL; no events from unrelated Projects | Project Activity and PostgreSQL tests |
| Logical Workspace | Archived and multi-Node checkouts resolve through current logical membership; do not claim historical membership reconstruction | Workspace integration tests and manual two-Node drill |
| Node / sharing | Only appropriate sender/recipient Node events appear; unrelated Nodes excluded | Monitoring Activity Node tests |
| Store scope | Project and Store are both preserved by deep links; Store revision history remains separate | StoreActivityLink and browser tests |
| Correlation and pagination | Operations group before filtering/paging, failure evidence wins and counts remain bounded | monitoring-activity tests |
| Privacy | No raw previous/after snapshots, output, free-text errors, file paths or credentials in safe reads | monitoring-safe-details and projection tests |
| Runtime diagnostics | Current Server process ring stores only fixed codes, max 100 on read | server-diagnostics tests |
| Server history | Fixed codes survive restart, 14-day read window, missing database is unavailable and gaps remain possible | server-diagnostic-history tests, deployed restart drill |
| Files and folders | New metadata changes appear under Files with database-derived Project/checkout scoping; rolled-back changes create no audit; no names, keys or contents | monitoring-files-backup tests and Web/Node transfer checks |
| R2 recovery seeding | Manual run ID and bounded outcomes visible; thrown reads/PUTs emit redacted aborted/inconclusive evidence if database is available; empty runs and aborts are failed, never completed | monitoring-files-backup tests, interrupted-upload injection and manual CLI drill |
| Host PostgreSQL backups | Check encrypted snapshot and sidecar outside Atlas; never claim central audit or tested restore from manifest alone | Operator-only verification; not proven by CI |
| Automation | No new Server scheduler is implied; existing Workspace task audit is separately scoped | Explicit capability inventory; test when a scheduler is introduced |
| Node technical logs | Fixed approved sources, bounded lines and bytes, no arbitrary journal/path selection | node-logs and linux-journal tests |
| Health | Failed database degrades, missing registry is unknown, stale/future heartbeats never show healthy | monitoring-health tests |
| Live activity | Manual by default; no polling hidden tabs, overlap, burst retries or stale scope replacement | Monitoring.live tests |
| Operational | Check migrations, retention, monitoring privileges, node journals, replicas, container boundaries, narrow screens and failure recovery | Deployed operator drill; **not proven by CI** |

## Source semantics

- `read_server_diagnostics` is an in-memory, current-process fixed-code ring.
- `read_server_diagnostic_history` is a best-effort PostgreSQL read of at most 100 recent fixed-code events from the last 14 days. Writes are asynchronous and bounded. Database failures or full queues can lose events; the current process reports `droppedSinceStart`, but losses in previous processes cannot be recovered. The response therefore reports `coverage: incomplete-possible`.
- This is **not** Docker stdout/stderr, full application logs, distributed tracing, immutable audit history or evidence that a silent period was healthy. Scoped activity still uses `audit_events`.
- The archive uses a separate pool of one bounded connection, a maximum 128 queued events, batches of 32, failure backoff and incremental expiry. Read queries enforce the 14-day age window even if cleanup is delayed.

## Disposable test commands

```sh
npm ci
npm run build
node --import tsx --test test/server-diagnostics.test.ts test/server-diagnostic-history.test.ts test/monitoring-health.test.ts test/monitoring-activity.test.ts test/monitoring-safe-details.test.ts test/monitoring-files-backup.test.ts
npm run test:web
```

Production migrations and live operational tests require the approved deployment workflow. Do not mark this checklist complete from CI alone.
