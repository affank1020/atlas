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
- `queued` explicitly does **not** mean `copied`. Only a future authenticated user action can mark `user_copied`; a simultaneous or expired decision is rejected.
- The source still sends ordinary live shares through `device.share.submit`. Do not auto-queue ambiguous live delivery failures (a disconnect might conceal a successful clipboard write).

## Authenticated Node protocol (feature gated)

The gateway now accepts four distinct Node v2 operations when `ATLAS_DEVICE_INBOX_KEY` is configured on Atlas Server:
- `device.inbox.enqueue` from an authenticated sender with `device.share.send`; its `targetNodeId`, `deliveryId`, and text are validated against the sender identity derived from the registered connection. Reply distinguishes `status: queued` from a clipboard receipt.
- `device.inbox.list` from an authenticated Node with `device.share.receive`; returns up to 50 unexpired, still-approved item metadata records, not contents.
- `device.inbox.read` from the authenticated receiving Node; decrypts only one unexpired, still-authorised item, with expiry and permission checks repeated before read.
- `device.inbox.decide` from the authenticated receiving Node; atomically records `user_copied` or `declined` and erases stored ciphertext. The *client* remains responsible for only requesting `user_copied` after a successful explicit clipboard write.

Each operation independently authenticates the current socket credential and checks the relevant registered Node capability. The gateway bounds requests to one inflight operation and one per 500ms per session. Existing `device.share.submit` remains synchronous and unchanged.

## Still required for the daily workflow

No Mac `atlasctl share` queue option, Android inbox UI/polling or FCM wake-up is included yet. The server's standalone encrypted mailbox is **not by itself a functional asleep-tablet user experience**. A follow-up implementation must add the Mac explicit queue UX, Android inbox and notifications, cleanup worker, and push transport with opaque delivery IDs / private Firebase credentials. Physical phone sleep reliability additionally requires Android acceptance under Doze and force-stop.

Do not deploy and advertise a complete persistent mobile inbox from this PR alone.

## Operations

- Supply the key as a secure server-only secret. Never expose it in Android, Mac Node configuration, Compose output, diagnostics or test fixtures in production.
- Run migrations before enabling any future endpoint. Preserve previous ciphertext until retention expires.
- Schedule expiry purge in a controlled server process and add monitoring on queue count, expiry and failed decrypts **without recording payloads**.
- PostgreSQL integration tests exercise one-connection and fully occupied pools, concurrent distinct approved pairs, managed grant revocation, environment-approved sender revocation and rotation/re-enrolment, receiver rotation, 50-item stale inbox quota cleanup, ciphertext erasure and terminal replay receipts. Additional rollout tests remain necessary for duplicate delivery IDs across process restart, quota boundaries, rollback and actual encrypted-at-rest inspection.
