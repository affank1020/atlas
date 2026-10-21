# Monitoring audit and phased architecture

Audit baseline: Atlas `main` (2026-10-21, commit `093d780`). This document records known source limitations, rather than treating a currently missing adapter as healthy.

## Existing sources

| Source | Implementation | Status and intended location |
| --- | --- | --- |
| Core changes / store revisions | PostgreSQL `audit_events`; `get_audit_history`, `get_recent_activity` | Authoritative immutable structured changes; Monitoring Activity |
| Workspace / git / dev requests and outcomes | Same audit table, attempt IDs in `after_state` | Keep request/result grouping; Monitoring Activity |
| Project Overview and Activity | `ProjectOverview.tsx`, `ActivityFeed.tsx` | Duplicate large feeds; replace Overview with small scoped preview (phase 2) |
| Store audit history | `StoreAudit` in `App.tsx` | Keep revision evidence until scoped replacement has feature parity |
| Node recent activity | `NodeIdentity.activity` queries `after_state.nodeId` | Not a separate audit database; metadata association differs from `workspace_id` |
| macOS Node logs | `node-logs.ts`, approved `node.log` / `node-error.log` | Read-only 256 KiB scan, <=200 lines, <=48 KiB redacted output |
| Linux Node logs | systemd journal for `atlas-node` | Existing file-tail capability is not available on Linux; requires dedicated fixed-unit adapter |
| Atlas Server logs | production process / container stdout | No approved read API; requires fixed-service adapter and authorization |
| Application output | Football Training trainer consoles and per-run output | Remains inside its application; dispatch and infrastructure failures belong in Monitoring |
| Global search | Node log action, activity shortcut and node links | Route operational searches to Monitoring as sections gain parity |

## Known gaps and boundaries

* A 200-row newest-first fetch followed by browser-only filtering misses older matches and creates false empty states. Monitoring now queries the audit table before applying a bounded page.
* Historical audit entries contain a checkout-style `workspace_id`; do not equate this with a logical Workspace spanning multiple Nodes. Future workspace query support should join the V2 logical workspace mapping without rewriting the original audit.
* Attempt correlation is historically encoded inside `after_state`; request/result pairs can straddle page boundaries. Later correlation work must group deterministically in the backend before paginating *presented operations*.
* Failures recorded as `workspace.mutation_failed`, unsuccessful development runs, and explicit outcome fields are distinct from pending requests. Unknown/incomplete operations must not be described as successful.
* Audit payload snapshots can contain data fields. Respect the existing Atlas authentication boundary, avoid serializing credentials in new diagnostic emitters, and implement a bounded server-side safe-detail projection before widening operator access.
* The macOS log adapter redacts known token patterns and refuses paths/symlinks; it does not guarantee full retention or universal redaction. Logs remain bounded tails, never archive evidence.
* Node lifecycle is partly in audit rows (via `NodeIdentity`), but not all runtime events have a complete project / Node association. Do not imply comprehensive event coverage.
* Linux journal and Server process logs require an allowlisted service/unit, fixed bounds, redaction and explicit read permissions. No shell, arbitrary paths, or caller-selected journal units.
* The 5-second auto-refresh on the old feed is wasteful. Monitoring uses explicit refresh and cache-independent read requests; future optional live mode should be visibility-aware and throttled.
* The authoritative source for specialised model-training logs stays inside Football Training. Copy only meaningful Atlas infrastructure outcomes, not training line streams.

## Delivery sequence

1. **Activity and navigation (first PR):** query `audit_events` with parameterised filters, total and offset/limit; preserve legacy audit tools; add Monitoring tabs, deep links and old Activity bookmark support. Basic macOS Node log reader remains read-only. Indexes cover principal read patterns.
2. **Contextual previews (follow-up PR):** remove Project Overview's full scrolling feed; use a reusable 3–5 event card with View all. Add Node and Workspace/checkout previews and Store shortcut, preserving revision drill-down.
3. **Technical logs (follow-up PR):** audited Server and Linux fixed-source adapters, timestamp parsing, explicit offline/unauthorised/truncated states, bounded copy and tests for symlink and secret handling.
4. **Operational quality (follow-up PR):** confirmed health signals (not guessed), correlated requests/results across page boundaries, richer associations, safe diagnostic projection, sensible polling and observability measures.

## Compatibility and validation

* Existing MCP `get_recent_activity` / `get_audit_history` remain unmodified and backed by the same immutable table.
* Monitoring URLs use hash query strings, e.g. `#/monitoring?tab=activity&projectId=...` and `#/monitoring?tab=logs&nodeId=...`. `#/activity` maps to Monitoring Activity for old bookmarks.
* Queries use parameterised SQL and bounded limits; records outside a selected scope must not appear.
* Tests cover deep links, legacy API continuity, filter-before-pagination and Node log boundary semantics. Review CI and production logs separately before retiring old feeds.
