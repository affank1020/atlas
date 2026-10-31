# Mobile image handoff — Android ↔ Mac

**Implementation:** Android PNG/JPEG image Share → Atlas Node → approved Mac Node → explicit Copy image → macOS image pasteboard. This includes **cropped screen clippings/snips**, full screenshots and ordinary photos. No required image aspect ratio. Supports up to 8 MiB per transfer. Tracked by [#112](https://github.com/affank1020/atlas/issues/112).

## First bounded transport slice

- Android 0.9.0 imports image/png or image/jpeg from a user-initiated Android Sharesheet content URI. It performs capped reads, MIME-signature checks, dimension limits and sampled preview, retaining the full image in volatile memory only.
- The sender selects a *currently online, directionally approved Mac* and taps **Send image to Mac**. No automatic forwarding, clipboard reading or file permissions.
- Android issues an authenticated binary `POST /node/images/upload` with immutable target/delivery UUID, MIME, length and SHA-256 headers. Images never go into the 2 MiB Node WebSocket JSON frames or the general-purpose Workspace API.
- Atlas Server authenticates the sending Node, validates active sender `device.image.send`, online Mac `device.image.receive`, the existing directional share grant and credentials both before and after the bounded upload. The relay is in-memory only, max four concurrent uploads at 8 MiB each, max 45-second transfer lifetime. It does not store a file in PostgreSQL, R2 or Project Files, and holds a short non-content replay tombstone.
- The Mac receives **metadata only** through its authenticated Node socket, fetches the bytes once using its own Node credential over `GET /node/images/:deliveryId`, verifies MIME, exact length, SHA-256 and expiry, then displays **Copy image / Decline**. After user approval it writes native `public.png` or `public.jpeg` data to `NSPasteboard`. The sender sees `accepted: true` **only** after the Mac clipboard write succeeds. Decline and all unknown/timeouts are not success; do not automatically resend when the result is unknown.
- Receive opt-in on Mac requires `ATLAS_NODE_IMAGE_RECEIVE_ENABLED=true`. The Mac must also have normal sharing receiver enabled (`ATLAS_NODE_SHARE_RECEIVE_ENABLED=true`) so it appears in the existing approved-target directory. **Separately authorise images** on Atlas Server with `ATLAS_DEVICE_IMAGE_PAIRS=androidUUID:macUUID` (up to 64 exact directional pairs), *in addition to* the existing Atlas Web directional text-sharing grant. Both are checked again immediately before image dispatch and one-time fetch; a text-only grant does not automatically allow images. No public unauthenticated endpoint.
- The Android background/inbox/FCM work from issue #163 is **text-only**. Images require the sender online and Mac actively connected. This first slice does **not** implement offline image queue, Mac→Android images, PDFs/HEIC/WEBP, permanent University Notes storage or ChatGPT MCP file retrieval.

## Physical acceptance

1. Upgrade the **server first**, enable the Mac image receiver and restart the Mac Node, preserve the existing Node UUID and credentials. Approve Android→Mac direction in Atlas Web.
2. On Samsung, **build Android 0.9.0 with the same persistent local signer**, verify fingerprint, then `adb install -r` without uninstall/re-enrolment. Never install an ephemerally CI-signed APK over the enrolled app.
3. In Samsung Notes, a browser or Gallery, Share a *cropped screen snip* or PNG/JPEG image → Atlas → choose the Mac → Send image.
4. Confirm the Mac displays a deliberate approval; press **Copy image**, then paste into ChatGPT with Cmd+V. Verify that **actual pixels** paste, not a filename, OCR/text or base64. Repeat for full images and JPEG.
5. Test Decline; revoked grants before admission and while image bytes are in flight; offline Mac; forged source or wrong recipient; expired/stale/replayed UUID; mismatched MIME/length/hash; ≥8 MiB; disconnect; close during transfer; unknown receipt. Never claim success from an HTTP upload by itself.

This PR's unit tests and CI cannot substitute for the physical Samsung→Mac clipboard acceptance above.

## Later

- Mac→Android image/file handoff with recipient Save/Open/Share.
- Samsung Notes exports (PDF/image/native where supported) into private University Project Files, with R2 bytes and Atlas-backed metadata.
- Scoped MCP original-page/image retrieval for handwritten equations, including file/page provenance; never assume OCR captures maths correctly.
