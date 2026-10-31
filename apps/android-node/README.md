# Atlas Android Node (0.7.0 development build)

Native Kotlin / Jetpack Compose companion, Samsung tablet-first. This is **not** an Android port of the Atlas Web UI.

## Current scope (v0.7.0)

- Native Kotlin/Compose phone/tablet app with Devices, Send, Inbox and Settings.
- One-use enrolment via publicly trusted HTTPS; Android Keystore-encrypted Node credentials and authenticated WSS (foreground by default, optional background service).
- Android Sharesheet text/link import with memory-only draft. Since merged PR #161, user-selected PNG/JPEG images (up to 8 MiB) can also be imported and previewed locally. **Images cannot yet be sent**: the image Send button stays disabled until a separately authorized binary transport is implemented. See [image handoff plan](../../docs/MOBILE_IMAGE_HANDOFF.md). Text sends still require an approved recipient and explicit Send.
- Advertises `device.share.send` and `device.share.receive`; the Node disconnects on backgrounding unless the operator turns on Background receiving in Settings. Recipient discovery and every delivery require directional server approval; unauthorised/offline devices aren't selectable.
- Inbound text appears in a short-lived native Copy/Decline dialog on top of any screen. **Only** a human Copy action writes the Android clipboard and causes an accepted receipt; dismissal and timeout decline. No auto-copy or implicit background clipboard write.
- No Workspace capabilities, on-device plaintext inbox persistence, file transfer, automatic send or blanket clipboard permission. The optional remote-messaging foreground service provides best-effort live receiving; it is not offline delivery.

This is a **test build**, not a production-ready mobile Node. A first Samsung → Mac text-copy test succeeded, but the full acceptance matrix, the negative-case Mac → Android physical acceptance matrix, and production signing/release remain outstanding; the local persistent debug signer described below is only for physical development testing. Native integration must not pass Caddy Basic Auth credentials to the app or silently share selected content. See [physical acceptance and rollback](../../docs/MOBILE_SHARE_E2E.md).

## Develop / sideload

Open `apps/android-node` in Android Studio, with Android SDK 35, JDK 17 and Gradle 8.11.1. Or use an installed Gradle 8.11.1:

