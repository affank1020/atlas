# Atlas Connect — Implementation Roadmap

**Version:** 0.1 (planning baseline)  
**Date:** 12 October 2026  
**Status:** Proposed; implementation not started  
**Scope:** macOS Node + Samsung Android Node (tablet first), using a hosted Atlas Server and optional private Tailscale transport.

## 1. Vision and intended result

Extend Atlas from a hosted personal platform plus a desktop execution Node into a **private, device-aware companion system**. A small native app on each device exposes selected OS-level capabilities, with Atlas Server coordinating identity, presence, permissions and requests.

This is **not** a port of Observatory, Views, Projects or the main Atlas web app to Android. The Android app is a purpose-built Node and minimal UI for Mac ↔ Samsung integration.

### MVP user journeys

1. On Samsung, select text or a link in any app → **Share to Atlas** → select Mac → accept/send → it becomes available to paste from the Mac clipboard.
2. On Mac, copy or select text → **Send to Samsung** → it appears in the Android app's inbox, with a deliberate **Copy** action.
3. Send a file from either device to the other, with explicit destination approval, progress and clear completion/error status.
4. Open either companion UI to see trusted devices, connection status and recent transfers.
5. Mac and Samsung can communicate across different networks while signed into the tailnet; Atlas Server remains accessible to ChatGPT via its public OAuth endpoint.

### Non-goals for V1

- Full Observatory or general Atlas mobile UI.
- Invisible, always-on Android clipboard scraping or perfect Universal Clipboard.
- Remote shell or unconstrained filesystem access on Android.
- Multi-user collaboration, cloud file storage, automatic backup/sync, or remote desktop.
- Guaranteed 24/7 Android WebSocket connectivity.
- Making Tailscale a replacement for Atlas's application authentication.

## 2. Architecture decisions

- **Atlas Server (VPS):** device registry, existing Node authentication and UUIDs, authenticated capability routing, presence, transfer signalling, transfer metadata, expiry and audit. Retain the existing public HTTPS/MCP/OAuth route.
- **Atlas Mac Node:** extend the current Node V2 runtime and native SwiftUI control interface with device clipboard and file capabilities; preserve its identity and Workspace/Unity/training features.
- **Atlas Android Node:** new Kotlin + Jetpack Compose companion, implementing a compatible subset of the Atlas Node protocol. It advertises only capabilities Android can safely support.
- **Tailscale:** private IP/DNS/connectivity between machines, including a private HTTPS/WSS ingress to Atlas Node services. Tailnet policy limits access. Device credentials, explicit approvals and typed authorisation still apply.
- **Control plane vs data plane:** small authenticated messages and transfer setup through Server; prefer streaming binary data directly over the tailnet **when peers are reachable**, otherwise give a clear failure and later add an optional bounded relay. Do not send arbitrary large files through the existing JSON Workspace operations.
- **Android lifecycle:** full Node operation while app is active; background delivery is best-effort using queued requests/notifications. Use Android-compliant user-initiated transfer work for lengthy transfers. No dependency on uninterrupted background socket uptime.

## 3. Roadmap and milestone gates

### M0 — Networking foundation: private Atlas transport
**Estimate:** 0.5–2 development days  
**Deliverable:** working, reversible tailnet deployment without disrupting current Atlas.

**Tasks**
- Install Tailscale on VPS; verify the existing macOS client, install it on Samsung tablet.
- Enable MagicDNS/HTTPS if needed; configure least-privilege tailnet grants (not broad allow-all).
- Test Mac ↔ VPS and Mac ↔ Samsung connectivity, including whether traffic is direct or relayed via `tailscale ping` / `tailscale status`.
- Expose a **private** Atlas Node endpoint (e.g. Tailscale Serve to existing ingress) and verify WebSocket upgrade/authentication, TLS and server routing.
- Point a test Node at that WSS endpoint, measure stability and verify reconnects. Migrate the production Mac Node only after success; preserve UUID/credential.
- Retain public ChatGPT MCP/OAuth domain, existing deployment path and rollback configuration. Ensure VPS admin access remains reachable before considering public SSH firewall changes.

