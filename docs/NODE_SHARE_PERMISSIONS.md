# Atlas device-share permissions

The **Nodes** page now manages persistent, directional Node-to-Node text-share
approvals. Select a sending Node, then in **Device sharing** approve an
individual receiving Node. Approvals are not reciprocal. Both Nodes must have
active credentials to create a grant; they may be offline at configuration
time. Revoke access using the same panel. Grants are audited and enforced on
every submission without restarting Atlas Server.

The underlying `node_share_approvals` PostgreSQL table is created by migration
`026_node_share_approvals.sql`. A Node credential revocation also removes
its managed incoming/outgoing approvals. At most 64 directional grants may
exist. Grants provide **neither** Workspace rights nor an automatic right to
read the clipboard. The destination must be online with
`device.share.receive`, and the Mac asks the logged-in user before writing
the clipboard.

For backwards compatibility, `ATLAS_DEVICE_SHARE_PAIRS` is still accepted,
environment-only pairs appear as **Read-only**. Both a database grant and an
environment grant may be active for the same directional pair. The Nodes page
shows **both independent origins** and permits removing the Atlas-managed
grant even while the environment grant remains active. The remaining
environment permission still authorises sharing. To retire access entirely,
revoke the Atlas-managed approval, then remove the environment pair and
restart the Server. An environment-only pair cannot be revoked through the UI.
With no grants anywhere, sharing is denied by default.

Android 0.4.0 uses a scoped, Node-credential-authenticated recipient directory
to display only the sending Node's approved receivers **by name**. Offline or
not-ready approved devices cannot be selected, and revoking a grant prevents
new sends even if the client has stale directory data. The directory does not
expose the whole Node registry or grant Workspace access. Android still sends
only after an explicit button press. For physical acceptance and rollback, see
[Mobile Share E2E](./MOBILE_SHARE_E2E.md).
