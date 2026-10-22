# Android 0.4.0 → macOS text-share acceptance (manual, opt-in)

This is the **physical device release gate**, not an automated proof of success. Run on a Samsung Android device and a Mac with an active, logged-in GUI session. The Android app sends **text only**, in the foreground, over its authenticated Node v2 WebSocket. There is no offline delivery, automatic clipboard sync, or file transfer.

## Before changing anything

- Verify Atlas Server has the merged recipient-directory gateway and managed pair approvals (PRs #55 and #62). Verify the Mac runs a Node build containing the opt-in share receiver; deployed version labels alone are insufficient.
- Use only an Android APK built from the reviewed Atlas source. [Android Node Actions](https://github.com/affank1020/atlas/actions/workflows/android-node.yml) publishes `atlas-android-node-debug` after successful tests. Inspect the run's commit, download the artifact ZIP, and extract `app-debug.apk`.
- **Do not treat CI debug APKs as upgradeable releases.** Their signing keys are ephemeral; the next CI APK may require uninstalling this one, which destroys the Android-local identity. Prefer a locally and consistently signed development build if repeating the test. Before uninstalling an enrolled app, revoke its Node from Atlas Web. Do not publish or copy an enrolment ticket into a bug report.
- Confirm normal Atlas Mac Node operations still work. Make a note of the Mac clipboard contents if needed: successful acceptance **replaces them**.
- Obtain operator approval before changing the Mac Node's environment, granting a sharing pair, or installing/enrolling the Android app. Keep a plan to remove the temporary approvals afterwards.

## Enable a single test receiver (Mac)

1. Update the installed Mac Node if necessary; perform the test in its logged-in desktop session, not a headless service session.
2. Set `ATLAS_NODE_SHARE_RECEIVE_ENABLED=true` in the Mac Node's existing private configuration (`apps/node/.env.node` for the repo-managed installation). Preserve its Node ID and credential; never paste those values into tickets or logs.
3. Restart **only the Mac Node**, for example through `./atlasctl restart` from the Atlas repository if that controls the installed process.
4. In **Atlas Web → Nodes**, verify the Mac is online and advertises `device.share.receive`. If it does not, stop: do not try to fix it by granting Workspace capabilities.

## Enrol Samsung and approve one direction

1. Install the Android app, open **Settings**, and use the app's normal one-use enrolment flow against the publicly trusted Atlas HTTPS endpoint. Enter the one-use ticket from Atlas Web. The app stores its credential with Android Keystore; never copy a desktop Node token to the phone.
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
| F — revocation | Re-enable Mac as needed, then revoke Android → Mac in **Atlas Web → Nodes → Device sharing**; refresh recipients | Mac disappears from eligible targets; any stale selection/send must still be rejected by Server |
| G — foreground/reconnect | Background Android, reopen it, restore a valid grant and refresh | Socket presence follows foreground state, directory repopulates only after successful authenticated reconnect; no automatic resend |
| H — no leak | Inspect ordinary app/Server activity and error states during the session | No share text or credential in audit/logs; unauthorised devices not exposed by the directory |

**Mandatory boundary check:** Android remains `device.share.send` only. Do not infer Android-to-Android, Mac-to-Android inbox, image/file, queued or background support from a passing text test.

## Finish and roll back

1. Revoke the temporary **managed** Android → Mac sharing approval through Atlas Web. Verify it is no longer active; also remove any *separate* legacy environment grant if present.
2. Set `ATLAS_NODE_SHARE_RECEIVE_ENABLED=false` on Mac and restart only that Node. Confirm `device.share.receive` is no longer advertised.
3. For temporary Android test identities, revoke the Android Node in Atlas Web before uninstalling the APK or forgetting its local identity. Do not leave credentials orphaned by app uninstall.
4. Record failing cases as issues or follow-up PRs, keeping sensitive share text and credentials out of reports. **Do not declare the mobile sharing milestone production-ready** until all physical cases pass and signing/release strategy is separately addressed.

For the receiver implementation, see [Mac Device Share](./MAC_DEVICE_SHARE.md). For permission semantics, see [Node Share Permissions](./NODE_SHARE_PERMISSIONS.md). For relay limits, see [Device Share Relay](./DEVICE_SHARE_RELAY.md).
