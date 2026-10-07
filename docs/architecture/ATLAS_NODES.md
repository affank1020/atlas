# Atlas Nodes V1

A **Node** is a trusted device/runtime attached to Atlas Server. A Node is not an AI Agent. **Agent** means an AI/software actor such as ChatGPT or Codex; **Client** is a human/AI interface to Atlas. Atlas Server owns Core, Projects, Stores, Records, Views, Workspaces, Activity, retrieval and Node registry/routing. Atlas Web consumes those services.

```text
Project
└── Workspace (projectId, nodeId, rootPath, kind, adapter)
    └── hosted by Node

Client → Workspace API → WorkspaceService → NodeRouter → LocalNodeRuntime
                          │                              ├── WorkspaceFiles
                          └── metadata / locks / audit   ├── read-only Git
                                                         └── UnityAdapter / CLI / Editor
```

**Clients operate on domain abstractions such as Workspaces. Atlas Server decides which Node executes the operation.** The Server passes a resource binding to its host; it does not interpret it as a Server filesystem path.

## Persistence and identity

Additive migration `012_nodes.sql` creates `nodes`, inserts one local row with a random UUID and unique internal `local_key='local'`, backfills **all** Workspaces (including archived bindings), and enforces `workspaces.node_id NOT NULL REFERENCES nodes(id)`. It does not recreate a Workspace table, modify Workspace timestamps or history, or change IDs, Projects, paths, kinds/adapters or archive state. The local UUID is stable across process restarts and hostname/network changes. It is installation/database scoped, not a hardware fingerprint; cloning the database copies this identity. Remote registration must define its own identity strategy later.

The local display name is persisted on first registration, using `ATLAS_NODE_NAME` or the machine hostname. It is not hardcoded and subsequent restarts preserve it. There is no public rename/register endpoint in V1. `metadata` identifies the local runtime. A single `node.created` migration audit event records registration provenance; restart presence updates generate no permanent audit events. Workspace creation already records `nodeId` in its audit snapshot.

## Runtime and routing

`src/nodes/runtime.ts` defines `NodeRuntime`: advertised capabilities, `bind`, and a finite union of Workspace execution operations. All execution inputs are parsed by existing Workspace schemas before routing. There is no general-purpose `node.execute` public tool.

`NodeService` owns persisted registry reads and in-process runtime attachments. Local registration is coalesced and lazy for legacy constructors and also runs at production startup. `NodeRouter` resolves `workspace.nodeId`, validates persisted status, requires an attached runtime and checks both persisted and runtime capabilities. The attachment registry is keyed by UUID and supports more than one runtime; tests route a second Workspace host without falling back to local execution.

| Capability | Operations |
| --- | --- |
| `workspace.files` | Bounded listing/search/read/create/patch/delete; initial binding |
| `workspace.git` | Fixed read-only status/diff |
| `workspace.dev` | Owner-configured named development checks with bounded execution |
| `unity` | Status, discovery, approved structured command invocation |

These capabilities describe installed implementations, not authorization or guaranteed external-tool health. `unity` is advertised when a Unity adapter is installed; the existing status/discovery responses still report missing CLI, disconnected Editor, absent Pipeline, and Workspace-specific adapter availability. No GPU, browser or arbitrary shell capability exists.

`NODE_OFFLINE`, `NODE_UNAVAILABLE`, and `CAPABILITY_UNAVAILABLE` are AtlasErrors carried through existing MCP error envelopes and HTTP 400 conventions; missing registry rows use `NOT_FOUND`/HTTP 404. A persisted online row without a runtime attached to this Server is reported unavailable, never executed locally by default.

## Presence and shutdown

Registration writes `online`, capabilities and `lastSeen`. Graceful shutdown drains existing Server work, detaches the local runtime and writes `offline` before closing its database pool. There is no heartbeat; `lastSeen` means last registration, not a liveness lease. After an abrupt crash the stored row can be stale until startup; API reads combine persisted status with attachment availability.

V1 assumes one active local Server/runtime owner per installation. It does not implement distributed ownership leases or reliable presence across concurrent Server processes. Sharing one database between independent machines is not supported by local registration. Before doing that, introduce per-Node identity, runtime-session fencing and authenticated attachment.

## Safety and compatibility

Filesystem/Git/Unity/development execution implementations remain in local infrastructure. Existing allowed roots (`ATLAS_WORKSPACE_ROOTS`), canonical path checks, traversal/symlink/hardlink exclusions, protected/secret/generated-file exclusions, bounded listing/search, 512 KiB text limits, UTF-8 validation, SHA-256 conflict checks and single-file deletion are preserved. Git has no write commands. Unity discovery, local approvals, structured arguments and shell/eval restrictions are unchanged.

WorkspaceService depends on the router rather than OS implementations. Metadata CRUD needs no running Node; registration validates binding on the default local Node. Existing create input schemas are unchanged: `nodeId` is assigned internally and added to Workspace output. No public ownership reassignment API is exposed.

Workspace audit intent/outcome semantics are unchanged. Registry/capability resolution happens before leasing a mutation connection to avoid pool exhaustion under concurrent writers. Execution locks now include both Node UUID and resource binding so identical paths on different Nodes do not collide. The Node runtime must preserve host-side exclusion and conflict checks when a remote transport eventually replaces in-process calls.

`list_nodes` and `get_node({nodeId})` are read-only MCP and `/api/tools/...` HTTP operations. List includes status, capabilities, timestamps and active hosted Workspace counts; get includes active hosted Workspace summaries. Counts exclude archived Workspaces and Projects. Atlas Web's Infrastructure → Nodes and Project → Workspaces Host section consume these contracts. Node reads receive the same browser-origin restrictions as Workspace tools.