**Acceptance gate:** Mac Node reliably registers through tailnet; Workspace and Unity calls still function; public ChatGPT MCP still works; returning to public Node WSS is documented and tested.

### M1 — First-class device capability contracts
**Estimate:** 2–4 development days  
**Deliverable:** Server/Node protocol can route secure device operations independently of Workspaces.

**Tasks**
- Define versioned `device.*` capability names and typed payloads (e.g. `device.share.receive`, `device.clipboard.write`, `device.files.receive`), without granting arbitrary OS operations.
- Reuse persistent Node registration, identity, authenticated transport and routing; extend discovery for online/offline and supported actions.
- Design an authorised source → target request model with explicit target approval or trusted-device permissions, replay protection and expiration.
- Add minimal transfer request/inbox metadata and bounded audit; store no clipboard contents by default. Support refusal, cancellation and timeouts.
- Test capability mismatch, offline targets, invalid origin, unauthorised sender, expired requests and reconnect behaviour.

**Acceptance gate:** two test Node clients can discover one another and send an authorised mock share request end-to-end; denied/expired operations fail closed.

### M2 — Mac companion integration
**Estimate:** 1–3 development days  
**Deliverable:** current macOS Node app can receive and send text, accept share requests, and show peer status.

**Tasks**
- Extend existing SwiftUI UI with **Devices**, **Share** and **Inbox/Transfers** sections.
- Implement safe clipboard write and user-initiated clipboard send using macOS pasteboard APIs.
- Show incoming share request approval and transfer status. Keep training/development control fully intact.
- Keep Node process supervision under existing `atlasctl`/`launchd`; avoid a second process manager.

**Acceptance gate:** Mac receives an approved mock device message and places text on its clipboard; existing Node capabilities and UI keep working.

### M3 — Samsung Android Node + minimal interface
**Estimate:** 3–6 development days  
**Deliverable:** sideloadable Android companion APK, tablet-first (phone later).

**Tasks**
- Create Android app (Kotlin, Compose) with **Devices**, **Send**, **Inbox** and **Settings** screens.
- Implement secure enrolment, credential storage, compatible outbound WebSocket connection, registration, reconnect and capability advertisement.
- Integrate Android Share Intent for selected text/links/files; use Android Storage Access Framework/content URIs rather than broad storage permissions.
- Display online/offline/connecting states and server-delivered incoming requests. Do not assume Node service runs indefinitely when app is backgrounded.
- Document installation, Tailscale client prerequisite, enrolment and safe credential rotation/revocation.

**Acceptance gate:** Samsung registers as its own persistent Atlas Node, appears in device list, survives app relaunch and can share text into a mock receiver.

### M4 — First real cross-device workflow: text and links
**Estimate:** 2–3 development days  
**Deliverable:** useful everyday Mac ↔ Samsung sharing.

**Tasks**
- Android Share → choose Mac → optional approval → write text/link to Mac clipboard.
- Mac Send → Samsung inbox → user taps Copy/Open.
- Report sent/received/failed/expired state; provide explicit retry without duplicated actions.
- Default clipboard history to off, cap content size, prevent automatic collection of sensitive clipboard data and allow clearing pending content.

**Acceptance gate:** both directions work on the same Wi-Fi and across different networks, with confirmed sender, recipient and delivery result. This is the **first user-ready MVP**.

### M5 — Direct file transfer
**Estimate:** 4–8 development days  
**Deliverable:** binary files move between Mac and Samsung without routing the entire payload through the Atlas application API.

**Tasks**
- Add authorised, time-limited transfer sessions negotiated through Atlas Server.
- Use direct HTTPS/streaming over the tailnet where feasible; never assume a peer-to-peer route exists. Android only accepts transfers while able to run a suitable foreground service/transfer job.
- Implement file picker/Share target, destination picker, accept/decline, progress, cancellation, size limits and checksum verification.
- Test small PDF, screenshot, and a 100 MB file; reject traversal, unexpected MIME/name, bad checksum and unauthorized destination.
- Define an explicitly optional later fallback for peers that cannot accept direct connections.

