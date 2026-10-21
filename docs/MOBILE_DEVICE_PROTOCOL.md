# Atlas mobile device message contract (A1, proposal)

This isolated change introduces **schemas only**. It does not expose a device-command
endpoint, change the current `execute` Workspace binding, grant sending permission
to any existing Node or deliver data to a clipboard. The existing gateway continues
to reject unsolicited new message types until a separately reviewed authorization
and delivery implementation lands.

## Capability model

- `device.share.send`: a Node may request sending user-selected text to a chosen target.
- `device.share.receive`: a Node may receive a bounded share *and ask its user for
  approval*. These are declarations, not blanket OS permissions.
- Both capabilities are additive protocol-v2 registration claims. Android v0.2
  currently advertises `[]`, and old Mac/Linux Nodes are unchanged.

## Envelope rules

- Source requests carry a target UUID, a caller-generated delivery UUID for
  idempotency, a request correlation UUID and 1–16,384 characters of text.
- Source **cannot supply its own source Node identity**, authorisation, TTL or
  Workspace. The Server will derive identity from the authenticated WebSocket,
  check sender/target eligibility and permissions, allocate a bounded expiry
  and audit the action **without storing text in audit logs**.
- Target delivery includes the authenticated source UUID and server-assigned
  expiry. Target explicitly returns `{accepted: true|false}`. A queued or
  merely routed message must not be reported as delivered.
- Reject expired, replayed, unsupported, oversized and unauthorised submissions
  **before** applying any side effect. Deduplication and authorisation must
  use server-side and receiver-side state; schema validation is not sufficient.

## Integration gates before enabling

1. Server gateway needs authenticated Node-to-Server submission routing with
   per-target permission checks, rate limits, replay protection, TTL and explicit
   receipt tracking; no unauthenticated public HTTP forwarding.
2. A desktop receiver must expose a user-approved share handler independently
   of Workspace roots. Do not silently modify clipboard on receipt.
3. Android sender needs a trusted device picker and safe delivery statuses.
4. Integration tests must simulate two separately credentialed Nodes and confirm
   spoofing/replay/denial/offline/timeout cases, with real-device confirmation later.

The Cloudflare Files work and mobile binary transfer remain independent.
