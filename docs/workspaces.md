# Atlas Workspaces V1

Workspaces bind an Atlas Project to a local directory. Stores and Views retain their existing semantics. Files remain authoritative on disk, are accessed on demand, and are never copied into Records or an index. Fabric is unchanged.

## Architecture

`MCP / Observatory HTTP → shared validated tool dispatch → WorkspaceService → PostgreSQL + WorkspaceFiles / WorkspaceAdapter`

- `src/workspaces/contracts.ts`: the same strict Zod contracts serve MCP and HTTP.
- `src/workspaces/service.ts`: project ownership, workspace lifecycle, concurrency, durable audit intents and outcomes. It depends on Core; Core does not depend on Workspaces or Unity.
- `src/workspaces/files.ts`: bounded filesystem and fixed Git operations.
- `src/workspaces/adapter.ts`: adapter interface and optional Unity implementation.
- `migrations/011_workspaces.sql`: UUID workspace records, project foreign key, one-active-workspace partial unique index, and indexed `audit_events.workspace_id`.
- Observatory `WorkspacePanel.tsx`: configuration, health, Git changes, Unity command schemas, and read-only file preview.

The service is created lazily. A missing workspace migration/root/CLI or unavailable Editor affects only workspace requests. Core snapshots do not query the workspace table. Workspace IDs do not change when renamed. Archiving detaches without deleting files. Archived projects cannot operate on workspaces. Roots and adapters are immutable for a binding; archive and register again to change them. The active-workspace index can be relaxed in a later migration without changing the domain shape.

## Configuration and trust

```dotenv
ATLAS_WORKSPACE_ROOTS=/Users/you/GitRepos,/Users/you/Projects/MyUnityProject
ATLAS_UNITY_CLI=/Users/you/.unity/bin/unity
ATLAS_UNITY_ALLOWED_COMMANDS=
```

No configured roots means no filesystem access. An allowed root may itself be a project directory. Prefer exact repository paths over broad home directories. Restart Atlas after environment changes. `ATLAS_UNITY_ALLOWED_COMMANDS` is a comma-separated list of exact reviewed command names, configured locally, never through MCP.

Atlas stays bound to `127.0.0.1` by default. This implementation does not add hosting, a tunnel, authentication, or a public filesystem endpoint. ChatGPT Web must use the user's existing trusted MCP connection to the local Atlas process. Do not expose the unauthenticated local API directly to an untrusted network. Browser workspace requests and browser MCP requests accept only `ATLAS_WORKSPACE_ORIGINS` (defaults: localhost/127.0.0.1 ports 5173 and 4173); native MCP clients usually omit Origin. A client label is audit attribution, not an authenticated identity.

Security controls:

- Canonical real paths must be within a configured allow-list root, checked again on every operation. Absolute file paths, backslashes, NULs and any `..` component are rejected.
- Every existing path component is inspected. All symlinks are rejected, including in-root symlinks; regular files with multiple hard links are rejected. Reads open with `O_NOFOLLOW` and reject special files.
- `.git`, `.ssh`, cloud credential directories, `.env*`, private-key extensions/names, credentials/secrets/token files, and Unity/generated/build directories are excluded from reads, lists, search and writes. Private-key content is rejected even under an innocuous filename. These heuristics are not a universal secret detector: review which repository you expose.
- UTF-8 only, at most 512 KiB per file, no binary previews. Listings have explicit depth/entry limits and a 10,000-entry scan budget. Literal, case-sensitive search has an 8 MiB content budget, 2,000-entry tree limit, and bounded matching snippets. Results report truncation/skips.
- Create is exclusive and requires an existing parent. Patch requires `expectedSha256` and exactly one nonempty `oldText` match. Replacement is staged in the same directory and renamed only after a second hash check. Delete requires the current hash and only removes one file.
- Atlas writers for the same root serialize through a PostgreSQL advisory lock. Workspace archival is checked under a row lock and the project is rechecked as active before mutation. An already-started operation may finish if the project is archived concurrently; subsequent operations are denied.
- No shell API. Git uses `/usr/bin/git` with fixed arguments, a minimal environment, disabled pager/hooks/fsmonitor/external diff/text conversion, timeouts, literal pathspecs, and bounded output. It never commits, pushes, resets or writes Git internals.

