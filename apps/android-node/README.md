# Atlas Android Node (foundation)

Native Kotlin / Jetpack Compose companion, Samsung tablet-first. This is **not** an Android port of the Atlas Web UI.

## Current scope (v0.1.0)

- Adaptive phone/tablet UI: Devices, Send, Inbox, Settings.
- Android Sharesheet target for `text/plain` (text and URLs). Text is held only in memory, never automatically sent or added to the clipboard.
- Explicit **not enrolled / offline** state; Send is disabled. There is no Node credential, socket, file transfer, or background service yet.
- No blanket storage, clipboard, notification or background permissions.

This is a scaffold, **not** a working mobile Node. Native integration must not pass Caddy Basic Auth credentials to the app or silently share selected content.

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

## Next slices

1. Review Node v2 gateway envelope and add typed device capability contracts + authorization (without workspace placement).
2. Enrolment UI backed by the existing one-time ticket API and Android Keystore-backed secret handling; require verified HTTPS/WSS, no cleartext fallback.
3. Foreground authenticated Node registration, reconnect, truthful status and safe revocation handling.
4. Mac receiver and end-to-end text share (explicit target selection / approval); eventually offline inbox and file workflows.

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

## Pairing and presence milestone (stacked follow-up)

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
