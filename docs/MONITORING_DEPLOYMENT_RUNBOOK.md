# Atlas Monitoring — post-deploy acceptance and fault-injection checklist

**Purpose:** operator-owned evidence record for issue #110. Nothing here is evidence that a production VPS drill has run. Complete with dates, deployed image SHA and screenshots/observations after the approved Atlas deployment; never paste secrets, raw audit JSON, R2 object keys or container log lines into the issue.

## Preconditions and trust boundaries

- [ ] Record deployed Server/Web commit SHA, database migration revision and expected Node versions. Verify migration **034** (fixed-code Server archive) and **035** (transactional Files/folder evidence) are present before testing new features.
- [ ] Use the existing authenticated Atlas administrative route. Do not expose Server port 3000, diagnostic DB pool or Node logs publicly. Use least-privilege accounts and existing host administration channels.
- [ ] Confirm the application Server does **not** have Docker socket access, privileged mode or arbitrary host journal mounts. Do not grant them to "fix" missing raw logs.
- [ ] Back up test data and choose a disposable test Project/Workspace; preserve the existing PostgreSQL encrypted backup workflow with `verifiedRestore=false` until an actual isolated restore is performed.

## Health and historical diagnostics

- [ ] Open Monitoring Overview. Confirm independent database, Node and **Server diagnostic archive** status are displayed with one on-demand checked timestamp. Check the link to Logs → Atlas Server → retained events.
- [ ] On a healthy database, confirm archive status is `available` only when the fixed table is actually readable. A missing archive table/permissions must show `unavailable` or `unknown`, never a healthy archive.
- [ ] For a disposable environment only, deliberately disable archive configuration, reload Server and verify `disabled` rather than `unavailable`. Reenable and verify recovery. Avoid disrupting production users.
- [ ] On a disposable environment only, fault-inject a *bounded* diagnostic-pool read failure / temporary write failure; confirm UI reports uncertainty, current-process dropped writes or write backoff. Restore DB access, verify recovery, and record any missing intervals.
- [ ] Compare retained events before/after a controlled Server restart; capture only fixed codes/timestamps. Confirm older-than-14-days and far-future rows do not appear in the UI. This is **best-effort fixed-code history**, not Docker stdout/stderr or a complete audit ledger.
- [ ] In a disposable database, seed more than 10,000 expired *fixed-code* rows. Restart the Server and verify the first bounded sweep does not exceed 10,000 rows; verify subsequent intervals catch up. Confirm `more-possible` and then `caught-up` status, without increasing write failures or exposing expired rows in history. Do **not** seed a large backlog in production.
- [ ] In a disposable environment, deny archive delete permission or inject a one-shot maintenance failure while keeping fixed-table reads available. Verify `retentionCleanup: unavailable` is visible and overall health becomes `unknown`, then recovers to `caught-up` after permission recovery. Confirm no privileged retry. Do not use sensitive exception text as evidence.
- [ ] Verify an intentionally disabled diagnostic archive schedules no maintenance. On Server shutdown, confirm any in-flight sweep is drained and no further timers or DB reads run.
- [ ] In a disposable database with 3+ pages of fixed-code diagnostic rows, use **Older events** and **Newer events**. Verify no duplicates/skips with equal-microsecond timestamps, no unbounded page, and no secret payload in events/cursors. Change the page size and source while a read is pending; ensure the old rows cannot overwrite new source data.
- [ ] During a rolling upgrade, new Web with older Server history response (truncated but without `nextCursor`) must identify unavailable deep navigation rather than attempting an invented cursor. Read one page on an older client against the new Server to verify backward compatibility.
- [ ] Confirm Node statuses `healthy`, `stale`, `offline`, `revoked`, `unknown` with real connection/heartbeat conditions and clock-skew edge cases.

## Activity security, correlation and navigation

- [ ] Use a disposable Project to create, archive, restore and move Files/folders. Verify scoped Activity shows correct counts, no rolled-back events and **no filenames, paths, object keys, secrets or unauthenticated human actor names**.
- [ ] Test Project, Store, logical Workspace and physical checkout deep links, including an archived checkout assigned to another Node. Unrelated Project/Node events must not appear.
- [ ] Compare grouped operation filters and pagination to the original audited event set: failure beats success, pending remains pending and totals are server-filtered before safe projection.
- [ ] Validate manual-only refresh default; opt-in live view backs off after failures, never overlaps reads, pauses in hidden tabs and cannot overwrite a changed scope.
- [ ] Expand an authorised Node lifecycle/transfer event in Monitoring Activity and distinguish **recorded client**, **transport**, **credential class**, **source/target Node** and **update-intent state** from a verified human actor. Do not infer a person from a Node credential or from a node-reported activation flag. Confirm untrusted/missing fields remain unknown, and that ordinary Activity previews do not gain expanded Monitoring-only evidence.
- [ ] Validate rolling Server/Web revision mismatch: old health responses without diagnostic status render unknown, and old clients still read existing Server/Node/Files endpoints.

## Backup and operational boundaries

- [ ] Confirm a bounded R2 dry-run and its per-run UUID report, including `partial`, `empty`, `failed`, and `aborted` handling. Simulate a failed remote PUT in a disposable environment and verify no success is claimed after an uncertain result.
- [ ] Confirm encrypted PostgreSQL snapshots and private manifests on the host using the documented operator procedure; do **not** mark restore tested from metadata alone. Validate in an isolated restore environment before setting any restore evidence.
- [ ] Confirm Node technical log sources remain fixed and read-only. On Linux, independently verify the root-owned `/var/log/atlas-node` directory and Node-owned `service.log` file meet the exact permissions in [LINUX_NODE_PRIVATE_LOGS.md](LINUX_NODE_PRIVATE_LOGS.md), and that logrotate is configured. Read the new `service` source with at most 10 redacted lines and check its available/truncated status; **do not record contents**. A legacy explicit `journal` request must remain unavailable when the service lacks journal-read permission, without falling back to a different source or adding broad journal privileges. A missing private file must not be shown as healthy.
- [ ] Verify a desktop and narrow mobile viewport for Monitoring Overview/Activity/Logs, focus order, text overflow, select controls and clear unknown/unavailable descriptions.
- [ ] Record any failures and references to test fixtures, not raw outputs, under issue #110. Separate *CI passed*, *deployed smoke passed*, *fault-injection passed*, and *restore tested*.

## Operator sign-off (fill only after real execution)

| Check | Status (untested/pass/fail) | Tested against revision and date | Evidence / follow-up |
| --- | --- | --- | --- |
| Migrations and auth boundary | untested | — | — |
| Health and archive failures | untested | — | — |
| Restart and retention | untested | — | — |
| Scoped Activity and privacy | untested | — | — |
| Node/rolling-upgrade compatibility | untested | — | — |
| Backups and restore | untested | — | — |
| Narrow viewport and keyboard | untested | — | — |

**Exit criterion:** No Monitoring backend "complete" claim until these live checks have evidence; a PR merge or green CI alone cannot satisfy them.