## Controlled development tasks

`workspace.dev` is implemented as `workspace_list_dev_tasks` and `workspace_run_dev_task`. Workspaces store a `dev_tasks` JSON object added by migration `013_workspace_dev.sql`; existing Workspaces start with no tasks. Only a local owner script can configure executable argv. For example:

```json
{
  "test": { "executable": "npm", "args": ["test"], "timeoutMs": 120000 },
  "build": { "executable": "npm", "args": ["run", "build"], "timeoutMs": 120000 }
}
```

From a trusted local shell, run `node scripts/configure-workspace-dev-tasks.mjs <workspace-uuid> <trusted-json-file>`. This validates the names, argv lengths, task count and timeout limits, updates the existing Workspace row, and audits only the configured task names. Workspace create/update MCP tools do not accept executable definitions. Review the configuration file before running the administrator script.

Clients call `workspace_list_dev_tasks({projectId,workspaceId})` to discover supported tasks, then `workspace_run_dev_task({projectId,workspaceId,task:"test"})`. The request has strict schema validation: no command, cwd, environment or extra arguments are accepted. Example result:

```json
{
  "workspaceId": "<workspace-uuid>", "nodeId": "<node-uuid>", "task": "test", "command": "npm test",
  "success": false, "exitCode": 1, "signal": null, "timedOut": false,
  "stdout": "…", "stderr": "3 tests failed", "stdoutTruncated": false, "stderrTruncated": false,
  "startedAt": "2026-10-07T12:00:00.000Z", "completedAt": "2026-10-07T12:00:04.200Z", "durationMs": 4200
}
```

The Node revalidates its allowed Workspace root immediately before spawning the configured executable with `shell:false`, the bound root as cwd, ignored stdin, a minimal process environment plus `CI=1`, and no caller environment overrides. Owners may explicitly allow up to 16 environment-variable names per task through `passEnvironment`; Atlas’s `test` task passes `DATABASE_URL` because its integration tests require PostgreSQL. Default timeout is two minutes; owner configuration may choose 100 ms–10 minutes. On timeout the local Node kills the process group. Each stdout/stderr stream retains its last 128 KiB and marks truncation. Command exit failures and timeout return structured results; unavailable Nodes and invalid task requests return Atlas errors. There is no resource quota beyond time/output limits, no interactive stdin, and no generic command endpoint. Configured tasks execute repository code with the local Node process account’s filesystem rights; this is a controlled entry point, not an OS sandbox. A task that reads files (including a local `.env`) can still expose them in its bounded output, so only trusted Workspaces and task definitions should receive this capability.

`workspace.mutation_requested` records intent before execution. `workspace.dev_invoked` records task, Node, timing, exit, outcome and truncation flags without stdout/stderr. A nonzero exit is a completed request with a failed task outcome. Atlas Web shows the activity and exposes configured task buttons and bounded output in the Workspace panel. Existing filesystem, Git and Unity contracts continue unchanged.

The Atlas repository is registered by `npm run workspace:register-atlas` after `npm run db:migrate` and adding its path to `ATLAS_WORKSPACE_ROOTS`. The script creates/reuses the Project and Workspace using the existing services, then applies [config/atlas-dev-tasks.json](../../config/atlas-dev-tasks.json) through the owner configuration path. Atlas currently exposes `test` (`npm test`), `typecheck` (`npm run build`, which runs TypeScript), and `build` (`npm run build`). There is no lint script, so no lint task is advertised. Registration is idempotent and prints the stable Project/Workspace IDs for client calls.

## Remaining coupling and future work

LocalNodeRuntime deliberately contains all current machine coupling: filesystem policy, fixed Git subprocesses, Unity CLI/Editor discovery and approval configuration. Composition attaches it in the Server process today. Legacy `workspaces/service.ts` and `LocalExecutionHost` exports remain compatibility shims, but legacy Workspace service calls also use NodeRouter. Server-managed media/persistence is outside Workspace execution scope.

The future transport seam is:

```text
Atlas Server → WorkspaceService → NodeRouter → RemoteNodeRuntime
                                              → authenticated Node connection
                                              → local capability implementations
```

A remote implementation should carry the same bounded operation/request/result contracts. Define authentication, connection/session identity, cancellation/timeouts, Node-side policy validation, request IDs, idempotency and uncertain-outcome reconciliation **before** enabling remote writes or retries. Never retry a mutation blindly after a lost response. No WebSocket, callback, VPN, remote queue, reconnect logic or public execution endpoint is implemented here.

The next development-task step is richer permission policy and managed long-running services. Keep those separate from the finite `workspace.dev` task registry; never accept a caller-provided shell command.

## Verification

`npm test` covers additive migration preservation/FKs, stable registration, quiet lifecycle, list/get/hosted counts, default ownership, all eleven execution operations, multi-host routing, missing capabilities, offline/unattached Nodes, HTTP/MCP Node reads and existing safety/audit behavior. Architecture guardrails exclude infrastructure imports from Node application code and WorkspaceService. The pre-refactor MCP schema snapshot remains unchanged for all existing tools; only two read tools are added.

Atlas Web tests cover navigation, live data rendering, capabilities, links, refresh, empty/error states, unavailable hosts and ownership changes. Run `npm test` and `npm run build` in both repositories. Live Unity Editor execution is not required for the controlled adapter tests.
