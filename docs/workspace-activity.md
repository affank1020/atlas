# Observatory workspace activity

Project pages now show Project activity after the Workspace panel at the bottom of the page. The global Activity page uses the same feed, and overview/store audit rows share the presenter.

## Architecture

`get_recent_activity` → Observatory `callTool` → `presentActivity` → shared activity rows.

The immutable audit table remains the source of truth. There is no new event store, migration, or streaming endpoint. The existing project/workspace filters are passed to the API before its 200-event limit. Category and client filters apply to that returned window. The Workspace category includes all workspace adapter activity; Errors includes failed actions across categories.

The presenter groups request/result events by project, workspace and attempt ID, prefers the final result, and retains a stable row key as pending becomes completed/failed. Both audit IDs remain inspectable. Unknown operation and command strings render as text with readable word separators. Known Unity labels and file/Git operations are mapped outside Core.

Polling waits five seconds after each completed fetch, pauses requests in hidden tabs, aborts on unmount/scope changes, and ignores stale responses. Each refresh replaces the recent window rather than appending duplicates. Expanded rows retain their state, and an anchored row preserves position while reading down the scrollable feed. Names come from workspace metadata, lifecycle events and cached workspace listings (including archived workspaces; refreshed at most once a minute per project).

## Backend additions

Explicit calls now write one bounded inspection event for each of:

| Tool | Audit operation |
| --- | --- |
| workspace_list_files | workspace.file_listed |
| workspace_read_file | workspace.file_read |
| workspace_search_files | workspace.files_searched |
| workspace_git_status | workspace.git_status |
| workspace_git_diff | workspace.git_diff |
| unity_status | workspace.unity_status |
| unity_list_commands | workspace.unity_commands |

These tools accept optional `client`, with the existing MCP-client/HTTP-header attribution behavior. Events record operation, inspection kind, outcome, workspace name and path where applicable. They do not record file text, diffs, search queries/results, or Unity parameters. Internal filesystem lookups and workspace configuration/list calls are not audited. Failed inspections record a bounded diagnostic in the same event.

Existing mutation intents/results are preserved. New workspace events include the workspace name. Mutation failures now include a bounded error reason; Unity `isError` results retain `editor_error` and a short diagnostic. Filesystem error codes map to concise descriptions. Old events lacking errors cannot be retroactively enriched. Core CRUD and View audit behavior are unchanged.

## Manual verification: Final Year Project / AI Football

1. Restart the Atlas backend using your normal development runner (or `./atlasctl restart` from the Atlas repository if using the managed stack) so new inspection auditing is loaded. The UI development server hot-reloads; production UI users should run `npm run build` in `apps/web` and serve the updated output.
2. Open Observatory at http://127.0.0.1:5173 and choose Projects → Final Year Project. Project activity is directly after the Workspace panel. The Unity command catalog is collapsed by default; expand Unity commands only when needed. Choose **AI Football** in the Workspace filter. Keep this page visible beside ChatGPT.
3. With the AI Football Unity project open and Pipeline connected, ask ChatGPT: “Using Atlas, find the Final Year Project and AI Football workspace. Run editor_status, console, get_component_properties for an existing component, and capture_game_view. Use client chatgpt.” Supply a component identifier from scene inspection if needed. The commands must already be locally approved.
4. Ask ChatGPT to start then stop Play Mode through `unity_run_command` (`editor_play`, `editor_stop`). Expect readable completed rows within approximately five seconds of each call completing. Each operation should appear once, even though its audit contains an intent and result.
5. Ask ChatGPT to create a disposable `observatory-activity-check.txt` at the workspace root containing `first`, read it, patch `first` to `second` using the returned SHA-256, then delete it using the current SHA-256. Choose **Files** to see these actions with paths and client attribution.
6. Before deleting the temporary file, optionally request another patch with its old SHA-256. Atlas should reject the stale hash. Choose **Errors**: expect one failed entry with the conflict reason. Return to Files and delete the temporary file using a fresh read/hash.
7. Choose **Unity**, **Files**, **Errors**, and **ChatGPT** to verify filtering. Expand a row to inspect its command/path, attempt ID, outcome, timestamp and audit event IDs. Keep a row expanded while another action arrives; it should stay expanded without a page reload.
8. Choose **All workspaces** and **All** to see Core/View events alongside workspace events. Global Activity also includes these events. Compare expanded IDs with `get_audit_history` scoped to the same project/workspace to verify provenance.

This feed shows the latest 200 raw audit events in the selected scope, not paginated full history. Request/result grouping can produce fewer than 200 visible rows. Pending means no final audit result is available; it does not prove the client is still running. Existing audit-history tools remain available for older events.

## Changed files

Atlas: `apps/server/src/workspaces/service.ts`, `apps/server/src/workspaces/contracts.ts`, `apps/server/src/server.ts`, `apps/server/src/types.ts`, `test/workspaces.test.ts`, this guide.

Observatory: `apps/server/src/activity.ts`, `apps/server/src/ActivityFeed.tsx`, `apps/server/src/activity.css`, `apps/server/src/activity.test.ts`, `apps/server/src/ActivityFeed.test.tsx`, `apps/server/src/App.tsx`, `apps/server/src/api.ts`, `apps/server/src/types.ts`.

## Validation

- Backend TypeScript build passes.
- Final full backend regression suite: 90/91 passed; all 8 workspace tests passed, including Unity request/result pairing and HTTP inspection attribution. The unrelated external-link assertion in test/views-stage2.test.ts:37 expects literal equals signs while Handlebars emits equivalent &#x3D; entities. This View code/test was changed independently during the task and was not modified for activity.
- Observatory: 39 tests pass, including polling lifecycle, no overlap, hidden-tab pause, deduplication, failures, unknown commands, clients, scopes and Core/View compatibility. Production build passes.
- Browser checked against AI Football audit data, including project/global feeds, workspace names, Unity filtering and expanded details. Observed new ChatGPT component-inspection events arriving during verification; a completed row contained the paired request/result audit IDs. The full file-mutation/failure manual sequence remains available above.
