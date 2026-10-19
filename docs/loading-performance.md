# Loading and PostgreSQL read architecture

## Confirmed causes and changes

The old startup mounted no application UI until `list_projects` and three reads per active project completed. Its skip action stopped the queue. `AppBootstrap.tsx` now mounts `App` immediately; the sidebar owns its project-list subscription, and each route owns only its required queries. Application deep links keep their dedicated header and back navigation, request their manifest independently, and load their interface bundle on demand. No global prefetch queue or skip state remains.

Project sections already had selective queries; these are retained. Sidebar errors have a local Retry action. Store and View initial loading/error states stay local. `App.tsx` no longer explicitly refetches records/project/store queries immediately after mutations that already invalidate them.

`atlasApi.ts` remains the only server-state cache. Session retention is unchanged (`Infinity`), and omitted/false `includeArchived` arguments share keys. Archived-inclusive queries intentionally use distinct keys. Store and View detail subscriptions now depend on their parent project, so project archival invalidates mounted details. Editing one View does not invalidate sibling View renders. Unsubscribed invalidated entries are discarded by RTK and fetch on the next visit; unaffected entries remain for the session.

Application manifests, Portfolio content/media/revisions, and View history now use RTK Query. Ask Atlas and Fabric share the sidebar's project-list query. Portfolio writes invalidate the Portfolio group, including upload and revision restore. Football's top-level resources use the shared cache for request deduplication and immediate cached display on revisit, **but force fresh reads on entry and on the existing 10-second refresh**. Status-ticket polling, Node/workspace operations, job control, ad-hoc queries and unsaved View previews remain explicit live/operational requests. No new polling or persistence was added.

`AtlasRepository` has optional targeted catalogue, count and audit read capabilities. PostgreSQL implements them; repositories implementing only `snapshot()` retain compatibility. The sparse catalogue result contains projects and requested stores/View definitions, with empty records/audit arrays; it must never be used as a transaction draft. Existing service validators preserve NOT_FOUND messages, ownership and archived visibility. Invalid entity IDs become unmatched SQL parameters rather than PostgreSQL cast errors.

Catalogue reads no longer load records/audit payloads. Store reads join only the current schema version. Counts use one statement for a consistent set of active/archived/total counts. Audit predicates and limits run in SQL, with timestamp descending/ID ascending ordering matching the original stable snapshot ordering. Empty record pages at a nonzero offset now use a count-only query.

View rendering and previewing read only their project's schema/definition metadata and bounded query results. Standalone rendering resolves the definition once. Independent queries run in batches of four; bindings and diagnostics are assembled in declaration order. Existing limits, validation, sandbox/CSP and transactional record-action semantics are unchanged. Preview cards request renders only within 160 px of the viewport; environments without IntersectionObserver fall back to immediate rendering.

## Measurements

Local PostgreSQL, disposable schema, one project/store/View, 10,000 synthetic records and 2,000 additional audit events with 500-character payloads. Planner statistics were refreshed with ANALYZE. Each path was warmed once and then measured 15 times, alternating old/new. Values are medians, including database transfer and JavaScript mapping. The old path uses the snapshot compatibility repository; standalone baseline also repeats the definition lookup, matching the old HTTP path.

| Operation | Snapshot path (ms) | Targeted path (ms) |
| --- | ---: | ---: |
| list_projects | 48.23 | 0.59 |
| get_project | 48.09 | 0.58 |
| get_atlas_status | 47.78 | 1.89 |
| project audit, limit 50 | 49.88 | 1.37 |
| standalone View, one query | 115.18 | 11.97 |

Reproduce with `node --import tsx scripts/benchmark-catalogue.ts`. It uses the same isolated schemas as the integration suite and removes them afterwards. `TEST_DATABASE_URL` overrides the local default. Do not point benchmarks at production.

The original six bootstrap tests were rerun from the pre-change source: a fixture with two active projects issued seven requests **before mounting the shell**. The replacement deep-link test issues only three requests (sidebar, selected project, selected store list), while the sidebar request remains unresolved and both global/project navigation are already mounted. These are controlled request-count/behavior checks, not measured browser wall-clock speedups. Revisits and explicit refresh are covered by cache tests, including a three-hour simulated interval without subscribers.

