# Android queued text handoff (0.7.0) — opt-in deployment and acceptance

This is a **separate** queue from the live `device.share.submit` relay. Live
sharing still requires a connected target and a Copy/Decline reply. Queuing
acknowledges **durable admission on Atlas Server**, never a clipboard copy.

## Security and rollout

1. Apply additive `038_node_share_inbox.sql` through the existing Atlas Server
   migration runner. Existing Node and project tables/protocols are unaffected.
2. On the private Atlas Server, configure
   `ATLAS_DEVICE_SHARE_QUEUE_KEY` as **64 random hexadecimal characters**
   (32 bytes) from a secure random generator. Store only in the private Server
   environment/secret manager. **Do not commit it**. Loss of the key makes
   queued payloads unreadable; rotation requires draining/re-encrypting the
   queue first. It is not the Android debug APK signing key.
3. Configure `ATLAS_DEVICE_SHARE_QUEUE_PAIRS=MAC_NODE_UUID:ANDROID_NODE_UUID`.
   This is a **second directional grant**, independent of the managed or
   environment `ATLAS_DEVICE_SHARE_PAIRS` approval. Both grants must remain
   valid. No pair is queue-enabled by default; without a key and pair, queue
   operations fail closed and existing live sharing continues.
4. Restart Atlas Server through the normal reviewed deployment, then confirm
   no credentials/clipboard payloads appear in logs. No schema contains
   plaintext, and ciphertext/nonce/tag are scrubbed on recipient decision.
5. Build Android **0.7.0** from the merged reviewed source on the **same Mac
   development OS user** with the same persistent signing identity as the
   enrolled Android Node 0.5/0.6; compare installed vs new APK certificate
   fingerprints before `adb install -r`. Never sideload a CI-signed APK.
   [Mobile E2E](./MOBILE_SHARE_E2E.md).
6. The Mac Node must also be updated from the merged commit and already have
   `ATLAS_NODE_SHARE_SEND_ENABLED=true`. Keep its existing Node identity.
   `./atlasctl share` now lists approved online targets for immediate Copy
   and separately queue-enabled **offline Android** targets for durable admission.

## User experience and limitations

- Copy harmless text on Mac, run `./atlasctl share`, pick an offline Samsung
  Node labelled `offline (queue for later)`, and approve the native Mac dialog.
- The Mac reports `Queued on Atlas until ... NOT yet copied`. This is not a
  successful clipboard handoff. It is stored encrypted for up to 24 hours.
- Open Android Node or its user-started foreground service while connected,
  then open **Inbox**. It retrieves at most 20 queued items. Tap **Copy**
  to write the clipboard, or **Decline**; the client confirms a final
  disposition on the authenticated WebSocket.
- When the foreground service reconnects with queued items, Atlas posts a
  content-free generic notification. This is **not an FCM push**; a sleeping,
  offline or force-stopped app is not woken. A later PR must provide push
  registration/wake-up and optional durable client notifications.
- Pending content is not persisted on Android; it is fetched after restart.
  Expired/revoked items are hidden. A copied item whose acknowledgment is lost
  may reappear after reconnect, so never automatically recopy or retry it.
- Storage is bounded to 20 queued transfers per Android Node, with 24-hour
  expiry and 7-day metadata receipt retention. Live sharing and outgoing
  Android text remain unaffected; image binary transport is not part of this PR.

## Acceptance checks (on actual Samsung and Mac)

- [ ] Queue from Mac when Samsung Node offline; no false `accepted: true`.
- [ ] Switch to Samsung Notes; open Atlas inbox after reconnect; text exact
      including Unicode/newlines. Explicit Copy changes clipboard.
- [ ] Decline does not modify clipboard; item disappears after acknowledged.
- [ ] Duplicate queue ID with same content remains one record; changed content
      with same ID denied as replay.
- [ ] Remove managed directional grant after enqueue: pending item is no longer
      readable. Revoked Node credentials cannot fetch anything.
- [ ] Expiry hides items, bounds storage, no unbounded accumulation.
- [ ] Queue secret absent and queue pair absent: old live sender works,
      queued operation denied without writing plaintext.
- [ ] Android process killed, device locked, Wi-Fi disconnected and reconnect:
      explain eventual retrieval honestly; no instantaneous delivery claim.
- [ ] Inspect notification preview, app logs and Postgres fields for no
      plaintext leakage, and check rolling deployment compatibility.
- [ ] CI Android JVM/debug APK/emulator and Atlas server/node/web tests green;
      @Prepare PR and independent Code Reviewer complete before merging.

## Next feature

FCM or a separately justified push system is still required for a
user-visible prompt while the tablet sleeps. Push should carry only an opaque
delivery identifier, not content/keys. Keep server-side queued vs copied states
distinct even if push is delayed, duplicated or dropped.