V1 trusts the local account and its other processes. Node's path APIs do not provide a portable directory-handle-relative atomic sandbox: a hostile local process concurrently replacing ancestor directories can race path checks, and an external editor can race the final hash check/rename. Do not grant access to repositories controlled by hostile local writers. Hash checks prevent stale client edits; they are not a cross-process filesystem transaction. Approved Unity commands execute trusted Editor/package code with the Editor's OS permissions, not inside the file API's allow-list sandbox. Review custom command implementations and parameter behavior before approving them.

## MCP and HTTP tools

All workspace-scoped tools require `projectId` and `workspaceId`. They are available at MCP and `POST /api/tools/<tool>` using the same validation.

| Tool | Additional input / behavior |
| --- | --- |
| `list_project_workspaces` | `projectId`, optional `includeArchived` |
| `get_workspace` | optional `includeArchived` |
| `create_workspace` | `projectId`, `name`, absolute `rootPath`, `kind: generic \| unity` |
| `update_workspace` | optional `name` |
| `archive_workspace` | Detach; preserve disk files |
| `workspace_list_files` | optional relative `path`, `depth` (0–20), `limit` (1–2000) |
| `workspace_read_file` | relative `path`; returns text, byte count, mtime, SHA-256 |
| `workspace_search_files` | literal `query`, optional relative `path`, `limit` (1–200) |
| `workspace_create_file` | relative `path`, `text` |
| `workspace_patch_file` | `path`, `expectedSha256`, `oldText`, `newText` |
| `workspace_delete_file` | `path`, `expectedSha256` |
| `workspace_git_status` | Branch, dirty flag, bounded changed-file summary |
| `workspace_git_diff` | Separate staged/unstaged diffs, omitted-file count |
| `unity_status` | CLI version, package configuration, reachability |
| `unity_list_commands` | Discovered names, descriptions, input schemas, approval flags |
| `unity_run_command` | `command`, structured `parameters` object |

Mutations accept optional `client`. The existing audit tools also accept `workspaceId` and workspace operation filters. File content and Unity parameters/results are not stored in audit history. File audit outcomes contain hashes, sizes and paths. Unity audit outcomes contain the command name and attempt ID.

Filesystem and Editor writes cannot commit atomically with PostgreSQL. Atlas commits a `workspace.mutation_requested` event before touching either system, then writes a completion/failure event. A crash or persistence failure can leave an intent without a completion. Treat such attempts (and Unity timeouts) as uncertain: inspect the file/Editor before retrying. Failed validation after intent is also recorded. Metadata-only lifecycle changes and their audits share one database transaction.

## Unity interface actually inspected

Implementation was verified against locally installed `unity 1.0.0-beta.12` using `--help`, `status/list/command/pipeline/mcp --help`, `commands --json`, and the CLI's embedded `references/integration-advanced.md`.

1. `unity --version` discovers the installed version; missing executable yields `cli_unavailable`.
2. A bounded read of `Packages/manifest.json` checks `com.unity.pipeline`; missing declaration yields `pipeline_not_configured`.
3. `unity list --project-path <canonical-root> --json --no-banner --no-pager --non-interactive` probes this exact project's Pipeline. Failure yields `editor_unreachable`; Atlas never starts an Editor or installs a package.
4. `unity mcp --project-path <canonical-root> --no-banner --no-pager --non-interactive` is the official CLI's stdio MCP interface. Atlas uses the SDK to discover actual Editor tools and pass structured arguments. Sessions are short-lived and closed with bounded request/lifetime timeouts. No Pipeline HTTP endpoints are invented.
5. Invocation re-discovers capabilities and requires both an exact locally approved name and its presence in the current catalog. General evaluation/script/shell command names are denied even if listed in the local approval setting. The Editor validates its own input schema.

