# FYP successor integration (FootballV1)

Status: the original integration is deployed and the FYP checkout is registered. An Editor-first training and evaluation path is now being implemented locally; it has not yet been deployed or validated in a live run. The previous fixed player build did not produce an app, so the old deployed UI still cannot start training.
Companion Unity repository: [affank1020/FYP](https://github.com/affank1020/FYP).

## Ownership and compatibility

FYP is the current Unity source of truth; the former `AI Football` checkout is historical.
FYP behavior `FootballV1` uses 25 vector observations, 8 continuous actions, a fixed 5-step decision period, Unity 6000.3.6f1, and a MA-POCA trainer. It is incompatible with the legacy `FootballGeneralistV2` 54/5 actor and experimental FootV1 54/7 actor. Never reinterpret or carry over model weights based on similar mechanics.

The Football app deliberately resolves `fyp_*` actions to an active Unity Workspace named **FYP**. Old Generalist and legacy actions stay on a non-FYP Unity Workspace. This prevents an accidental first-workspace selection when both are associated with the Final Year Project. The old checkout must not be archived, deleted or silently repointed as part of initial migration.

## Preparation and registration

1. Locate the *actual* FYP project directory on the Mac (the directory containing `Assets/Football`, `Training`, `Packages` and `ProjectSettings`). Confirm its Git origin is `affank1020/FYP`; do not assume it lives under the old `AI Football` directory.
2. Register that exact directory as an active **Unity** checkout named `FYP` on the connected Mac Node and associate it with the existing **Final Year Project** Atlas Project.
3. Verify `football_fyp_manifest` and `football_fyp_preflight` read only from FYP. Verify `football_generalist_manifest` still accesses the historical AI Football workspace. If either points at the wrong root, stop.

Verified on 2026-11-12: project `ce09dbe0-0755-4bd8-9376-e4a3152d59f7` has an active FYP checkout at `/Users/affankhan/FYP` (workspace `3c60d835-e6f0-4c6a-b3cc-3c545773e131`) on Mac Node `fe7984f9-c7fb-42fd-ac89-4480bc9734a2`. The historical `/Users/affankhan/AI Football` checkout remains registered separately and was not changed.

## Bounded operator workflow

- `football_fyp_manifest`: new ABI, with no implied model compatibility.
- `football_fyp_preflight`: source fingerprint, fresh FYP Editor heartbeat, active scene, Play Mode, ML-Agents connection, episode counter and local trainer state.
- `football_fyp_train`: smoke (2,048) or pilot (50,000) in the Editor. Start from Edit Mode with the FYP scene open; Atlas starts the trainer, then Unity Play Mode performs the communicator handshake. A standalone player is optional.
- `football_fyp_evaluate`: bounded inference from a completed, source-matched checkpoint in the same Editor scene. Start from Edit Mode, request evaluation, then press Play. Episodes are visible in the Unity Console and the Atlas panel.
- `football_fyp_runs`, `football_fyp_evaluations`, `football_fyp_status`, `football_fyp_task_status`: receipts from the FYP checkout, not legacy run discovery.
- `football_fyp_build`: optional legacy player build only; it is not a prerequisite for training or evaluation.

The FYP repository contains `Training/atlas_contract.json`, `Training/atlas_fyp.py` and an Editor status extension. Training artifacts, evaluation receipts, model exports, optional build stamps and logs live under ignored `.atlas-fyp/`. The heartbeat is fresh for five seconds and names the exact project root, so an installed Editor executable or a stale process cannot be mistaken for the FYP project running. The bridge does not accept caller-supplied commands.

## Local policy records and receipt migration

The local policy catalogue is sourced from `Training/policies/<policy-id>.json` in FYP and validated against `Training/policy_record.schema.json`. Atlas lists/selects these records and displays observation/action channels, actor and trainer settings, runtime/artifact requirements, and each curriculum stage. Stage environment details are shown only when the global Unity environment catalogue has the same version and definition hash. New training/evaluation receipts carry the selected policy ID, revision, record snapshot and hash; runs, evaluations, checkpoint notes and builds are scoped to the selected policy. Unity Editor status and the environment catalogue stay global.

`Training/policy_migration.json` maps existing `fyp-football-v1` receipts to `football-v1` by their legacy contract ID. The bridge infers that association when listing historical records and leaves their files/artifacts untouched. A new policy ID starts with empty run and evaluation history. The local page currently runs in mock mode for visual review; deployment and live FYP training acceptance remain separate steps.

## Verified deployment and current blockers (2026-11-12)

- Atlas Server deploy run [43062358640](https://github.com/affank1020/atlas/actions/runs/43062358640) succeeded for `7ad2fffa87fe823fe7b0ca137d13a10803d476fb`. The deployed Football Training UI shows the **FYP v1 (new)** tab.
- The running Mac Node is built from `/Users/affankhan/Developer/Atlas` at the integrated revision. Its compiled protocol and capability include the FYP operation names and the server routes `fyp_*` actions to the active FYP Unity checkout; legacy generalist routing remains separate.
- The current deployed MCP schema/UI is still old and previously returned `Invalid Workspace operation input`; the Editor-first changes are local and must be rebuilt/deployed through the existing process before Atlas can use them.
- The previous batch build log showed Unity's licensing client handshake timing out and no `.app` being created. That does not establish a license-plan/entitlement restriction. The new primary flow no longer invokes batch build.
- The Unity Editor is not currently reporting an open FYP project in this checkout's latest status check; the new heartbeat cannot be verified until the project is opened and its Editor code compiles.
- No Editor-based smoke training or checkpoint evaluation has been run yet. A live Play Mode handshake remains an acceptance step.

For the reproducible Apple Silicon trainer setup, see `Training/atlas_environment.md` in the FYP repository.

## Required live acceptance before a pilot

1. Open the correct FYP Editor and compile the heartbeat and episode event hooks; verify Edit Mode, Play Mode, scene and communicator status are reflected in Atlas.
2. Request the 2,048-step smoke from Atlas while Unity is in Edit Mode, press Play after the learner starts, and inspect the live episode events in the Unity Console and Atlas panel.
3. Verify the run receipt, trainer checkpoint and exported ONNX hash; then evaluate a bounded number of episodes in the same Editor using the checkpoint.
4. Review the actual graphical episodes, logs, per-episode outcomes and model provenance before deciding whether to allocate a 50k pilot.

**Not delivered yet:** live acceptance of the new Editor handshake/evaluation route, source-pinned graphical Watch, held-out evaluation protocol, evidence-linked human reviews for FootballV1, policy packaging/promotion and multi-agent teamwork competency. The local evaluation path is not yet validated. Do not reuse legacy Generalist evaluation assumptions without new ABI and provenance checks.