```sh
cd apps/android-node
gradle :app:assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

CI builds a debug APK on Android-specific changes, but its runner-specific signing key is ephemeral: the artifact is for **CI validation only**, never enrolment or upgrade testing on a real Samsung. For physical acceptance, build locally under one developer OS user with a **persistent** `~/.android/debug.keystore`, verify the signing fingerprint and install that APK **before** enrolling. Follow the [required build, signing verification, and revocation procedure](../../docs/MOBILE_SHARE_E2E.md). Debug signing is for development testing, not production distribution.

The app intentionally lives inside `apps/` without a `package.json` and does not change the npm build/test graph.

## 0.7.0 — Explicit queued-text Inbox

Android 0.7 advertises the new **`device.inbox.receive`** capability in addition to its existing live `device.share.receive`. Previous Android builds and live-only Mac Nodes do **not** advertise it and cannot be queued to. Atlas Server checks this capability again before storing each message, preventing misleading success for unsupported recipients. Android retrieves encrypted-at-rest queued text from Atlas only after it reconnects and the user opens **Inbox → Refresh**. Listings disclose only sender IDs and delivery metadata, and **Review** obtains one decrypted item into process memory. Copy and Decline are explicit user decisions. Neither the server nor Android automatically changes the clipboard, and no text goes to SavedState or disk.

Requires a server-only `ATLAS_DEVICE_INBOX_KEY` and the Mac `./atlasctl share --queue` command from the corresponding Node update. Does not include FCM, instant screen-off delivery or image transport. See [offline inbox setup](../../docs/MOBILE_OFFLINE_INBOX.md).

## Version contract

See [mobile architecture and releases](../../docs/MOBILE_NODES.md). Gradle properties are the single source for `versionName` and `versionCode`. The Android app version is independent from Atlas Server/Node npm `2.0.0` and the wire protocol `2`.

## Implementation milestones

1. Typed device capability contracts, authenticated routing and targeted authorization — implemented.
2. One-time ticket enrolment, encrypted identity and foreground Node registration — implemented.
3. Opt-in Mac receiver, directional managed approvals and explicit Android text send — implemented; first real Samsung → Mac copy confirmed.
4. Approved receiver discovery by name — implemented in Android 0.4.0.
5. Foreground Android Copy/Decline receiver — implemented in 0.5.0. Mac-side sender merged in PR #82; an initial physical Mac → Samsung text Copy transfer succeeded on 31 October 2026. The negative cases still need acceptance.
6. Android 0.6.0 adds an opt-in background service and content-free notifications for *live* text receiving while using other apps.
7. Android 0.7.0 connects its Inbox tab to the encrypted offline queue from server PR #175, with manual Refresh, Review, Copy and Decline. The Mac sender queues text with `./atlasctl share --queue` and its separate native confirmation. A queued receipt does **not** mean copied.
8. **Next gate:** physical Samsung queued-text acceptance and FCM wake-up for sleeping tablets; complete [E2E cases](../../docs/MOBILE_BACKGROUND_RECEIVER.md). Screenshot import remains preview-only.

Refer to [Atlas Connect](../../docs/atlas-connect-roadmap.md) for the broader milestones.

## Tests and repeatable APK installation

CI runs host JVM reducer regression tests (`gradle :app:testDebugUnitTest`) and builds both
app and Compose instrumentation test APKs. Run `gradle :app:connectedDebugAndroidTest` on
an Android emulator/connected device for real navigation and Sharesheet UI tests.
Share drafts survive tab changes and Activity recreation in an application-scoped volatile-only ViewModel:
no SavedState, backup, logging, or disk persistence of received content.

CI debug APKs are **signed with ephemeral keys**; they are unsuitable for
enrolled real-device testing. Use a **locally built** debug APK whose Android
debug signing keystore (`~/.android/debug.keystore`) remains stable across builds.
Record the APK signing certificate SHA-256 fingerprint and verify it stays
the same **before** updating the app. A signer mismatch must not be handled by
an unplanned uninstall: revoke the enrolled Node in Atlas Web first, then
reinstall and re-enrol. Do not commit, upload or distribute this debug keystore.
See the [physical test runbook](../../docs/MOBILE_SHARE_E2E.md).

## Pairing and presence milestone (implemented before 0.4.0)

Android now accepts one-use enrolment tickets from Atlas Web, sends a strictly HTTPS
`POST /node/enrol`, encrypts the resulting Node UUID/credential with an Android
Keystore AES-GCM key, and connects over authenticated WSS using protocol 2.
The initial pairing milestone registered with **no device/workspace capabilities**.
Android 0.4.0 advertised only `device.share.send`. Android 0.5.0 also offers
`device.share.receive` while its foreground-only Node socket is active;
neither version offers Workspace access.

The WebSocket is foreground-only, with bounded reconnect/backoff; backgrounding
the app disconnects it and status reflects that. The user can clear credentials
locally, but must revoke the Node separately in Atlas Web. Android can send
explicit text shares **only** when the Server authorises the directional
pair and the target is ready to receive.

The Node must be accessed via a publicly trusted HTTPS origin. Local debug
builds made under the same OS user use the same persistent development keystore;
CI builds do not. Local encrypted identity has no backup recovery; revoke and
re-enrol after an intentional reinstall, lost signing keystore, or Android
Keystore credential loss.

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

## 0.6.0 — Opt-in background receiver (foreground service only)

- In Settings, enable **Background receiving** and grant Android 13+ notifications. Atlas checks **app-wide notifications and both incoming/status channels**, refuses background delivery when blocked, and offers **Open notification settings** to recover; while running it rechecks channel availability. Atlas starts a `remoteMessaging` foreground service and displays an ongoing Stop notification. Only this active service or an open Activity owns a single application-scoped authenticated Node WebSocket; no duplicate Node registrations.
- While another app is visible, new incoming approved text raises a content-free notification. Tap it quickly to open the Atlas Copy/Decline dialog. The existing 15-second expiry remains enforced; receipt is accepted **only** after a foreground user Copy action. No automatic clipboard writes, intrusive activity launches, lockscreen previews, or durable content cache.
- The service stops when the user selects Stop, forgets the Node, or Android terminates it. It is not automatically launched at boot or resumed after force-stop. It does **not** guarantee receipt with the screen off or under Doze, and **there is no push or offline inbox**. See [background delivery issue #163](https://github.com/affank1020/atlas/issues/163) for the next server+FCM slice.
- App versionCode is now 6. Build and upgrade on the same private persistent signing key; do not install the ephemeral CI debug APK over an enrolled device.

## 0.5.0 — Foreground Android text receiver

The Node socket registers `device.share.receive` alongside send while the app is
open. The server must independently approve the **sender → Android** pair.
A strict, bounded incoming text request triggers an ephemeral Compose dialog
with a sender ID preview and **Copy** / **Decline** actions on any app tab.
No content is written to the clipboard or acknowledged as accepted until
the Android user explicitly selects Copy and the clipboard API returns.
Decline, dismissal, expiry (at most 15 seconds), copying errors, backgrounding
and disconnection fail closed; second concurrent incoming requests are rejected.
The Inbox tab shows only status, **not stored message content/history**.

The existing signed development APK may be upgraded using `adb install -r`
when the locally retained `~/.android/debug.keystore` signing identity matches;
keep the Android Node enrollment and credentials intact. Bumping
`versionCode` to 5 is required for this installable update. Do not reinstall
a CI-signed APK over the enrolled device.

A Mac-side explicit sender was subsequently merged in PR #82, but the reverse
direction still requires physical acceptance; do not infer it from advertised capabilities.
