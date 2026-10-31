# Mobile image handoff — screenshot-first transport contract

**Status (31 October 2026):** Android Sharesheet PNG/JPEG import and local preview are implemented on a feature branch. **No image upload, cross-device delivery, recipient clipboard write, persistent inbox, or R2 storage is implemented by this change.** The Send button is intentionally disabled for image drafts. Text/link sharing is unchanged. Tracked by [Mobile Nodes #112](https://github.com/affank1020/atlas/issues/112).

## North-star physical acceptance

1. On Samsung Notes, capture a screenshot and choose **Share → Atlas Node**.
2. Atlas shows a recognizable preview; the user chooses their previously approved Mac.
3. Send explicitly and get a truthful **copied to Mac clipboard** receipt.
4. On the Mac, `Cmd+V` into ChatGPT pastes the image, not an image filename, URL, base64 text, or copied OCR.
5. Repeat with JPEG, network interruptions, declined/expired receipt, malformed MIME, oversized image and revoked permissions. Never report success from a mere upload or transport acknowledgement.

A later Mac→tablet path should display received images in a transient inbox with Save/Share rather than trying to silently write another app's Android clipboard. Samsung Notes PDF exports belong in durable Project Files after the separate storage integration.

## Source capture and memory safety (this PR)

- Accept Android `ACTION_SEND` only for `text/plain`, `image/png`, `image/jpeg`. Image sources must be `content://` URIs from a user-initiated Sharesheet. No `file://`, remote URLs, whole-library scan or broad storage permissions.
- Read through the granted `ContentResolver` stream on an IO dispatcher, with an 8 MiB hard cap even if size is missing or falsely reported. Check declared MIME against a minimal PNG/JPEG signature. Decoder makes an at-most-1024-pixel sampled thumbnail and rejects unreasonable dimensions. Full bytes remain **volatile memory only** and never enter SavedState, clipboard, preferences, logs or Atlas Server.
- New intents are ordered; stale asynchronous import completion cannot replace a later user draft or a pending text share. Editing a text draft discards its image; only the latest held share is retained while an earlier delivery is pending.
- A valid preview does not authorize transfer. Image recipients/sends remain unavailable until the separately reviewed binary data plane; no false successful receipt.

## Proposed binary data plane (next PR; not implemented)

Separate **control** from **bytes**; the existing `device.share.submit` schema is intentionally text-only and the Node WebSocket frame is limited to 2 MiB.

1. Introduce versioned capabilities such as `device.image.send` and `device.image.receive`, not a silent widening of text-share grants. Metadata submission: source Node authenticated, target Node ID, delivery ID, declared MIME, exact length, SHA-256, expiry. The Server checks *current* directional consent and both capability claims at admission and again before dispatch.
2. For initial cross-network reliability, use a **dedicated bounded, authenticated, single-use HTTP binary staging endpoint** with streaming or fixed memory limits; short retention and cleanup; encrypted transport. An R2 temporary object is an option only if private credentials stay server-side and it is isolated from permanent Project Files and the Cloudflare migration. No binary base64 on Workspace or Node JSON control frames. Do not rely on Tailscale-only connectivity.
3. Receiving Mac obtains the bytes only for the authorized one-time delivery, validates SHA-256, content type and actual image decode, then shows approval. On Copy, write image bytes as a real image flavor to `NSPasteboard` (e.g. PNG), not as a text data URI. Receipt distinguishes uploaded, dispatched, declined, copied and unknown. Existing text permissions must not implicitly authorize all file traffic.
4. Hold at most a bounded number of active transfers, rate-limit, cancel, expire unclaimed payloads, avoid path traversal/redirects and clean up after disconnect/rejection. Do not log content, signed URLs, Node bearer tokens or any customer-private notes. Unknown result must not be blindly auto-retried.
5. Treat offline/background Android as unavailable until a reviewed foreground-service or push/inbox path exists. Report truth rather than silently claiming delivery.

## Storage and study context (later)

Ephemeral screenshot transport is **not** permanent archival. Samsung Notes export to the University Project should use authenticated Project Files metadata in PostgreSQL and private Cloudflare R2 object storage, respecting current Storage V2 cutover and recovery gates. MCP retrieval should return original PDFs/images with page provenance, so mathematical handwriting can be inspected in context. Neither Project file storage nor MCP exposure is part of this image-import change.

## Test/rollout gates

- JVM: PNG/JPEG signature, spoofed MIME, exact-byte retention, oversized/malformed streams, session replace/deferred/race handling.
- Android CI: `testDebugUnitTest`, `assembleDebug` and optional device/emulator Sharesheet intent + screenshot preview.
- Physical test only after image delivery exists: Samsung screenshot → Mac clipboard → ChatGPT paste and deliberate decline/timeout/permission revocation.
- On enrolled Samsung, build with the *same local persistent APK signer* and verify the SHA-256 certificate before `adb install -r`. Do not use CI APK or uninstall/re-enrol as an upgrade workaround.
- Meanwhile Mac→Android **text** physical acceptance of merged Android 0.5.0/PR #82 remains a separate unpassed gate. Do not infer image support from text transport.
