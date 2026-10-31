# Mobile device inbox — server foundation

Workstream: [issue #163](https://github.com/affank1020/atlas/issues/163). The initial Android 0.6.0 foreground-service fast path was merged in [PR #164](https://github.com/affank1020/atlas/pull/164).

## Contract and security

This changes only the **foundation** for a durable, expiring offline text inbox. The `DeviceOfflineInbox` server repository and `device_inbox` PostgreSQL migration define:

- Separate queued admission, target-scoped listing/reading, explicit user decision and expiry deletion.
- A per-installation 32-byte AES-256-GCM server key, supplied separately by the deployment environment (`ATLAS_DEVICE_INBOX_KEY`, canonical base64). It is **not** generated or embedded in the repository; do not rotate it without a migration plan or old queued messages become unreadable.
- Authenticated encryption of text at rest with nonce/tag and associated data bound to source, target and delivery ID. No plaintext payload in PostgreSQL, audit trails, logs or notifications.
- Limits: 16,384 UTF-16 characters, at most 32KiB encoded UTF-8; 50 pending per target; 100 pending per sender; 24-hour TTL. One delivery ID is bound to its source and content hash, preventing changed-content replay.
- The caller must authenticate the currently connected sender/receiver and invoke the appropriate method using that **trusted session identity**. The server-side directional ACL and **both Nodes' active credential states** are checked at admission and before retrieval, including for environment-approved pairs. In-transaction grant rechecks use the **existing PostgreSQL client** to prevent pool-starvation deadlocks; managed grants are locked through admission.
- Each queued row also records the sender's and receiver's **credential generation timestamps**; rotating/re-enrolling either Node cannot resurrect messages admitted under an old credential. Expired / revoked / rotated items are not returned to Android.
- Every queue admission transaction retires stale queued rows touching its sender or recipient, including rows invalidated by credential rotation/revocation or removal of managed directional approval. Retirement atomically erases ciphertext while retaining a terminal delivery-ID tombstone until expiry; the hidden rows no longer block per-device/per-sender quotas. A same-ID retry of a retired entry returns `status: expired, queued: false` rather than falsely returning `queued`. A fresh delivery requires a new ID.
- **Managed-grant revocation also retires queued messages immediately, inside the same grant-revocation transaction.** This prevents revoked content from resurfacing if a grant is reapproved before another admission occurs. If a configured environment approval overlays the managed grant, new deliveries remain permitted by that overlay, but disabling the managed grant deliberately erases its old pending messages. Acquiring the managed grant lock before changing inbox rows keeps revocation and enqueue lock ordering compatible; expired-item purge is a separate operation.
- `queued` explicitly does **not** mean `copied`. Only a future authenticated user action can mark `user_copied`; a simultaneous or expired decision is rejected.
- The source still sends ordinary live shares through `device.share.submit`. Do not auto-queue ambiguous live delivery failures (a disconnect might conceal a successful clipboard write).

## Authenticated Node protocol (feature gated)

The gateway now accepts four distinct Node v2 operations when `ATLAS_DEVICE_INBOX_KEY` is configured on Atlas Server:
- `device.inbox.enqueue` from an authenticated sender with `device.share.send`; its `targetNodeId`, `deliveryId`, and text are validated against the sender identity derived from the registered connection. Reply distinguishes `status: queued` from a clipboard receipt.
- `device.inbox.list` from an authenticated Node with `device.share.receive`; returns up to 50 unexpired, still-approved item metadata records, not contents.
- `device.inbox.read` from the authenticated receiving Node; decrypts only one unexpired, still-authorised item, with expiry and permission checks repeated before read.
- `device.inbox.decide` from the authenticated receiving Node; atomically records `user_copied` or `declined` and erases stored ciphertext. The *client* remains responsible for only requesting `user_copied` after a successful explicit clipboard write.

Each operation independently authenticates the current socket credential and checks the relevant registered Node capability. The gateway bounds requests to one inflight operation and one per 500ms per session. Existing `device.share.submit` remains synchronous and unchanged.

## Mac/Android queued text clients (PR #180)

This follow-up adds an explicit end-to-end **pull-based** workflow, separate from synchronous live sharing:

1. On Atlas Server, apply migration `039_device_inbox.sql` and configure a durable server-only `ATLAS_DEVICE_INBOX_KEY` (canonical base64 encoding of 32 random bytes). Do not distribute this secret to the Mac or Android; do not rotate it without first retiring queued messages. This key is **absent by default**.
2. On the Mac, enable the existing `ATLAS_NODE_SHARE_SEND_ENABLED=true` Node policy and maintain an approved **Mac → Samsung** directional pair. Upgrade/restart the Mac Node so the existing private local share IPC supports queueing.
3. Run **`./atlasctl share --queue`** interactively with selected text in the macOS clipboard. Select a currently approved **queue-capable receiver**, even if offline, then explicitly approve **Queue** in the native dialog. The **new versioned `device.inbox.recipients` request** reports `queueCapable` only when the receiver last registered the dedicated `device.inbox.receive` consumer capability (Android 0.7+), separately from live `device.share.receive` and `available`. Older Android 0.6 and live-only Mac receiving Nodes remain in the legacy live-share directory but are explicitly ineligible for queued storage, even if offline. The existing `device.share.recipients` response intentionally remains **exactly five fields** for deployed Android 0.6.0 and older Mac Nodes with strict parsers; unsupported queue recipients are excluded. A server without the new request returns an unconfirmed queue-directory error rather than displaying an unverified target. The CLI reports the server's `queued` status and opaque delivery UUID, **not** clipboard delivery.
4. Upgrade the already-enrolled Android Node from 0.6.0 to **0.7.0** using the **same local APK signing key** and `adb install -r`; do not uninstall or use a mismatched CI-signed APK. Once its Node socket is online, open **Inbox → Refresh**. Each queued item and its **Review** dialog show the **full delivery UUID**, allowing comparison to the ID printed by the Mac CLI if its enqueue acknowledgement was lost. Then explicitly **Copy** or **Decline**. Only a successful foreground clipboard write may submit `user_copied`.
5. Verify that notifications and FCM are **not** promised by this workflow. A pending item remains encrypted on the server and becomes visible once Android reconnects and the user refreshes; it expires after 24 hours. No Android plaintext is written to persistent storage.

A failed or ambiguous queue request must **never be automatically retried** under a new delivery UUID. The server may already have accepted the first. A clipboard Copy with an unconfirmed decision receipt remains a local copy, not a confirmed server acknowledgement.

## Still required

FCM wake-up and neutral opaque notifications remain the next reliability slice for sleeping/disconnected Android devices. Also outstanding: maintenance purge during idle periods, production metrics and physical Samsung acceptance with battery/Doze restrictions, and image/file transport. Do not advertise guaranteed screen-off delivery or instant pushes from this PR.

## Operations

- Supply the key as a secure server-only secret. Never expose it in Android, Mac Node configuration, Compose output, diagnostics or test fixtures in production.
- Run migrations before enabling any future endpoint. Preserve previous ciphertext until retention expires.
- Schedule expiry purge in a controlled server process and add monitoring on queue count, expiry and failed decrypts **without recording payloads**.
- PostgreSQL integration tests exercise one-connection and fully occupied pools, concurrent distinct approved pairs, managed grant revocation, environment-approved sender revocation and rotation/re-enrolment, receiver rotation, 50-item stale inbox quota cleanup, ciphertext erasure and terminal replay receipts. Additional rollout tests remain necessary for duplicate delivery IDs across process restart, quota boundaries, rollback and actual encrypted-at-rest inspection.

## Optional FCM wake-up (Android 0.8.0 / PR #187)

This is a **best-effort notification path**, not a delivery acknowledgement, background clipboard operation or guaranteed wake-up under Doze/force-stop. The already-authenticated Node socket is still the only way to list/read/decide inbox contents. FCM carries precisely an opaque delivery UUID and a fixed `kind=atlas_inbox` discriminator, never text, a Node credential, an Android token, a sender name or a file.

**Server preparation (operator only):**

1. Apply additive migration `040_device_push_tokens.sql` after `039_device_inbox.sql`. The registration table binds a device token to the active Node credential generation and encrypts it with domain-separated AES-256-GCM under the existing **server-only** `ATLAS_DEVICE_INBOX_KEY`. Rotated/revoked credentials cannot use a stale registration; token ciphertext does not appear in audits or database logs.
2. Create and restrict a dedicated Firebase service account with Cloud Messaging API access for the selected Firebase project. Supply its **full service-account JSON** via a private server secret `ATLAS_FCM_SERVICE_ACCOUNT_JSON`; do not commit the JSON, upload it to Atlas, include it in CI or pass it to the Android build. Both the inbox encryption key and FCM configuration are required to enable pushing. Without FCM settings, existing queued inbox behaviour remains available.
3. Verify the FCM HTTP v1 API is enabled and that the Firebase Android application is registered for `dev.affankhan.atlas.node`. Enrollments/grants remain controlled by Atlas. FCM cannot grant share permissions.
4. Deploy the compatible Server and Mac Node independently; a queued sender gets its **queued** receipt immediately after a database commit even if OAuth/FCM is unavailable. An FCM delivery is not a clipboard write or a proof that Android displayed the notification.

**Android preparation (same enrolled identity):**

1. Provide the Firebase client identifiers using local Gradle properties or `-P` values: `atlasFirebaseAppId`, `atlasFirebaseSenderId`, `atlasFirebaseApiKey`, `atlasFirebaseProjectId`. They must all refer to the same Firebase application/project. **No server service-account credentials belong in Gradle.** Without these four properties, the APK builds without Firebase registration and remains a foreground/manual inbox client.
2. Build **0.8.0 (versionCode 8)** using the enrolled tablet's **existing private signing key**; verify the certificate and use `adb install -r`. Never uninstall or replace the enrolled APK with a differently signed CI artifact, or re-enroll the Node as a shortcut.
3. Launch Atlas and enable **Background receiving** from the visible Settings UI, approve notifications and verify both Atlas notification channels remain enabled. This also opts in to push registration on the authenticated Node socket. Android preserves the push opt-in across process death; a stopped foreground service does not automatically restart. The visible **Stop** action or disabling background receiving opts out again. Firebase auto-initialisation/analytics are disabled until opt-in.
4. Mac: run `./atlasctl share --queue` and explicitly approve the **Queue** dialog with a directionally approved Android 0.8 receiver. Expect the server's *queued* delivery ID. The Android notification opens Inbox for manual Refresh/Review/Copy/Decline. The payload is encrypted only in Atlas PostgreSQL; no plaintext is cached in the notification or Android persistent state.

**Physical Samsung acceptance:** test another app (including Samsung Notes), screen off/Doze, app process killed, swipe-away, reboot, force-stop (FCM may not reach a force-stopped package), notification permission denied, disabled channels, network loss, FCM credentials absent/invalid, duplicate queued UUID, source/target grant revocation, Node credential rotation, expiry and Unicode clipboard exactness. Check encrypted database token contents, no payload in FCM and correct queued-vs-copied receipts. Confirm that declining/expired items do not silently copy. Record results before closing #163.

**Operational constraints:** FCM high-priority data messages are sent only for a new user-initiated queue admission; retries with the same delivery UUID do not emit another notification. Push failure does not erase the inbox row or silently resubmit it. The server sends with a one-hour FCM TTL and collapse key (a single wake hint may represent several queued items); the inbox retains its separate 24-hour expiry. Device may delay/suppress pushes due to battery modes, connectivity and Android policy. Server deletes an explicitly FCM-unregistered token, but never erases a token merely on a network failure. Token registration itself is authenticated, bound to the current Node credential, and revocable. Regular server cleanup purges expired inbox rows every 15 minutes while running.