**Acceptance gate:** bidirectional supported-file transfers on local Wi-Fi and through another network, with verified integrity; failures do not leave partial files looking complete.

### M6 — Background reliability and release hardening
**Estimate:** 3–5 development days  
**Deliverable:** robust daily-use Android companion.

**Tasks**
- Queue incoming requests for offline Android devices; introduce push notifications (e.g. FCM) for user-visible actions where appropriate.
- Implement reconnect/replay-safe delivery, TTL/expiry, clear pending notifications and app lifecycle handling.
- Use Android-approved background work/user-initiated transfer primitives; test screen off, app killed, Wi-Fi ↔ mobile data, Tailscale disconnected, VPS deploy and Mac sleep.
- Add integration tests, security review, permission UX and basic diagnostics to both companion apps.

**Acceptance gate:** no silent message loss claimed as success; user sees truthful states and can recover/retry after reconnection.

## 4. Priorities and release boundaries

| Release | Includes | Target experience |
| --- | --- | --- |
| Infrastructure ready | M0 | Private Mac/VPS/Samsung connectivity, existing Atlas unaffected |
| Protocol ready | M1–M3 | Enrolled Samsung Node and Mac UI, typed trusted messaging |
| **MVP** | M0–M4 | Send text/links both directions; Samsung Android share sheet → Mac clipboard |
| V1 | M5–M6 | File transfer, progress, recovery and sensible background notifications |
| Later | Optional relay, richer share history, Samsung phone support, direct pairing UX | Expanded device ecosystem |

**Planning estimate:** ~1–2 focused development weeks to get an MVP into daily use, ~3–5 weeks for V1; this is a rough effort range and may change after the first Android/transport spike. Focus on one Samsung tablet before generalising to multiple devices.

## 5. Risks, boundaries and mitigations

| Risk | Mitigation |
| --- | --- |
| Tailscale cannot establish direct peer-to-peer path | Detect direct vs relay; do not promise lower latency; start file transfer only when usable, optional bounded relay later |
| Android restricts background clipboard access | Explicit Share Intent and foreground actions; no automatic Android clipboard scanning |
| Android limits long-lived background services | Active Node plus queued messages, notifications and compliant transfer jobs; no fake always-online status |
| VPS deployment interrupts Node WebSocket | Existing reconnect, local diagnostics, timestamps, and keep public WSS rollback |
| Broad filesystem/clipboard privileges | Narrow capability schemas, user approval, destination sandbox/pickers, expiry, size limits |
| Accidental leaks between devices | Preserve Node auth, tailnet grants, per-transfer authorisation, avoid persistent clipboard contents, redact logs |
| Scope creep into full mobile Atlas | Companion-only native interface; no Observatory port or general Workspace editor in V1 |

## 6. Immediate next actions

1. **M0 spike:** inspect VPS ingress (Docker/Caddy) and Tailscale state; establish private Serve endpoint without changing public MCP; measure existing Node disconnect patterns before/after.
2. **M1 contract design:** write a short ADR covering device capability names, authorisation, inbox semantics, active vs offline targets, transfer session shape and backwards compatibility with Node V2.
3. **M2/M3 thin vertical slice:** build Mac receiver and Android Share Intent sender first. Validate Android enrolment and text handoff *before* implementing files.
4. **Milestone tracking:** maintain this document as the source of truth, marking gates complete only after real device tests with evidence.

**External platform references (checked October 2026):**
- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve
- Tailnet grants: https://tailscale.com/docs/features/access-control
- Direct/relayed path diagnostics: https://tailscale.com/docs/reference/connection-types
- Android foreground service restrictions: https://developer.android.com/develop/background-work/services/fgs/changes
- Android user-initiated transfers: https://developer.android.com/develop/background-work/background-tasks/uidt
