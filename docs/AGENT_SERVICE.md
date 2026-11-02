# Asynchronous read-only Pi jobs

This is the second milestone of #196/#199/#200, built on merged PR #206.
Atlas owns approval, checkout placement, dispatch, persistence and supervision.
The upstream Pi SDK still owns model requests, its native read tool and its agent loop.

## Operational boundary

Owner OAuth MCP exposes agent_start, agent_get, agent_events and agent_control.
A start returns a durable run identity/admission state immediately; it does not hold an
MCP tool call open for the entire agent session. The job and its receipts survive the
request, MCP client and Server connection. Event delivery is an asynchronous Node channel;
MCP consumes committed event pages with cursors.

Execution requires all of:
- migrated PostgreSQL Server (041_agent_runs.sql);
- an enrolled, online Node advertising agent.pi;
- a registered, active, approved physical checkout;
- explicit single-run approval by a Server-local administrator;
- a separate private Node-local policy allowing that checkout and model profile;
- macOS, Node >=22.19.0, the pinned optional Pi 1.5.0 install and working local Ollama.

The domain, MCP contract and wire channel are platform-neutral. Only the initial desktop
macOS adapter enables execution. Linux (#204), subagents/review orchestration and the
rich subagent UI are not implemented. The first monitoring Application is documented in AGENTS_APPLICATION.md. Existing Nodes neither advertise nor receive
agent commands and retain protocol v2 / Workspace behavior.

No production rollout or live ChatGPT/Ollama acceptance was performed during implementation.

## Identity, approval and models

Only the existing verified owner OAuth path grants agent access. Relay read/coding
service tokens, unauthenticated loopback MCP and browser tool dispatch do not acquire it.
Issuer plus subject define the owner; caller-supplied client labels cannot impersonate
that identity. Every get/events/cancel is scoped to the owner stored on the run.

An approval binds a new run UUID, approval UUID, owner, physical checkout, current Node
and canonical root, expected HEAD/atlas branch, exact instruction hash, timeout and a
resolved model profile. It expires within 24 hours. Approval consumption and run creation
commit atomically; identical retries return the existing run without redispatch.
Changed requests with the same run ID are denied. The database permits one nonterminal
or uncertain job per Node, and the existing per-user process lock remains enforced locally.

Model profile IDs are first-class root-session selections. Their reviewed configuration
contains provider, model, contextWindow and maxTokens; the exact same profile must be
allowed by the Node. This milestone supports only local Ollama at 127.0.0.1:11434/v1:
no remote URL, credential or environment can be provided through MCP. No silent fallback.
An unavailable model fails through Pi/provider receipts. Actual profile metadata is
recorded after the runtime-ready event. Hosted providers, credential brokering, role
defaults and child overrides need later adapters; child-agent fields are rejected.

## Administrator setup (deliberate operator actions)

These are instructions, not actions performed against production by this PR.

Apply the ordinary Server migration procedure, then build the Server and Node.
Standalone Node bundles include the optional Pi descriptors/entrypoints but do not
install Pi or enable the capability automatically. On the approved Mac installation:

    npm ci --ignore-scripts --prefix apps/node/pi-runtime

Create a private owner-only policy file (mode 0600), using actual enrolled Node and
registered checkout IDs. Upgrade the Server before enabling the capability on a Node.
The directory must remain operator controlled:

    {
      "nodeId": "11111111-1111-4111-8111-111111111111",
      "checkouts": [{
        "id": "22222222-2222-4222-8222-222222222222",
        "rootPath": "/absolute/canonical/dev-root/pi-inspection"
      }],
      "profiles": [{
        "id": "local-coder",
        "provider": "ollama",
        "model": "qwen3-coder:30b",
        "contextWindow": 32768,
        "maxTokens": 4096
      }]
    }

Set ATLAS_PI_POLICY_FILE on that Node. Optionally set ATLAS_PI_STATE_DIR to a dedicated
private directory; otherwise the Node uses agent-runs beside its status file.
Keep ATLAS_WORKSPACE_ROOTS and ATLAS_GIT_TRUSTED_ROOTS configured as before. Restart
the Node to load/revoke the policy. Do not delete or reuse its journal for retrying jobs.
The Mac startup preflight checks the optional installed Pi version and Node engine.

A Server-local admin reviews an exact instruction, checkout, expected commit and profile,
then prepares a private JSON file:

    {
      "approvalId": "33333333-3333-4333-8333-333333333333",
      "runId": "44444444-4444-4444-8444-444444444444",
      "checkoutId": "22222222-2222-4222-8222-222222222222",
      "issuer": "https://your-configured-issuer/",
      "subject": "your-configured-owner-subject",
      "instruction": "Read README.md and inspect the source. Do not execute tests.",
      "expectedHead": "0000000000000000000000000000000000000000",
      "expectedBranch": "atlas/pi-inspection",
      "profile": {
        "id": "local-coder", "provider": "ollama", "model": "qwen3-coder:30b",
        "contextWindow": 32768, "maxTokens": 4096
      },
      "timeoutMs": 120000,
      "expiresAt": "REPLACE_WITH_AN_ISO_UTC_EXPIRY_WITHIN_24_HOURS"
    }

Replace the IDs, HEAD, owner and expiry with verified values. Review the entire file,
then use the Server admin environment:

    node scripts/agent-approval.mjs grant /absolute/private/approval.json

The administrator gives the approved IDs/instruction/profile to the client. There is
deliberately no MCP approval-grant operation. Revocation is admin-local:

    node scripts/agent-approval.mjs revoke APPROVAL_UUID

Revoking an active approval records cancellation intent and attempts cancellation.
A disconnected Node is still uncertain until it reports real termination. Checkout
archival/reassignment or owner Project archival observed during reports similarly
requests cancellation. Changes to policy files take effect on Node restart.

## MCP usage

agent_start:

    {
      "runId": "44444444-4444-4444-8444-444444444444",
      "approvalId": "33333333-3333-4333-8333-333333333333",
      "checkoutId": "22222222-2222-4222-8222-222222222222",
      "instruction": "Read README.md and inspect the source. Do not execute tests.",
      "profileId": "local-coder",
      "permission": "read-only",
      "timeoutMs": 120000
    }

agent_get accepts runId. agent_events accepts runId, after (default 0), and limit
(default 50, maximum 100). Use the last returned event cursor for the next page.
agent_control accepts runId and action: cancel. It records intent; it does not claim
that process termination happened merely because a cancel command was sent.

No raw paths, executables, shell commands, credentials, environment or extension options
are accepted. Jobs run only in verified linked atlas/* worktrees; primary checkouts,
detached HEAD, changed Git identity, unsafe roots and missing local policy fail closed.
The local operator harness from PR #206 remains available separately.

## States, evidence and retention

States: dispatching, starting, running, cancelling, unknown, completed, failed,
cancelled, timed_out and incomplete. No fresh observation within 15 seconds is surfaced
as unknown, including an unacknowledged start. The original run remains reserved.
Process heartbeat means only that the host has a process observation, not model progress.

Completion requires the bound Node/checkout/HEAD/branch, runtime-ready, agent-started,
agent-settled, successful Pi result, completed terminal event, PID, exit code zero,
no exit signal and complete event delivery. Missing completion evidence yields incomplete.
A terminal-state claim without a terminal timestamp is rejected.

These are authenticated Node process receipts, **not hardware attestation**. Enrolled
Nodes and the reviewed runtime are trusted. A compromised Node can forge its own
telemetry; Atlas does not claim independently verified task success from those receipts.
Model text can never create a test or commit receipt: verifiedTests and verifiedCommits
remain empty and taskSuccessVerified remains false. The read-only tool cannot run tests.

Prompts are sent only for the initial dispatch and are hashed in the database/Node
claim. Raw prompts, assistant prose, file contents, tool arguments/results, stderr,
secrets and arbitrary error text are not persisted as events or returned as results.
Results are process receipts, not a model transcript or code artifact. New explanatory
text/artifacts will require a separately reviewed redaction/access contract.

Each Node keeps 256 metadata events; Server keeps the latest 2,000 per run, with
monotonic source cursors and explicit retention gaps. Reports contain at most 32 events,
are rate bounded and acknowledged only after PostgreSQL commit. Duplicate events cannot
increase execution counters. Reordered events are rejected and retried from the committed
cursor. A source retention gap is recorded and prevents verified completion.
Snapshots and event projections contain only strict allowlisted metadata.

## Disconnects and recovery

A start is sent exactly once from a committed dispatch record. If sending or receiving
the acknowledgement is uncertain, clients reconcile that same run ID; Atlas never
automatically resubmits start. Connection session identities prevent reconnect observation
from racing newly dispatched work. Original requests and node credentials are not used
as durable shell authority.

Server restart/reconnect sends only observe/cancel for prior jobs. A living Node resumes
reports from the Server cursor. Cancellation intent survives restarts. Terminal receipts
and a bounded event snapshot are saved locally for replay if an acknowledgement is lost.

Before spawning, the Node exclusively creates and fsyncs a private claim file and its
directory. Restarted Nodes never execute a claimed ID again. If they cannot recover a
terminal receipt, they report missing; Server displays unknown and keeps Node admission
reserved. Corrupt/unavailable journals also fail closed. The Node handles at most 64
in-memory attempts and stops admission when journal retention needs operator attention.

Unknown is deliberately not a promise that the process stopped. This milestone provides
no force-forget/reset MCP action. An operator must inspect prior process ownership and
worktree state, reconcile the ledger and stale process lock deliberately before approving
new execution. Do not clear journal claims to retry an uncertain ID. Power loss may
preserve a claim without a final receipt; that remains unknown, not automatically failed.

The Pi subprocess exits on parent pipe loss and the supervisor retains its process-group,
deadline and shutdown behavior. macOS sleep, kernel hangs and hostile same-UID processes
still require real acceptance; keep the original PR #206 threat model in PI_WORKER.md.

## Verification and remaining acceptance

    npm run test:agents

Requires the isolated test database configured through TEST_DATABASE_URL. With the
optional Pi runtime installed, tests exercise OAuth MCP over HTTP, real WebSocket routing,
real child processes, actual Pi/native read with a simulated HTTP model, exact approvals,
idempotency, event ordering/retention, cancellation during admission, reconnects, actual
Server restart, Node claim recovery and process failure. Model claims of passing tests
are explicitly checked not to become verified evidence. CI installs the pinned runtime;
without it only the SDK-specific cases skip.

Still required before a real ChatGPT → Atlas MCP → Pi demonstration:
1. Deliberate operator deployment/install of this reviewed milestone (not performed here).
2. Enrol/configure a real Mac, pinned Pi and Ollama model; record exact versions, model
   digest and effective context. Verify the owner OAuth MCP connection can see the tools.
3. Create/register an isolated worktree, install Node policy, grant one exact instruction.
4. Start/poll/cancel from ChatGPT; capture actual receipts and verify no base or worktree
   mutations, no unapproved reads and no inherited credential exposure.
5. Test real sleep/wake, dropped links, Node/process/Server restarts and stale locks.

Write authority remains disabled. Real macOS process/file/network/credential isolation
must be designed and tested before enabling write/edit/bash or untrusted extensions.
This milestone does not close #197/#203 live acceptance or enable subagents/review orchestration.
The monitoring Application is documented in [AGENTS_APPLICATION.md](AGENTS_APPLICATION.md).