The project-scoped `list` probe is intentional: the installed CLI documents that a resident headless Editor can answer commands while absent from `unity status`. Pipeline may be unreachable because the Editor is closed, importing, in Safe Mode, or blocked by permissions; status does not falsely claim which one occurred.

To expose a future custom Pipeline command, implement and register it in the Unity project, verify that it appears in `unity_list_commands`, review its code/schema, and add its exact name to `ATLAS_UNITY_ALLOWED_COMMANDS`. No Atlas Core changes are needed. No FYP commands are implemented here.

## Bind the existing Final Year Project

Read-only inspection on 2026-10-06 found:

- Atlas project: `Final Year Project`, ID `ce09dbe0-0755-4bd8-9376-e4a3152d59f7`.
- Unity Hub project: `/Users/affankhan/AI Football`, Unity `6000.3.6f1`.
- Script: `Assets/Scripts/Training/FootballAgent.cs`.
- CLI: `/Users/affankhan/.unity/bin/unity`, `1.0.0-beta.12`.
- No reachable Pipeline Editor; `com.unity.pipeline` was absent from the project's manifest. The Unity project was not changed.

1. Apply the new migration with `npm run db:migrate` from the Atlas repository (safe to repeat).
2. Add the exact repository to Atlas `.env`: `ATLAS_WORKSPACE_ROOTS="/Users/affankhan/AI Football"`. If roots are already configured, append it with a comma. Set `ATLAS_UNITY_CLI=/Users/affankhan/.unity/bin/unity`. Restart Atlas and Observatory with the new builds.
3. In that project's Workspace panel, bind the directory with kind **Unity**, or call:

```json
{
  "projectId": "ce09dbe0-0755-4bd8-9376-e4a3152d59f7",
  "name": "AI Football",
  "rootPath": "/Users/affankhan/AI Football",
  "kind": "unity"
}
```

Use `create_workspace`; retain its returned `id` as `workspaceId`. Generic tree/search/read/patch/Git tools work immediately without an Editor.

4. When ready, explicitly install the official package yourself with `unity pipeline install --project-path "/Users/affankhan/AI Football"`, then open that project in Unity. This is a user setup action; Atlas does not run it. Focus the Editor and allow package import/compilation to complete.
5. Call `unity_status`, then `unity_list_commands`. Review and locally approve only the exact commands you want in `ATLAS_UNITY_ALLOWED_COMMANDS`; restart Atlas. Call `unity_run_command` using the discovered parameter schema. The empty default permits discovery but no invocation.
6. Read `Assets/Scripts/Training/FootballAgent.cs`, use its returned hash for a targeted patch, then inspect `workspace_git_diff`.

## V1 limitations and roadmap

- Local Mac only; no remote filesystem, repository ingestion, Fabric coupling, autonomous loops or training orchestration.
- One active binding per project, no directory creation/deletion or full code editor.
- Read/search require bounded UTF-8 files. Exclusions cannot be disabled remotely.
- Git requires a repository root with an in-directory `.git` directory. Linked worktrees/submodules are not exposed in V1. Diff omits deleted, binary, protected and untracked-file content; at most 100 changed current text files are inspected. Dirty status can be true even if only protected files changed.
- Secret detection is heuristic; existing source files can contain embedded credentials.
- Pipeline package declaration detection expects `Packages/manifest.json`. Unsupported future CLI contracts fail closed. Live command execution needs a running Editor; regression tests mock successful command execution.
- File/Editor operations have the transaction and local-process trust limits described above.
- Future adapters can implement `WorkspaceAdapter.status/capabilities/invoke`. Multiple bindings need an index migration. Neither expansion requires changes to Stores, Records or Views. ML-Agents, FYP commands, Git writes and remote hosting remain outside V1.

## Verification

`npm test` includes isolated PostgreSQL, filesystem, Git, Unity mock, audit, project isolation and real MCP transport regressions. `npm run build && node scripts/workspace-live-verify.mjs` separately exercises the main MCP file-edit/Git/audit flow against a disposable repository/schema. Observatory uses `npm test` and `npm run build` in `atlas-ui`.
