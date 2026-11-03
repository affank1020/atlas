# Pi worker foundation (read-only)

The asynchronous Server/MCP integration is now documented in [AGENT_SERVICE.md](AGENT_SERVICE.md).
The sections below record the original local harness and its security boundary; current
Server/MCP operation and remaining acceptance are described in the new guide.

Implements the first Node-local slice of [#196](https://github.com/affank1020/atlas/issues/196)
and [#198](https://github.com/affank1020/atlas/issues/198). It does **not** complete the
live feasibility/benchmark acceptance in [#197](https://github.com/affank1020/atlas/issues/197).

## Integration decision and dependency boundary

Use the supported Pi SDK **inside a separate supervised process**. Pi owns prompting,
model calls, tool choice/execution and completion. Atlas owns admission, approved target,
process group, deadlines, cancellation and bounded receipts. This is not an Atlas agent loop.

Pinned runtime: @earendil-works/pi-coding-agent **1.5.0**, with pi-ai **1.5.0**, in
apps/node/pi-runtime/package-lock.json. The exact npm coding-agent tarball integrity is
sha512-xNDZ5kqowO6Z03FS2gwAkPEGk1ssxVcYKQ6qZId84mFEvwACvvyc2l0vAMOS+c5zvxLRMLBE9r4y44IGYkMJaQ==.
The maintained upstream package is now under earendil-works; do not silently substitute
another Pi package/version. The package, declarations and native read implementation
were inspected; this is not a comprehensive upstream security audit.

The [SDK reference](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/sdk.md)
supports explicit session, resource, model and tool configuration. The
[RPC reference](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/rpc.md)
supports a subprocess, but default CLI discovery/tools require more security configuration.
The SDK lets us replace the native read tool's filesystem operations and turn discovery
off entirely. The private child protocol is bounded JSONL, not a public replacement for Pi RPC.
It deliberately exposes no generic RPC command forwarding, steering, bash or shell arguments.

The optional runtime requires Node >=22.19.0 and is installed separately. The same
read-only worker can now run on an explicitly approved Linux desktop Node; production
Linux acceptance is still pending. Existing Atlas
Nodes retain their dependency graph and normal startup; the production desktop entrypoint
keeps this capability disabled unless the new private Node policy explicitly enables it. CI installs the optional lockfile
to run the real SDK integration test.

## Functional behavior

- Node-local start/get/events/cancel contract in @atlas/protocol/pi-worker.
- Local operator grants bind run UUID, workspace UUID, Node identity, canonical root,
  exact HEAD/atlas branch, prompt hash, timeout and expiry. Grants are copied and consumed
  once per supervisor; unknown/duplicate run IDs are never silently replayed.
- Reuses WorkspaceFiles, verified linked Git layout, trusted Git roots and managed branch
  rules. Rejects primary checkouts (even on atlas branches), detached HEAD, changed HEAD/
  branch, protected paths, unapproved roots, inactive workspaces and cross-Node requests.
- One worker per supervisor and an atomic per-user machine lock across CLI/supervisor
  instances. At most 64 runs retained per supervisor; then admission fails until restart.
- Fixed executable (current Node), fixed worker entrypoint, fixed local Ollama endpoint
  127.0.0.1:11434/v1 and qwen3-coder:30b model. No caller environment, URL, provider,
  executable, args or extension path. No inherited credentials, proxies or NODE_OPTIONS.
- Pi's native read tool uses Atlas's bounded UTF-8 reads, secret/metadata exclusions,
  symlink and hardlink checks. Only read is active. No bash, write, edit, find/grep
  subprocesses, extensions, Skills, MCP discovery, context files or persisted sessions.
- In-memory Pi settings and credential store. Retry/compaction disabled. Context metadata
  requests 32,768 tokens with 4,096 output tokens; actual Ollama effective context and
  Qwen compatibility still require live verification.
- Startup bound (30 seconds or the run deadline), run bound (100ms–10min),
  process heartbeat, absolute deadline checks on wake, SIGTERM then SIGKILL after 1 second,
  Node shutdown cleanup and child exit on parent stdin EOF.
- Completion requires real Pi agent start/settled/result plus successful process exit.
  Unexpected exits are incomplete; malformed frames, excess output, provider errors,
  cancellation and deadlines are explicit. Pi completion does not mean tests passed.
- Monotonic cursors with 256 retained metadata events, explicit retention gaps, 32KiB
  frame bound and 1MiB combined stdout/stderr limit. Events include native tool start/end,
  isError, process identity, exit/signal and terminal reason.
  Raw prompts, tool args/results, assistant prose and stderr are deliberately not retained
  or returned. This milestone reports execution receipts rather than a model transcript.

## Local operator acceptance harness

This is a manually invoked local CLI, **not an MCP remote-execution endpoint**. Review
the manifest/prompt and approve each invocation. Use a fresh non-production worktree
created through the existing trusted Git management flow. Do not point this at a base checkout.

From the repository root:

    npm ci
    npm run build:node
    npm ci --ignore-scripts --prefix apps/node/pi-runtime
    export ATLAS_GIT_TRUSTED_ROOTS=/absolute/canonical/dev-root
    node scripts/pi-worker-local.mjs --approve-read-only /absolute/operator-request.json

The installed Node executable must meet the optional Pi engine requirement. Ollama must
already be serving the approved local model. Atlas does not install/start Ollama or
download models. Example manifest (replace all IDs/paths/HEAD with the actual approved target):

    {
      "nodeId": "11111111-1111-4111-8111-111111111111",
      "roots": ["/absolute/canonical/dev-root"],
      "rootPath": "/absolute/canonical/dev-root/pi-inspection",
      "request": {
        "runId": "22222222-2222-4222-8222-222222222222",
        "workspaceId": "33333333-3333-4333-8333-333333333333",
        "expectedHead": "0000000000000000000000000000000000000000",
        "expectedBranch": "atlas/pi-inspection",
        "prompt": "Read README.md and describe the project. Do not execute tests.",
        "permission": "read-only",
        "timeoutMs": 120000
      }
    }

SIGINT cancels; SIGTERM closes the supervisor. The CLI emits JSON receipts/events and
returns nonzero on failure/incomplete/cancel/deadline. The local manifest is an operator
assertion of Workspace placement, not a Server-authenticated checkout lookup. Never
accept such a manifest from an untrusted remote client. Embedders can inject PiWorkers
into LocalNodeRuntime; Node stop awaits its cleanup within the existing shutdown bound.

## Permission and recovery limits

Read-only is a tool permission boundary, **not an OS sandbox**. The fixed trusted SDK
runs as the local user. It can inherently access that user's filesystem/network; a
compromised dependency or hostile same-UID process is outside this foundation's boundary.
The only exposed tool uses Atlas path rules, and no arbitrary project code is loaded.
Use approved, non-secret repositories; filename/content protections are not a complete
secret classifier. Concurrent hostile filesystem mutation remains an existing WorkspaceFiles
TOCTOU limitation. There is no unattended write authority.

The lock is in the OS temporary directory, atlas-pi-worker-<uid>.lock. A crash may leave
it behind. Admission fails closed: no PID guessing, lock stealing or automatic restart.
An operator must first verify locally that no prior worker/process group remains, then
remove the empty lock directory. Use a new run ID and explicit fresh approval.
No durable receipts or cross-restart replay protection exist yet: operator invocation
is new authority, not recovery of an old run.

Server disconnect does not mean process success or termination. The original slice had no remote start/status transport. The follow-up implements the
transport in AGENT_SERVICE.md but still does not claim live Mac/model acceptance.
A future transport must fence placement changes, persist approval consumption/run/events
and explicitly reconcile uncertain prior work; it must never replay starts automatically.

Before writes: establish and test real macOS process/file/network/credential isolation,
including inherited handles, symlink races and descendants. OS sandbox readiness plus
explicit task approval is required; merely adding write/edit to the allowlist is unsafe.

## Verification and remaining acceptance

Automated checks use temporary repositories and child processes. The real pinned Pi SDK
test uses an HTTP model simulator: Pi itself chooses read, receives actual file evidence,
then completes. It also verifies native read denial and discovery suppression. This is
neither a Qwen benchmark nor live Pi/Mac model acceptance.

    npm run test:pi

Without the separate runtime install, SDK tests report skipped; lifecycle/permission
tests still run. CI installs it so skips do not hide missing integration coverage.

Real Mac acceptance still required:
1. Record exact macOS, Node, Pi, Ollama and Qwen model digest/effective context.
2. Explicitly approve a fresh isolated worktree and run native read inspection; capture
   redacted execution receipts and verify base/worktree hashes remain unchanged.
3. Cancel while inference/tool work is active; verify direct child and descendants exit.
4. Sleep/wake and kill/restart the hosting Node; verify overdue runs fail honestly,
   no orphan remains and stale locks require deliberate recovery.
5. Exercise the eventual authenticated Server/MCP transport with durable approvals/events.
6. Assess a pinned subagent extension separately. No subagent orchestration is implemented.

This follow-up adds durable registry/approval transport (#199) and MCP controls (#200).
Monitoring UI (#201),
subagents (#202), write isolation and end-to-end coding/PR acceptance (#203) remain open.
