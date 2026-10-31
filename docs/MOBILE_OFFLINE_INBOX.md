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
