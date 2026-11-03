# Durable Pi child-agent telemetry

This is the server/protocol/UI foundation for roadmap #202, **not** a subagent
launcher. PR #208 already renders a root execution; this change permits a reviewed,
authenticated Pi Node runtime to report real child lifecycles once the pinned extension
is independently integrated. No new child execution permission, model-provider authority,
write access, network capability or PR publication is enabled here.

## Wire protocol

Each child is a UUID scoped to one root run. The first event must be
`child_start` with `agentId`, `parentAgentId`, a bounded role
(`scout`, `worker`, `reviewer` or `general`) and a requested model profile ID.
`parentAgentId` must be the root run ID or a previously observed, still-live child.
Subsequent `child_state` (`starting` or `running`) can include the actual
resolved model profile; `child_terminal` must provide a terminal state. A child
cannot complete successfully while its descendants are still live.

All child reports share the root run's authenticated Node transport, source cursor,
durable append-only event stream, owner identity and permissions. A missing or duplicate
child state transition rejects that report transaction. At most 32 child IDs are
materialised per root. The system does not accept a child name, raw prompt, tool
arguments, model output, filesystem path or arbitrary provider URL in events.

The `agent_children` table materialises state from **accepted events only**. The
Server builds the hierarchy for `agent_get`, `agent_list` and the Agents Web
application; it does not create synthetic children or infer success from model prose.
An observed child must terminate before the root can be marked completed; otherwise
root completion becomes incomplete. If the root Node is stale/offline, running children
are reported as unknown, while confirmed terminal children retain their terminal state.

## Integration still required

The pinned Pi subagents extension must emit these events from its actual lifecycle
hooks, not from the model's text; enforce agent-level tool and model restrictions; and
remain inside the supervised Node's approved checkout and process boundary. The
extension is deliberately **not installed or enabled** by this PR. The next work
requires source review/version pinning, explicit read-only child execution tests, and
a separate OS sandbox plus approval before any write-enabled child.

## Verification

`npm run test:agents` covers protocol rejection, tree reconstruction and
authenticated run/report persistence across MCP and Web. Tests have been added to
the repository but were not executed in a live Node environment for this code-only
pass; production acceptance remains deferred.
