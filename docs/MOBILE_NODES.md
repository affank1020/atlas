# Mobile Nodes — Android foundation, protocol and release decisions

**Status:** Architecture + UI scaffold (21 October 2026). Not paired and not a connected mobile Node.
**Initial device:** Samsung Android tablet. iOS can use the same Server device-capability contracts later.

## Key separation

- **Atlas Server:** source of Node identity, consent, capability routing, request authorization, idempotency and pending-transfer metadata.
- **Node v2 wire contract:** `packages/protocol/src/node-protocol.ts` is currently v2, with registration, heartbeat, bind, logs and Workspace execution requests. Its capability enum has **no device capabilities** today. Do not claim `workspace.files` from a phone or fake Workspace root bindings.
- **Android Node:** Kotlin/Compose app with an independent Node identity, Android Keystore-protected credentials after pairing, an outbound foreground WebSocket, local permissions, share target and inbox.
- **Mac Node:** existing desktop Node identity/process remains the receiver; add narrowly-scoped `device.*` capabilities independently of Workspace operations.
- **Cloudflare/R2:** optional future *data plane* for authorized uploads and offline relay, never a prerequisite for getting the Android app running. Native clients must not use admin Basic Auth or privately stored R2 keys.

Do not conflate `Node online` with `app installed`. Foreground WebSocket sessions provide immediate delivery only while actually connected. Offline devices need a durable server inbox/notification delivery protocol, and delivery acknowledgements must reflect receipt, not merely queue insertion. Android and iOS OS lifecycles do not guarantee 24/7 socket uptime.

## Device protocol ADR (proposed, not implemented)

1. Preserve registration envelope `{type:"register",protocol:2,nodeId,name,platform,version,capabilities}` and existing Node credentials. Extend the capability enum via a backwards-compatible Server/Node deploy before any mobile app advertises new capabilities.
2. Introduce separate **device-target** requests, not `execute` with fabricated Workspace metadata. Example capability names: `device.share.receive`, `device.clipboard.write`, `device.files.receive`. These are **proposals**, not accepted protocol values yet.
3. Authentication (which Node connects) and authorization (who may initiate an operation targeting which Node) are distinct. Source identity is server-derived, not trusted from JSON. Use explicit peer/owner approval, bounded payload schema, short-lived IDs/expirations, strict MIME and byte limits, request deduplication and audit without clipboard contents.
4. Pairing: generate a one-use short-lived enrolment ticket from authenticated Atlas Web; input/scan it on-device; POST to existing `/node/enrol` via trusted HTTPS; save returned Node ID and credential in Android Keystore-backed encrypted app storage. Never embed a reusable Node token in an APK, logs or QR URL. Allow recovery via credential rotation and remote revocation.
5. A received request is not a delivered request until the target acknowledges acceptance. Reconnect and retries must not reapply clipboard changes or duplicate file creation. Use TTL, idempotency key and explicit statuses (pending / accepted / delivered / declined / expired / failed).
6. Native share target accepts user-selected text/links now. Later add images/files via the Storage Access Framework and URI grants. File bytes move via reviewed scoped upload/transfer authorization, not Caddy admin routes. R2-backed storage can be added behind server-provided short-lived permissions.
7. iOS later will implement an independent Swift client, likely with push/foreground handling, and no assumed always-on Node; protocol is transport/OS-neutral.

## Versioning and compatibility

These are separate axes; never equate their version numbers:

| Component | Current line | Change trigger |
| --- | --- | --- |
| Atlas Server | npm 2.0.x | Backend deploy |
| Desktop / Linux Node | npm 2.0.x + optional build SHA | Independent packaged runtime |
| Node wire protocol | 2 | Incompatible envelope/handshake major upgrade only |
| Android app | 0.1.0, versionCode 1 | Installed APK |
| Device capabilities | Proposed v1 contract | Per-feature negotiated capability and schema |

Android `versionName` is human-readable SemVer; `versionCode` must strictly increase for every installable release signed with the same key. Both are in `apps/android-node/gradle.properties`. Protocol v2 compatibility is independently checked at connection/registration, not inferred from app semver. Show app and supported protocol versions in Settings and Server Nodes view (once enrolled).

Build debug APKs in CI, sideload only for development. Before first real release: choose and securely preserve one Android signing key, create an independently versioned GitHub Release artifact with SHA-256/checksum, document permissions and test device upgrade/downgrade behavior. Initial upgrade workflow is user-initiated, verified and explicit; no self-updating executable download, unattended install or uncontrolled rollouts. Store signing key outside Git. Staged channels may be added later (internal -> beta -> stable). iOS will need its own bundle/build-number and distribution policy.

## Implementation sequence and hard gates

- **A0 app shell (this change):** native responsive UI and text Sharesheet target; offline state is honest; independent Gradle version/CI. *No server files touched.*
- **A1 wire contract:** Server/Node type-safe device operation route, target auth, replay/expiry checks, tests. No file bytes.
- **A2 enrol/foreground online:** Samsung enrols as its own Node with Android secret storage, WSS TLS and reconnect, protocol handshake and capability reporting. Backwards-compatible older Mac/Linux sessions remain functional.
- **A3 text vertical slice:** Samsung share intent -> target picker -> authorized Mac receive, and Mac -> Android inbox; explicit confirmation and actual end-to-end tests.
- **A4 files:** add scoped Node upload authorization and resumable transfer design after Atlas Files integrity/Cloudflare storage work. Never reuse admin-only `/api/files/*` from native nodes.
- **A5 background/release:** best-effort notifications and durable inbox; user-initiated transfer jobs or appropriate WorkManager tasks; signed releases and version compatibility indicators.

**Review gates:** no privilege escalation via capability registration; no raw secrets in logs, backups or APK; explicit Android platform restrictions; older Nodes can register throughout rollout. Do not declare the Android Node functional before real device tests.
