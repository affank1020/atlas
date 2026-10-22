# Android 0.4.0 → macOS text-share acceptance (manual, opt-in)

This is the **physical device release gate**, not an automated proof of success. Run on a Samsung Android device and a Mac with an active, logged-in GUI session. The Android app sends **text only**, in the foreground, over its authenticated Node v2 WebSocket. There is no offline delivery, automatic clipboard sync, or file transfer.

## Before changing anything

- Verify Atlas Server has the merged recipient-directory gateway and managed pair approvals (PRs #55 and #62). Verify the Mac runs a Node build containing the opt-in share receiver; deployed version labels alone are insufficient.
- **Required before enrolling a real Samsung device:** build and install the Android APK **locally, under the same OS user, with a persistent development signing key**. Gradle's standard debug build uses `~/.android/debug.keystore`; keep this same keystore for every test-device upgrade. Do not use a CI APK for enrolment. See the build instructions below.
- [Android Node Actions](https://github.com/affank1020/atlas/actions/workflows/android-node.yml) publishes `atlas-android-node-debug` as a **CI validation artifact only**. CI runners use ephemeral signing identities: their APKs are **not suitable for enrolling a real device or testing upgrades**.
- Before uninstalling or replacing an enrolled app with an incompatible signature, **revoke its Android Node identity in Atlas Web first**. Uninstalling deletes local encrypted credentials. Never commit, upload, or send `debug.keystore` or one-use enrolment tickets to CI, GitHub issues, or PRs.
- Confirm normal Atlas Mac Node operations still work. Make a note of the Mac clipboard contents if needed: successful acceptance **replaces them**.
- Obtain operator approval before changing the Mac Node's environment, granting a sharing pair, or installing/enrolling the Android app. Keep a plan to remove the temporary approvals afterwards.

## Build and verify the consistently signed test APK

Use a separate clean checkout of reviewed Atlas source containing Android 0.4.0 (merged PR #62), not an uncommitted feature worktree. The commands below run on the development **Mac** with JDK 17, Android SDK 35/build-tools 35.0.0, platform-tools and Gradle 8.11.1 installed; `gradle` must be that installed version. They do **not** deploy Atlas or change the Mac Node configuration.

```sh
git clone https://github.com/affank1020/atlas.git atlas-mobile-acceptance
cd atlas-mobile-acceptance
git status --short                # must be empty
git rev-parse HEAD               # record the exact source commit
cd apps/android-node
gradle :app:testDebugUnitTest :app:assembleDebug --no-daemon

# Verify APK signing and record the signer SHA-256 fingerprint and file checksum.
# Use the same host user / ~/.android/debug.keystore on every rebuild.
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
"$SDK/build-tools/35.0.0/apksigner" verify --print-certs app/build/outputs/apk/debug/app-debug.apk
shasum -a 256 app/build/outputs/apk/debug/app-debug.apk

# After connecting the Samsung with USB debugging approved:
"$SDK/platform-tools/adb" install -r app/build/outputs/apk/debug/app-debug.apk
```

Verify that `~/.android/debug.keystore` is retained **privately on the development Mac**. The first local build may generate it; record the signer fingerprint from `apksigner` and confirm it stays identical for subsequent builds. Gradle debug signing is appropriate for this controlled acceptance test, **not** for a public release. Do not publish the keystore or treat this as production signing.

Before any repeat install or update, compare the APK's certificate SHA-256 fingerprint with the previous installed test build's recorded fingerprint. **If it differs, do not uninstall or force installation**: revoke the old Node in Atlas Web, then deliberately reinstall and re-enrol with a new one-use ticket. If `adb install -r` fails due to signature mismatch, apply this same revoke-first procedure; never delete an enrolled identity merely to bypass an install error.

## Enable a single test receiver (Mac)

1. Update the installed Mac Node if necessary; perform the test in its logged-in desktop session, not a headless service session.
2. Set `ATLAS_NODE_SHARE_RECEIVE_ENABLED=true` in the Mac Node's existing private configuration (`apps/node/.env.node` for the repo-managed installation). Preserve its Node ID and credential; never paste those values into tickets or logs.
3. Restart **only the Mac Node**, for example through `./atlasctl restart` from the Atlas repository if that controls the installed process.
4. In **Atlas Web → Nodes**, verify the Mac is online and advertises `device.share.receive`. If it does not, stop: do not try to fix it by granting Workspace capabilities.

## Enrol Samsung and approve one direction

1. Verify the **locally built and consistently signed** APK above is installed (not the CI artifact), open **Settings**, and use the app's normal one-use enrolment flow against the publicly trusted Atlas HTTPS endpoint. Enter the one-use ticket from Atlas Web. The app stores its credential with Android Keystore; never copy a desktop Node token to the phone.
2. Keep the app in the foreground. In **Atlas Web → Nodes**, verify the Android Node appears online with `device.share.send` and **without** Workspace capabilities or `device.share.receive`. If not, stop and investigate.
3. Select the **Android sending Node** in Atlas Web, open **Device sharing**, and approve the **Mac receiving Node**. This is directional: Android → Mac. Do not add the reverse pair or wildcard permissions. Prefer the managed UI; legacy `ATLAS_DEVICE_SHARE_PAIRS` environment grants need a Server restart to remove.
4. On Android, open **Send** and use **Refresh devices** if necessary. The approved Mac should appear by name, selectable only while connected with receiving enabled. An unapproved Node must never appear.
5. If the Mac is missing, check sender identity, direction of the pair, Mac readiness and the live Server gateway version. Do **not** work around a missing recipient with the Atlas admin API.

## Acceptance matrix

Use harmless test text, not passwords or private documents. After every step, record **pass/fail**, the device/app versions, expected versus observed behaviour and the relevant Node IDs *only if appropriate to share*. Never include the text of a sensitive clipboard transfer or any credentials.

| Case | Operator action | Required outcome |
| --- | --- | --- |
| A — accept | Share a distinctive string or link to Atlas via Android Sharesheet, select the approved Mac, press **Send**, then click **Copy** in the Mac prompt | Android reports accepted **only after** Mac clipboard write succeeds; pasting on Mac reproduces the exact text |
| B — decline | Send a new string, click **Decline** or dismiss the Mac prompt | Android reports decline/not accepted; Mac clipboard remains unchanged |
| C — timeout | Send and do not respond to Mac prompt for >15 seconds | No false accepted status; clipboard unchanged |
| D — Unicode | Accept text with emoji, accents, newlines and non-ASCII characters | Mac paste matches original Unicode and line breaks exactly |
| E — unavailable | Disable Mac receiving or disconnect Mac; refresh Android recipients | Mac is absent or shown offline/not ready and cannot be selected; no successful send |
| F — live revocation / stale recipient | With Mac online and receiving enabled, select it and prepare text **before** revocation. Revoke the Android → Mac managed approval while keeping Android connected; press **Send before any Refresh devices or reconnect**. Only then refresh. See exact steps below. | Stale send is rejected with server `SHARE_DENIED` (Android: **This receiving Node is not approved in Atlas.**); no new Mac prompt or clipboard write. After refresh, the Mac disappears. |
| G1 — foreground/reconnect | With an approved Mac receiver, background Android with **no transfer pending**, reopen and refresh after reconnection | Android is offline in background and returns online only after foreground authentication; recipient directory repopulates on reconnect |
| G2 — interrupted in-flight send | With the grant restored and Mac online, send harmless text and **while the Mac approval prompt is open** background Android, then reopen it. See exact steps below. | The interrupted request is **not confirmed** by Android; reconnect must not automatically send it again, generate a second Mac prompt, or produce a false accepted receipt |
| H — no leak | Inspect ordinary app/Server activity and error states during the session | No share text or credential in audit/logs; unauthorised devices not exposed by the directory |

### Exact procedure: F — revoke while the recipient is cached

1. Restore Mac receiving and reconnect it if case E disabled it. In **Atlas Web → Nodes → sending Android Node → Device sharing**, confirm that this Android → Mac pair has **one active managed grant and no independent legacy `ATLAS_DEVICE_SHARE_PAIRS` environment grant**. If an environment grant still authorises the pair, **do not claim this test passes**: removing the managed grant alone cannot block sharing. Arrange a separate, authorised test configuration without that legacy grant first.
2. Keep Android open and **Online**; press **Refresh devices** while the grant is active, wait for the approved Mac to appear, **select the Mac**, and enter distinct harmless text in the Send draft. Confirm **Send** is enabled and the Mac is not showing an earlier share confirmation dialog.
3. Using Atlas Web, **revoke the managed Android → Mac approval**, but **do not** refresh recipients, navigate away from Send, background/disconnect the Android app, or reselect the receiver. The original ready Mac must remain in the Android app's cached selection for this test.
4. Immediately press Android **Send** with that stale selected recipient. **Pass only if** the Server rejects it with `SHARE_DENIED` (Android shows **This receiving Node is not approved in Atlas.**), **no new Mac confirmation appears**, and the Mac clipboard is unchanged. A local disabled Send button, a cleared selection, a missing recipient after refresh, or a different network error is **not sufficient evidence** that server-side revocation worked; record inconclusive/fail and investigate instead.
5. **Only after** the denied stale send, press **Refresh devices** and confirm that the Mac is no longer an eligible target. To run case G, re-grant Android → Mac via Atlas Web and wait for Android's refreshed list to show the Mac again.

### Exact procedure: G2 — interrupt a pending send and reconnect

1. After restoring the managed pair, keep Android foreground/Online, refresh recipients, select the ready Mac, and prepare a **new, harmless** text draft. Verify no other send is pending and the Mac has no previous open approval dialog.
2. Press Android **Send** and wait until the Mac's native confirmation dialog is **visibly open**. Confirm Android shows **Waiting for the receiving Node's approval…**; this proves a send was actually in flight.
3. **Before approving or declining on the Mac**, immediately background Android (Home/app switch). The foreground-only socket should close; Android must treat that submission as **unconfirmed**, not accepted. On Mac, **Decline** that original prompt promptly if possible; otherwise allow its 15-second timeout. **Do not click Copy**, as an original accepted delivery could change the clipboard despite Android disconnecting.
4. Return Android to the foreground and wait for an authenticated reconnect and recipient refresh. **Do not press Send again.** Observe that Android does not automatically issue a replacement request, cause a **second** Mac approval prompt, or report the interrupted request as accepted. The original Mac prompt's decline/timeout is not a new delivery.
5. **Pass only if** exactly the original Mac prompt occurred, Android never shows a false accepted receipt, and no new send happens on reconnect. If the Android status is not observable after returning, record the missing evidence rather than assuming success. Treat any automatically reappearing approval as a failure. The ordinary no-pending reconnect/presence check remains case G1.

**Mandatory boundary check:** Android remains `device.share.send` only. Do not infer Android-to-Android, Mac-to-Android inbox, image/file, queued or background support from a passing text test.

## Finish and roll back

1. Revoke the temporary **managed** Android → Mac sharing approval through Atlas Web. Verify it is no longer active; also remove any *separate* legacy environment grant if present.
2. Set `ATLAS_NODE_SHARE_RECEIVE_ENABLED=false` on Mac and restart only that Node. Confirm `device.share.receive` is no longer advertised.
3. For temporary Android test identities, revoke the Android Node in Atlas Web before uninstalling the APK or forgetting its local identity. Do not leave credentials orphaned by app uninstall.
4. Record failing cases as issues or follow-up PRs, keeping sensitive share text and credentials out of reports. **Do not declare the mobile sharing milestone production-ready** until all physical cases pass and signing/release strategy is separately addressed.

For the receiver implementation, see [Mac Device Share](./MAC_DEVICE_SHARE.md). For permission semantics, see [Node Share Permissions](./NODE_SHARE_PERMISSIONS.md). For relay limits, see [Device Share Relay](./DEVICE_SHARE_RELAY.md).
