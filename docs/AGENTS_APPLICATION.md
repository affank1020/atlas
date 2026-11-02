# Agents Application

The global, code-defined `agents` Application extends the durable Pi job service
from #207. Open **Applications → Agents** (`#/applications/agents`). It is an Atlas
Application, not another service, View, chat interface or execution engine.

## Functionality

- Owner-scoped run list, newest first, with status/Node/checkout filters and bounded
  keyset pagination. `agent_list` is also available to the existing owner OAuth MCP
  client. Browser and MCP get/list/events/cancel use the same AgentService projection.
  Filter choices come from the owner's history, capped at 200 Nodes/checkouts with
  an explicit truncation notice; scoped deep links remain available beyond that cap.
- Dedicated run detail (`#/applications/agents?run=UUID`) with actual vs requested
  model profile, Node, Workspace/physical checkout, approved root, branch/HEAD,
  timestamps, elapsed duration, ordered metadata timeline, cancellation and receipts.
- Workspace checkout and Node details show compact active/recent activity and deep
  links to the same run IDs. Node and Workspace records remain authoritative.
- The list refreshes every 3 seconds, detail/events every 2 seconds and previews
  every 5 seconds, with no overlapping polling requests. Events resume after the
  last fetched source cursor, are deduplicated/ordered and capped at 2,000 in browser
  memory. A page reload reads retained history from cursor zero; bounded retention
  and transport gaps are explicitly identified. No job is replayed by a refresh.
- A lost HTTP connection displays the last snapshot with an interrupted-update
  warning. Backend stale/offline observations become `unknown`, including unobserved
  dispatches. Terminal receipts remain terminal when their Node disconnects.
- Cancellation is an owner-only intent, not proof of process termination. There is
  no browser start/approve/retry/forget endpoint or write authority.

Source metadata currently records an owner OAuth client, not a reliable ChatGPT/Relay
client name. The UI says so. No instruction, model transcript, task summary, test
output, diff or PR is invented from metadata. Process completion is distinct from
verified task success; `taskSuccessVerified` is always false and verified tests and
commits remain empty. Enrolled Nodes are trusted reporters, not hardware attestation.

## Browser authentication and deployment

Atlas currently has a **single human owner** authenticated by Caddy Basic Auth,
independent of MCP's verified owner OAuth identity. Existing generic `/api/tools/*`
requests have no authenticated ApplicationCaller and cannot access agent data.
This milestone adds an explicit, disabled-by-default bridge for this owner:

1. Configure the existing MCP issuer/resource/allowed subject. That exact issuer
   and subject are the browser's run owner; no request body/header can select one.
2. Generate a separate random 32-byte hex ingress credential. Store its raw value
   as `ATLAS_AGENTS_WEB_TOKEN` **only in the private Caddy environment** and its
   SHA-256 digest as `ATLAS_AGENTS_WEB_TOKEN_SHA256` in the Server environment.
   Never put either in `VITE_*`, localStorage, a URL or an API response. Do not reuse
   Relay, Node, Basic Auth or other credentials. For example, in a private shell:

       openssl rand -hex 32
       printf '%s' 'THE_GENERATED_VALUE' | shasum -a 256

3. Set `ATLAS_TRUSTED_INGRESS=true`, retain private Server networking, TLS and the
   reviewed Caddy config. Add the exact HTTPS UI origin to `ATLAS_WORKSPACE_ORIGINS`.
4. Apply migration `042_agent_monitoring.sql`, deploy the reviewed Server/Web/ingress
   together and enable the credential deliberately. No deployment was performed here.

After successful Basic Auth, Caddy overwrites `X-Atlas-Agents-Ingress` for
`/api/agents/*`. Server validates that credential in constant time, then injects the
configured owner. Other backend routes strip the header. The public MCP/Node/Portfolio
routes do not grant browser ownership. Direct Server calls, spoofed owner/client
labels, Relay credentials, missing configuration and malformed credentials fail
closed. The integration assumes Caddy and its secret remain trusted and that the
single Basic Auth user is the configured owner; this is not multi-user authorization.
Introducing other human users requires verified per-user identity mapping first.

Private API: POST JSON to `/api/agents/list`, `/get`, `/events`, `/control`, with the
same inputs as `agent_list/get/events/control`. Payloads are capped at 4 KiB; errors
and responses use no-store; no wildcard CORS is issued. Foreign/opaque/cross-site
origins are denied; cancellation additionally requires an explicit approved Origin.
The browser always uses same-origin requests, so local development needs a reviewed
local authenticated proxy and the backend; a direct Vite-to-Server call cannot bypass
this boundary. Frontend demo mode shows no execution records.

Rotating/removing the ingress digest revokes browser access on Server restart. MCP
ownership and its approvals are unchanged. Unknown runs still reserve admission and
require deliberate operator reconciliation as documented in AGENT_SERVICE.md.

## Hierarchy contract

`AgentHierarchyNode` describes an observed agent ID, parent ID, role, state, actual
model profile and recursive children. The UI can render that structure. This worker
currently produces one `root` Pi agent with `parentAgentId: null` and no children.
No synthetic child rows, blocked states, pending approvals or review sessions are
created. Future subagent work must persist authenticated identities and relationships,
validate authority/evidence, add owner-scoped child retrieval and extend the same
MCP projection before enabling child producers. There is no orchestration in this PR.

## Validation and limits

Automated tests cover listing/filtering, equal-timestamp and microsecond cursor paging,
owner isolation, disabled/spoofed ingress, origin/size/schema boundaries, cancellation,
retained event gaps, stale/offline Nodes, UI loading/empty/error states, cursor catch-up,
hierarchy rendering, deep links and identical browser/MCP receipts from an actual
supervised child process. The existing real Pi SDK/native-read test uses a simulated
local model, not live Ollama.

No deployed Mac/Ollama or real ChatGPT-to-Atlas live acceptance is claimed. Follow
AGENT_SERVICE.md and PI_WORKER.md for operator acceptance, including sleep/reconnect,
process failure, cancellation and unchanged checkout verification. Writes, Linux
execution, subagent orchestration, independent Pi review and richer output artifacts
remain separate milestones. Browser durations are elapsed wall time, not progress
percentages or evidence that an uncertain process is still running.
