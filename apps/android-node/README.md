# Atlas Android Node (0.4.0 test build)

Native Kotlin / Jetpack Compose companion, Samsung tablet-first. This is **not** an Android port of the Atlas Web UI.

## Current scope (v0.4.0)

- Native Kotlin/Compose phone/tablet app with Devices, Send, Inbox and Settings.
- One-use enrolment via publicly trusted HTTPS; Android Keystore-encrypted Node credentials and authenticated foreground WSS.
- Android Sharesheet `text/plain` import with memory-only draft. The app sends **only** when the user chooses an approved receiving Node by name and taps **Send**.
- Advertises `device.share.send` only. Recipient directory is sender-scoped and unauthorised/offline targets are not selectable. Server reauthorises each share.
- No Workspace capabilities, receiving inbox, file transfer, automatic send, blanket clipboard permission or background service.

This is a **test build**, not a production-ready mobile Node. Real Samsung → Mac acceptance and stable signing are outstanding. Native integration must not pass Caddy Basic Auth credentials to the app or silently share selected content. See [physical acceptance and rollback](../../docs/MOBILE_SHARE_E2E.md).

## Develop / sideload

Open `apps/android-node` in Android Studio, with Android SDK 35, JDK 17 and Gradle 8.11.1. Or use an installed Gradle 8.11.1:

```sh
cd apps/android-node
gradle :app:assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

CI builds a debug APK on Android-specific changes. It is **not** production-signed. The app intentionally lives inside `apps/` without a `package.json` and does not change the npm build/test graph.

## Version contract

See [mobile architecture and releases](../../docs/MOBILE_NODES.md). Gradle properties are the single source for `versionName` and `versionCode`. The Android app version is independent from Atlas Server/Node npm `2.0.0` and the wire protocol `2`.

## Implementation milestones

1. Typed device capability contracts, authenticated routing and targeted authorization — implemented.
2. One-time ticket enrolment, encrypted identity and foreground Node registration — implemented.
3. Opt-in Mac receiver, directional managed approvals and explicit Android text send — implemented, pending physical verification.
4. Approved receiver discovery by name — implemented in Android 0.4.0.
5. **Next gate:** Samsung → Mac accept/decline, Unicode, offline/reconnect and revocation [E2E checks](../../docs/MOBILE_SHARE_E2E.md). Durable inbox, background delivery and file transfers remain outside this slice.

Refer to [Atlas Connect](../../docs/atlas-connect-roadmap.md) for the broader milestones.

## Tests and repeatable APK installation

CI runs host JVM reducer regression tests (`gradle :app:testDebugUnitTest`) and builds both
app and Compose instrumentation test APKs. Run `gradle :app:connectedDebugAndroidTest` on
an Android emulator/connected device for real navigation and Sharesheet UI tests.
Share drafts survive tab changes and Activity recreation in a volatile-only ViewModel:
no SavedState, backup, logging, or disk persistence of received content.

CI debug APKs are **signed with ephemeral keys**; installing an APK from another
runner may require an uninstall (which destroys local app data). Do not enrol
a real device from a CI debug APK until we introduce a stable development signer.

## Pairing and presence milestone (implemented before 0.4.0)

Android now accepts one-use enrolment tickets from Atlas Web, sends a strictly HTTPS
`POST /node/enrol`, encrypts the resulting Node UUID/credential with an Android
Keystore AES-GCM key, and connects over authenticated WSS using protocol 2.
It registers with **no device/workspace capabilities**, so it is online in Nodes
without the ability to execute privileged Workspace requests.

The WebSocket is foreground-only, with bounded reconnect/backoff; backgrounding
the app disconnects it and status reflects that. The user can clear credentials
locally, but must revoke the Node separately in Atlas Web. Do not confuse this
with a messaging-ready app: the Send button remains disabled until authorised
`device.*` routing and a Mac receiver are implemented.

The Node must be accessed via a publicly trusted HTTPS origin. Do not
sideload consecutive ephemeral CI debug APKs and expect credentials to survive
reinstall: create a stable development signing identity before enrolled-device
upgrade tests. Local encrypted identity has no backup recovery; rotate/re-enrol
after reinstall or keystore loss.

## Recovery after interrupted pairing

The one-time Node ticket is consumed by Atlas Server before it returns an
identity. The app now finishes the bounded HTTPS exchange and encrypted save
in one non-cancellable IO critical section. Before saving, it records **only**
the issued Node UUID as a non-secret recovery marker. An encrypted save clears
this marker atomically with writing the credential.

If Android cannot persist the credential, the app displays the Node UUID and
recovery instructions. Open **Atlas Web → Nodes**, revoke that Node, then
generate a new one-use ticket. If the app is killed before a response or the
credential becomes undecryptable, inspect Atlas Nodes for the Android Node by
name and revoke it there. No recovery flow reveals or stores credentials in
plaintext. A JVM regression suite injects failures at both persistence stages.

A foreground-to-background transition cancels the WebSocket immediately,
including when it is mid-handshake. Emulator tests exercise Compose draft
navigation/re-import through an isolated Compose rule; no duplicate Activity
instance is launched by the test harness.

## 0.3.0 — Explicit Android text sender (historical manual recipient)
Android now advertises only `device.share.send`, not `device.share.receive`
or any Workspace access. In the Send tab the user chooses a target **Node UUID**
from Atlas Web, edits/approves the text, and explicitly presses Send. Content
is never sent automatically when Android receives a Sharesheet Intent.

Only an active foreground WSS connection can send, over the existing
per-Node credential. Messages use separate request/delivery UUIDs and bounded
text; the receiver must be approved on Atlas Server and return a real receipt.
Status distinguishes accepted, declined, unavailable and unconfirmed delivery.
Stale/out-of-order acknowledgements cannot mark another send as accepted.
An outbound attempt has no offline queue and is not retried after disconnection.

In 0.3.0 the recipient picker was **manual** because native Nodes must not
reuse Atlas Web's Basic Auth/admin-only API. Android 0.4.0 replaces it with an
authenticated, sender-scoped directory, while retaining explicit Send.

While a send awaits acknowledgement, a second Android Share intent is held
in a volatile deferred slot, rather than replacing the on-screen text that
was actually submitted. After the acknowledgement, **Load newest shared item**
explicitly switches to the new draft. If several incoming shares arrive
while pending, only the most recent is retained (no background queue).

## 0.4.0 — Approved recipient picker

Android uses the authenticated foreground Node WebSocket to request a bounded,
sender-scoped directory of approved receiving Nodes. **Only** Nodes explicitly
authorised to receive text from this Android identity are returned, with
display names, platforms and live receiving readiness. Other Node registry
records and admin-only management tools are not exposed to Android.

The Send tab lets the user select a **ready device by name**; manual recipient
UUID entry is removed. Offline/unavailable approved devices are shown but
can't be selected. The list loads on connection and can be refreshed manually.
Connection loss, authentication failure and directory-read failure clear the
selectable list (fail closed). Shared text remains memory-only; every send is
explicit and re-authorised against current policy by the relay.

The server rate-limits directory reads per authenticated socket and never
persists contents or directory responses. Re-enrolment and Node updates still
require normal trusted APK signing and end-to-end device testing.
