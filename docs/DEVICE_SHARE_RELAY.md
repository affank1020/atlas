# Atlas device share relay — controlled server slice

Atlas Node protocol v2 can now carry small user-selected text between authenticated
Node WebSockets, **but the relay is disabled by default**. This is only a
transport layer, not a user-ready clipboard or file sharing feature.

## Admin approval (temporary configuration)

Use `ATLAS_DEVICE_SHARE_PAIRS=sourceNodeUUID:targetNodeUUID` to explicitly
permit a *directional* source to receiver pair. Multiple pairs are comma separated.
No wildcard or blanket permission; an unset setting permits no shares.
The Server must restart to apply changed pair policy. A managed permission UI
will replace this operator setting in a later PR.

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
  receiver-side durable deduplication, along with a user-managed pair policy.
- No offline queue, no resume, no permanent inbox, no file streaming.
- Current Mac and Android runtimes advertise no share capabilities by default,
  so even configuring a pair cannot deliver content without a separately
  reviewed recipient approval UI and sender code.
- Tests use authenticated simulated Node WebSockets and do not require Samsung.
