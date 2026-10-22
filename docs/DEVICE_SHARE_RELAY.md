# Atlas device share relay — controlled server slice

Atlas Node protocol v2 can now carry small user-selected text between authenticated
Node WebSockets, **but the relay is disabled by default**. This is only a
transport layer, not a user-ready clipboard or file sharing feature.

## Admin approval

Use **Atlas Web → Nodes → select sending Node → Device sharing** to grant
or revoke one receiver at a time. Approvals are durable, directional, audited
and enforced per submission; managed changes take effect without a restart.
The default remains deny-all. Legacy `ATLAS_DEVICE_SHARE_PAIRS` grants remain
supported but are shown read-only in the UI, and require editing the server
environment followed by restart to remove. See [Node sharing permissions](./NODE_SHARE_PERMISSIONS.md).

The sending Node must advertise `device.share.send` and have a currently
authenticated session; target must be currently connected and advertise
`device.share.receive`. The recipient's runtime must explicitly accept each
delivery; there is **no automatic clipboard access**.

## Behaviour

- Authentication is rechecked per submission against the existing Node credential.
- The Server derives sender identity from its authenticated connection, never a
  sender-supplied field. Strict schemas reject malformed/spoofed envelopes.
- Content is bounded at 16,384 characters, expires after 45 seconds, and is
  never written to files, audit records or databases by the relay.
- Target replies `{accepted:true|false}`. Only `true` means accepted.
- A delivery UUID is idempotent for five minutes within one Server process;
  reusing it with different content fails. The relay rejects more than
  12 new shares per source/minute and rejects when the replay cache is full.
- Offline targets, timeout, invalid acknowledgements and revoked credentials
  produce explicit errors, not a false success.

## Limitations / next milestones

- **Replay state is volatile**: server restarts lose dedupe history. Before
  enabling sensitive or unattended transfer, persist delivery IDs or require
  receiver-side durable deduplication.
- No offline queue, no resume, no permanent inbox, no file streaming.
- Android 0.3.0 offers a foreground-only explicit Send action; its target Node
  UUID is currently entered manually. Mac `device.share.receive` remains
  opt-in and requires approval in the active GUI session.
- Tests use authenticated simulated Node WebSockets and do not require Samsung.
