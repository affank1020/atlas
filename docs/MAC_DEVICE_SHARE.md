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

## Mac → Android 0.5.0: explicit local clipboard sender (development)

This is a **separate direction** from Android → Mac, and remains a physical
acceptance candidate until verified on the Samsung. The Server still requires
an **independent** Mac → Android managed sharing approval; granting Android →
Mac does not imply the reverse permission.

1. Install Android **0.5.0** from reviewed sources using the same local,
   persistent debug signer as your enrolled 0.4.0 APK. Verify the APK signing
   certificate before `adb install -r`; never use the CI-signed APK on an
   enrolled tablet. Keep the tablet app in the foreground and confirm it
   advertises `device.share.receive` in Atlas Web.
2. In the Mac's private `apps/node/.env.node`, set
   `ATLAS_NODE_SHARE_SEND_ENABLED=true`. Preserve Node UUID and credential.
   Restart only the Mac Node with `./atlasctl restart`. Verify the Mac
   advertises `device.share.send` alongside its existing capabilities.
3. In Atlas Web → Nodes, select the **Mac sending Node** → Device sharing →
   approve the Android receiving Node. This is a one-way Mac → Android grant.
4. Copy harmless text or a link on Mac, then run `./atlasctl share` in an
   **interactive Terminal** on that same Mac user session. It reads the
   clipboard only on that explicit invocation (nothing is passed in CLI
   arguments), lists **ready, approved** targets from the Server, and
   requires choosing a number, then approving a **native macOS Send / Cancel**
   dialog before submitting. The Node enforces this decision independently
   even if a local process talks to the private socket directly.
5. Keep the tablet app open. It should show a short-lived native dialog with
   Copy / Decline. **Copy** writes the full plain text to Android's clipboard
   and acknowledges; decline or 15s timeout must not alter the clipboard.
   A disconnect, timeout or unknown result is unconfirmed: do not
   automatically retry without checking the receiving device.
6. Test Unicode, newlines, declined shares, backgrounded tablet, stale
   directory approval and live revocation. Remove temporary managed grants
   when done; set `ATLAS_NODE_SHARE_SEND_ENABLED=false` and restart the
   Mac Node if sender access is no longer desired.

Implementation details:
- A 0600 UNIX socket under the user's 0700
  `~/Library/Application Support/Atlas` directory forwards only a bounded
  `recipients` or `send` request to the **existing, already authenticated**
  Mac Node process. The Node itself requires macOS GUI confirmation before
  sending, not merely CLI confirmation. No second Node registration or
  credential handoff occurs.
- The Node creates unique request and delivery IDs, correlates replies,
  bounds timeouts/in-flight requests, and clears outstanding requests on
  disconnection. The Server rechecks target capability and directional grant
  for each send.
- The command does **not** accept message contents in argv, save a draft,
  log the clipboard, automatically send, or keep an offline queue.
- The Android receiving dialog remains foreground-only and transient; no
  persistent inbox, file transfer, or bidirectional clipboard sync is implied.

