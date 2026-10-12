# Atlas Sessions — ChatGPT Project + Atlas coordination

Sessions is an independent tool in **Atlas Web → Tools → Sessions**, not a Football Training application. It runs entirely on the existing Server/PostgreSQL/MCP/Web stack and does not invoke any paid LLM API.

## Start with Projects

You can first use a ChatGPT Project without Atlas: create a coordinator chat, assign bounded tasks to other project chats, and exchange concise handoffs. Project context is helpful background, **not** guaranteed exact task state.

Recommended shared ChatGPT Project instructions:

> When asked to start an Atlas Session, use the Atlas MCP sessions_create tool, keep the returned participantId/credential in this chat, and act as Coordinator. Decompose work into explicit assignments. When asked to join, list active Atlas sessions, join the intended one with sessions_join, and follow the resulting worker briefing. Before resuming work after a long gap, call sessions_sync with your participant credentials. Use sessions_updates to fetch all unseen events from your last cursor. Do not assume project memory is an authoritative task queue. Submit results and blockers through Atlas. ChatGPT conversations cannot awaken other conversations or remain active between user turns. Never claim to have delegated or completed work without receiving corresponding Atlas receipts. Session credentials must not be copied into public documents or event messages.

The project instructions are a behavioural convention, not a system-level execution hook. Atlas enforces coordinator-only writes even if the model drifts, but cannot guarantee a worker stays in a specialist persona on every response.

## Atlas-connected workflow

1. **Coordinator:** “Start an Atlas Session for [objective].” Chat uses sessions_create and becomes coordinator.
2. **Plan:** Coordinator invokes sessions_assign for independent scoped tasks, sets shared summary through sessions_set_summary, and uses sessions_sync before major decisions.
3. **Worker:** Open another chat: “Join my Atlas Session.” It runs sessions_list (clarifies if multiple are active), then sessions_join. It receives a distinct worker credential and atomically claims the highest-priority queued task.
4. **Work:** Worker invokes sessions_sync to rehydrate role/context, sessions_updates to retrieve older missed events, sessions_message for communication, and sessions_submit to report a blocker or deliver work.
5. **Review:** Coordinator invokes sessions_review to accept or requeue submitted work. sessions_requeue recovers an abandoned active/blocked task explicitly; another worker can then claim it via sessions_claim.
6. **Finish:** Coordinator updates the canonical summary and closes via sessions_close. Closed sessions remain visible using the Include closed filter.

No manual ChatGPT chat URL registration. Only the current conversation's participant secret grants mutation rights for its role; if it loses this token, it must join again as a new worker or have the coordinator requeue old work. A coordinator losing its credential cannot silently reclaim privileged control; coordinator replacement requires an explicit future recovery design rather than bypassing authorization.

## Data & failure boundaries

- Migration `015_sessions.sql`: independent tables `atlas_sessions`, `session_participants`, `session_assignments`, `session_events`.
- Every mutating operation locks the session row inside one PostgreSQL transaction; claims cannot double-assign queued tasks.
- Participant tokens are generated using cryptographic randomness, stored only as hashes, never returned by list/get/dashboard, and checked for every privileged mutation.
- Same-session composite foreign keys protect assignment and event ownership.
- Workers cannot create assignments, review/accept work or close a session. Submitted work is not accepted until coordinator review.
- The event stream is append-only and cursor-paged via sessions_updates; the dashboard shows the latest 50 events. Keep the short canonical summary current as an explicit coordinator responsibility.
- Web shows **last check-in**, not inferred online presence. Sessions cannot start LLM turns or send messages into dormant ChatGPT conversations.
- The host's existing MCP OAuth and API deployment trust boundaries still apply; Sessions is not a separate public collaboration/identity platform.

## Deployment & verification

1. Run the standard PostgreSQL migrations using `npm run db:migrate` before starting the upgraded Server. Do not apply the new code against a database missing `015_sessions.sql`.
2. Build with `npm run build`, run `npm test`, and validate the Sessions MCP tools appear in the connected ChatGPT integration after Server deployment/reconnection.
3. Confirm the web route `#/sessions` appears under Tools and can display a newly created session.
4. Smoke test coordinator create, worker join, atomic assignment claiming, blocked/submitted/accepted transitions, event pagination, requeue and closed-session rejection.

## Explicitly deferred

Automatic background reasoning, discovering ChatGPT's internal conversation IDs, autonomous coordinator wake-up, seamless privilege recovery if the coordinator token is lost, and isolated git worktrees are **not implemented**. Those need separate designs and tests before promotion to a more autonomous or long-running workflow.