An intermediate production build before application code splitting had a 511.12 KB main JS bundle (152.38 KB gzip). After splitting, the main bundle is approximately 427 KB (131 KB gzip), with Portfolio and Football loaded separately. This comparison isolates bundle splitting; it is not a measured cold-load latency improvement.

Actual VPS cold reload, application usability, and browser standalone-View latency have **not** been measured. No production latency claim is made.

## Development diagnostics

- DevTools: `window.atlasPerformance` exposes `networkRequests`, `queryStarts`, and `cacheReuses`. The last counter includes RTK in-flight deduplication/condition skips, not just fulfilled-cache hits. Network requests count actual tool HTTP attempts, including errors.
- `performance.getEntriesByType('measure').filter(x => x.name.startsWith('atlas:'))` exposes shell commit since navigation start and selected route readiness. Project/store/View-editor markers cover essential data; application-manifest is explicitly separate from Portfolio/Football usability. Route measurements share the route-entry timestamp, including manifest and lazy-module delay. They are data/React-commit milestones, not paint or interaction traces. Operational routes without a marker can still be inspected in Network/Performance panels.
- Start the server with `ATLAS_PERFORMANCE=1`. JSON log entries report `tool.*` for HTTP/MCP dispatch, `postgres.acquire`, SQL operation durations, `view.query`, `view.render` and `view.standalone`. Durations include failed operations. No arguments, SQL text, IDs, record contents or credentials are logged. Disable the variable for ordinary production operation.
- For real browser comparisons, use the same data/server/network throttling, clear the session for each cold run, and repeat home/project/application/standalone and cached revisits. Record DevTools Network counts, route measures and matching server durations. Explicit Refresh is a distinct scenario.

## Verification

- Frontend: 113 tests pass, including blocked-sidebar deep links, cache deduplication, session retention, refresh, scoped invalidation, application routing, View editor/host and deferred preview requests.
- Backend: 190 tests pass against disposable local PostgreSQL schemas. New tests compare targeted and snapshot contracts, prohibit fallback snapshots on normal reads, check archived/invalid-ID boundaries, verify bounded concurrent View reads, and exercise concurrent writes under the existing transaction lock. Existing security, View actions, rollback, schema evolution, HTTP and MCP tests remain in the suite.
- `npm run build` passes protocol, View runtime, server, Node and frontend TypeScript/build checks and the Vite production build.
- `git diff --check` passes.

## Remaining bottlenecks and migration plan

No indexes were added without representative evidence. Existing primary/project/store/View/audit indexes cover the new predicates. On this fixture, EXPLAIN for bounded project audit history uses `audit_events_created_at_idx` plus incremental sort. Production audit distributions may justify `(project_id, created_at DESC, id)` or equivalent store/View composites; first collect EXPLAIN (ANALYZE, BUFFERS) for representative workloads and account for write overhead.

Writes deliberately retain the global advisory transaction lock, full snapshot/draft clone, and existing writeback. In particular, unchanged projects/stores still receive UPDATE statements. Changing locking and partial state together would risk lost updates, schema/record inconsistencies and incomplete cascading archives. Recommended separate migration:

1. Add explicit repository commands for each write, starting with single-record create/update/archive; keep the old path available during rollout.
2. During coexistence, all targeted writes must acquire the same advisory lock as legacy transactions. Use one transaction for parent/schema checks, record mutation and immutable audit insertion. Preserve optimistic View timestamps and schema-version rules.
3. Add parity/failure-injection tests and real concurrent transaction tests for bulk rollback, uniqueness, schema migration vs record writes, project/store cascading archive, View actions and audit atomicity.
4. Migrate all writers (including applications/integrations). Only then replace the global lock with a documented consistent row-lock order and constraint/retry strategy. Removing the lock while legacy whole-dataset writers remain would allow stale writeback to overwrite targeted changes.
5. Roll out with lock-wait/query-duration metrics and a fallback flag; verify backup/restore and rollback behavior before removing compatibility writes.

Other remaining costs: some specialized application backend operations and `get_record` still use snapshots; broad application writes still inherit the legacy write cost; record pagination uses window counts and JSONB filters; a View currently loads all schemas in its own project to validate queries/actions; activity, status and operational detail components retain fresh reads. Session caches can grow during long sessions, especially parameterized View renders; no TTL was introduced. Profile these independently before changing their freshness or consistency contracts.
