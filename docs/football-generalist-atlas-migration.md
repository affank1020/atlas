# Football Training: Generalist-first Atlas application

## Status — 14 October 2026
The first-party Football application route now mounts `FootballGeneralistExperience`, not the legacy `FootballTraining` UI. The default experience uses the generalist V2 contract and typed generalist operations exclusively. No automatic training has been started by this migration.

## System boundaries
- Unity workspace `/Users/affankhan/AI Football`: `football_generalist.py` is the canonical training/evaluation runner; `atlas_generalist_launch.py` is the allowlisted isolated-build launcher. The launch bridge passes scenario, preset, seed, env count, base port and a consistent run ID.
- Atlas Node: `football-generalist-operations.ts` exposes bounded, typed operations for new launches, receipt/status inspection, explicit generalist policy metadata, evaluation, baseline and playback. `football-generalist-runs.ts` scans `generalist-run.json` metadata independently of the legacy driver and includes externally launched experiments.
- Atlas Server: `football_generalist_*` Application tools validate input and audit launch requests. No arbitrary command, path or environment is accepted from callers.
- Atlas Web: Home, Train, Runs, Policies, Evaluate, Watch, Contract and a read-only Legacy Archive.

## Interpretation of the evidence
- A `generalist-run.json` file proves run intent/metadata, **not** that the job is still alive or that it finished successfully. Atlas-owned launches use a stable trainer run ID and join their receipts to show running or explicitly completed status. Externally launched runs remain `unknown` without authoritative process evidence.
- A generated ONNX checkpoint is shown as **unregistered** and cannot be sent to the generalist inference controls until policy provenance and Unity bundle metadata exist.
- Registered generalist policies are screened against contract and scenario hashes for selection. The canonical Python runner still validates implementation fingerprint, runner binary, ONNX model and bundle checksums before execution. A policy is never classified as graduated from its name or from a training reward.
- Atlas-initiated operations return asynchronous receipts. `completed` is only supported by an explicit launcher completion record or structured Unity evaluation report. Termination without evidence is `unverified_exit`.
- Legacy specialist models and jobs are queried only through the read-only archive. They cannot be launched from the new Generalist interface.
- Contract checks do not demonstrate learned football competency. Evaluation runs remain necessary.

## Validation
- `npm run build` compiles protocol, server, Node and Web.
- `npm test` runs backend, Web and native Node UI checks; dedicated generalist discovery/validation and route-isolation tests are included.
- Unity `generalist_contract_tests` exercises the V2 ABI, scenario and promotion invariants.

## Limits / follow-up
- **Policy packaging is automatic for newly completed PPO runs:** after ONNX export, the canonical `football_generalist.py train` CLI builds a Unity `ModelAsset` AssetBundle in an isolated copy, stamps hash/provenance metadata in `policy.json`, and writes `policy-packaging.json` with `registered` or `failed`. A successful PPO run remains completed even if packaging fails, with the failure surfaced separately.
- **Historical backfill:** `football_generalist.py package --output training-driver-runs/<run-directory>` or Football → Runs → `Package policy` calls the same idempotent packager without repeating PPO. Until the packaging command has actually completed, the existing 100k checkpoints stay unregistered; policy selectors intentionally remain empty.
- A generated ONNX model is **registered for evaluation**, not automatically promoted as a competent policy; promotion requires held-out success and retention checks. The new Generalist Editor build method compiles in an isolated player build, but an actual ONNX→AssetBundle integration run and held-out inference are still required.
- Externally launched process health cannot be inferred reliably from the run file alone. Future work can add a durable trainer heartbeat and immutable completion receipt.
- The existing specialist implementation remains in the source tree to preserve archive data and regression test coverage; it is not the launched Football application.
- These local workspace changes are not automatically committed or deployed. Deploy Atlas Server, Node and Web together, and update the connected Unity bridge before launching a generalist run.

## Standalone Watch + Unity Editor coexistence (2026-10-14)
- Watch uses macOS LaunchServices: `open -n -W -a <isolated GeneralistRunner.app> --args ...`. It does **not** open the Unity Editor, change Editor scenes/Play Mode, or rebuild a runner per Watch request. Evaluation stays headless. Unity Python tests cover both command contracts.
- Watch receipt polling now exposes **launcher_alive**, **launch_method**, **player_log_detected**, bounded **player log tail**, and **viewer.state** (`launching_unverified`, `player_logging`, `closed`, `launch_failed` or `unknown`). Validated tests reject invalid PIDs and won't claim a visible GUI solely from a live launch process or player-log text.
- The Watch UI calls the standalone window a **Unity player** and shows launch diagnostics under Latest operation. OS-level window visibility is *not* asserted: `player_logging` is evidence Unity ran, not that the window came to the foreground.
- **Live acceptance check still needed:** with the existing Unity Editor open/connected, click Watch → Open Unity player; ensure the standalone window appears alongside the Editor and close only the player; the Editor should remain connected. If no visible window appears, inspect Latest operation viewer state/player log and the signed-in macOS GUI session before changing policy/training.
- Local Node/Server/Web services must load rebuilt code (and public web deployment must serve the new bundle). Merely building `dist` is not proof that active services restarted. Do not start extra PPO training to test this.
- Validation: Unity `generalist_contract_tests` 22 passed; Atlas `npm test` 164 backend / 87 web plus native Node UI; Atlas `npm run build` passed.
