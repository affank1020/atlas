# Mac Node: explicitly approved Android text to clipboard

This adds an **opt-in** macOS GUI receiver to the standard desktop Node. It
does not affect Linux Nodes or previously enrolled macOS Nodes until enabled.

1. On macOS Node in its logged-in GUI session set
   `ATLAS_NODE_SHARE_RECEIVE_ENABLED=true` and restart the Node.
2. The Node advertises `device.share.receive` separately from Workspace
   permissions. In **Atlas Web → Nodes**, select the Android sending Node and
   approve the Mac as a receiver in **Device sharing**. This is an audited,
   durable **directional** approval. Legacy `ATLAS_DEVICE_SHARE_PAIRS` environment
   entries remain supported but are not required for new managed approvals.
3. Each incoming text/share generates a native macOS confirmation dialog,
   showing a short preview and the sender Node ID. Decline is the default;
   there is a 15-second timeout. Only clicking **Copy** writes the **complete** text as an explicit
   plain UTF-8 `NSPasteboardTypeString` through macOS's native pasteboard API.
4. The receiver reports `accepted: true` only after the JXA/AppKit
   clipboard-write subprocess exits successfully. A decline, expiry, process
   stop, or clipboard-write failure is not reported as accepted.

Safety: user content is not passed in shell commands, command-line arguments,
or environment variables. The confirmation dialog receives only a short
preview through `osascript` stdin. **After approval**, the complete text is
UTF-8 encoded and embedded as base64 in a JavaScript for Automation (JXA)
script sent to `osascript -l JavaScript -` on stdin. That script decodes the
bytes and writes an explicit plain-text `NSPasteboardTypeString` through
AppKit, rather than relying on `pbcopy`'s RTF/EPS format inference.
Base64 is an encoding, **not encryption**; the full text is visible to that
local subprocess. This feature does not write share content to server/device
audit logs.

Receiver-side replay cache is memory-only (5 minutes). Restarting the desktop
Node loses it. Keep sharing behind operator-level opt-in until durable
idempotency is implemented. Per-peer managed permissions are available in Atlas
Web, but they do not bypass the Mac approval dialog.

Android 0.4.0 includes an explicit **Send** action and advertises only
`device.share.send`. In its Send screen, the user selects an available,
approved receiving Mac **by name**, reviews the text, and presses **Send** while
the app is connected in the foreground. Importing text through the Android
Sharesheet never sends it automatically. Recipient discovery and every send
are independently authenticated and authorised by the Server. The Mac must
have receiving enabled. The directory does not expose unapproved Nodes.

CI mocks the Mac approval dialog and clipboard operations to verify receiver
semantics without a Mac; the real macOS GUI and clipboard still need
on-device acceptance testing.

For a real Mac clipboard round-trip regression (changes the logged-in user's
clipboard), run `ATLAS_MAC_PASTEBOARD_TEST=1 node --import tsx --test test/mac-device-share.test.ts`
on the Mac GUI session; the test is skipped on normal Linux CI.

**Physical Samsung → Mac acceptance:** follow [Mobile Share E2E](./MOBILE_SHARE_E2E.md)
for the reviewed APK, opt-in configuration, explicit pairing, decline/revocation
checks and safe rollback. This physical verification has not yet been recorded.
