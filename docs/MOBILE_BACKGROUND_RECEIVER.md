# Android 0.6.0: live background-receiving acceptance

This is the **fast path** for issue [#163](https://github.com/affank1020/atlas/issues/163): an opt-in Android `remoteMessaging` foreground service retains **the existing Android Node v2 text WebSocket** while another app is open. It does **not** provide offline delivery, FCM push, image transfer or a durable inbox. It may be interrupted by Doze, Samsung battery restrictions, network loss, force-stop or a killed process.

## Prerequisites

1. Merge only after the Android debug APK, JVM/emulator tests, Atlas CI, @Prepare PR and independent code review pass. Record the exact release commit.
2. Build Android Node **0.6.0** on the same Mac OS user / persistent debug signer used for the **already-enrolled** 0.5.0 tablet. Verify signer fingerprints, then install using `adb install -r`. Do **not** install CI-signed artifacts over an enrolled Node; do **not** uninstall on signature mismatch. See [Mobile Share E2E](./MOBILE_SHARE_E2E.md).
3. Keep the Mac Node on its established identity and opt-in `ATLAS_NODE_SHARE_SEND_ENABLED=true`. The managed **Mac → Samsung** directional sharing pair must be approved separately; no new wildcard grants.
4. On Samsung, open Atlas → **Settings** → **Background receiving** and enable it. Grant notifications when prompted (Android 13+). An ongoing, generic notification with a **Stop** action should appear.

## Acceptance matrix

| Case | Action | Expected result |
| --- | --- | --- |
| A — another app | Keep the foreground service running, open Samsung Notes, then invoke `./atlasctl share` from the Mac with harmless text | Android remains online; a generic **Incoming Atlas text** notification appears without contents or sender details; tap to open Atlas, approve **Copy**, paste exact text |
| B — background decline | Send again, open the incoming notification, press **Decline** | No clipboard modification; sender sees decline/not copied |
| C — background expiry | Send while using Samsung Notes; do not tap notification for >15 seconds | No successful receipt, no auto-copy; incoming notification expires |
| D — stop service | Tap **Stop** in ongoing Atlas status notification and leave Atlas | No persistent Node connection; Mac must not report delivery succeeded while Android offline |
| E — activity fallback | With service stopped, open Atlas and send text | Foreground Android 0.5.0 behavior remains: Copy/Decline works while app is open |
| F — service on/off with Activity visible | Enable/disable background receiving while viewing Atlas Settings | Single Node registration; no duplicate websocket, no lost active Activity connection |
| G — lock screen / Doze | Keep service running; lock screen and try a send | Record observed notification and delivery outcome; **do not mark this guaranteed**. Android may suspend the socket; server must not claim copied when confirmation fails |
| H — airplane mode / reconnect | Background receiver active; disable then re-enable network | No false accepted receipt; bounded reconnect after network returns if OS still allows running |
| I — permission denied | Deny/revoke Atlas notification permission, attempt to opt in | Foreground service does not start from Settings; no silent invisible pending approval |
| J — revocation | Remove Mac → Android managed grant in Atlas while service is running, then try to send | Server denies it; no incoming dialog/clipboard modification |
| K — sensitive content | Send test text and inspect notification/lockscreen | Notification contains no text payload; clipboard changes only after explicit foreground Copy |
| L — process death / force stop | Kill or force-stop Atlas, then send again | Service not falsely advertised as guaranteed available. This version does not wake via FCM or queue a delivery |

## Rollback

- From the status notification, tap **Stop**, or disable **Background receiving** in Settings.
- To return to a 0.5.0 device build, do not use `adb install -r` with a lower versionCode and do not uninstall (that loses enrolled credentials). Prefer disabling the service pending a fixed **higher-versionCode** Android build.
- No Atlas Server protocol or managed approval change is necessary for this phase.

## Next stage: offline reliability

A server-side encrypted, bounded, expiring mailbox and FCM wake-up using **opaque delivery IDs** are separate from this foreground service. The Mac sender must distinguish **queued on server** from **confirmed copied to the Android clipboard**; the current synchronous `device.share.submit` should retain its existing meaning. Do not encode images into text frames or persist received clipboard contents in diagnostic logs.
