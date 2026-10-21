# Mac Node: explicitly approved Android text to clipboard

This adds an **opt-in** macOS GUI receiver to the standard desktop Node. It
does not affect Linux Nodes or previously enrolled macOS Nodes until enabled.

1. On macOS Node in its logged-in GUI session set
   `ATLAS_NODE_SHARE_RECEIVE_ENABLED=true` and restart the Node.
2. The Node advertises `device.share.receive` separately from Workspace
   permissions. On Atlas Server, configure a directional
   `ATLAS_DEVICE_SHARE_PAIRS=androidNodeUUID:macNodeUUID` approval.
3. Each incoming text/share generates a native macOS confirmation dialog,
   showing a short preview and the sender Node ID. Decline is the default;
   there is a 15-second timeout. Only clicking **Copy** sends the **complete**
   text to `pbcopy` on stdin.
4. The receiver reports `accepted: true` only after `pbcopy` succeeds.
   Reject, expiry, process stop, or a GUI clipboard failure is not a success.

Safety: no shell, `osascript` or `pbcopy` receives user content in command-line
arguments or environment variables. Short preview is sent only through
`osascript` stdin. The full text is sent only through `pbcopy` stdin.
The content is never written to server/device audit logs by this feature.

Receiver-side replay cache is memory-only (5 minutes). Restarting the desktop
Node loses it. Keep sharing behind operator-level opt-in until the durable
idempotency and per-peer permissions UI work ships.

The Android Share screen remains disabled until a sender UI and capability
claim are added. The tests mock GUI and clipboard operations on CI, so a Mac is
not needed to verify approval semantics.
