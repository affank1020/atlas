# FYP successor integration (FootballV1)

Status: code-only integration pending local Mac registration and live Unity acceptance.
Companion Unity repository: [affank1020/FYP](https://github.com/affank1020/FYP).

## Ownership and compatibility

FYP is the current Unity source of truth; the former `AI Football` checkout is historical.
FYP behavior `FootballV1` uses 25 vector observations, 8 continuous actions, a fixed 5-step decision period, Unity 6000.3.6f1, and a MA-POCA trainer. It is incompatible with the legacy `FootballGeneralistV2` 54/5 actor and experimental FootV1 54/7 actor. Never reinterpret or carry over model weights based on similar mechanics.

The Football app deliberately resolves `fyp_*` actions to an active Unity Workspace named **FYP**. Old Generalist and legacy actions stay on a non-FYP Unity Workspace. This prevents an accidental first-workspace selection when both are associated with the Final Year Project. The old checkout must not be archived, deleted or silently repointed as part of initial migration.

## Preparation and registration

1. Locate the *actual* FYP project directory on the Mac (the directory containing `Assets/Football`, `Training`, `Packages` and `ProjectSettings`). Confirm its Git origin is `affank1020/FYP`; do not assume it lives under the old `AI Football` directory.
2. Register that exact directory as an active **Unity** checkout named `FYP` on the connected Mac Node and associate it with the existing **Final Year Project** Atlas Project.
3. Verify `football_fyp_manifest` and `football_fyp_preflight` read only from FYP. Verify `football_generalist_manifest` still accesses the historical AI Football workspace. If either points at the wrong root, stop.

The Mac Development Root Workspace currently reports `WORKSPACE_UNAVAILABLE`, and attempts to register guessed FYP paths failed Node-side verification. These are operational blockers, not proof that a given guessed local directory is correct or incorrect.

## Bounded operator workflow

- `football_fyp_manifest`: new ABI, with no implied model compatibility.
- `football_fyp_preflight`: verified source fingerprint, exact Unity player bundle and local trainer state.
- `football_fyp_build`: opt-in Unity Editor build, fixed script, no arbitrary shell/path.
- `football_fyp_train`: opt-in smoke (2,048) or pilot (50,000) trainer steps, one Unity worker; requires preflight. An accepted receipt does not mean training succeeded.
- `football_fyp_runs`, `football_fyp_status`, `football_fyp_task_status`: receipts from the FYP checkout, not legacy run discovery.

The FYP repository contains `Training/atlas_contract.json`, `Training/atlas_fyp.py` and the fixed `Assets/Football/Editor/AtlasFypBuild.cs`. Training artifacts, model exports, build stamps and logs live under ignored `.atlas-fyp/`. The bridge refuses stale source/bundle fingerprints and does not accept caller-supplied commands.

## Required live acceptance before a pilot

1. Confirm clean FYP source and Unity Editor compilation while the correct FYP Editor is open.
2. Install a compatible isolated ML-Agents Python trainer into `.venv-fyp`; verify trainer and Unity package handshake.
3. Close the FYP Editor, invoke the fixed Atlas build and inspect its receipt and player log.
4. Verify the source hash and entire Unity player-bundle hash, then launch the 2,048-step smoke.
5. Inspect trainer/Unity logs, terminal process state, checkpoint, ONNX export and at least one visual episode before deciding whether to allocate a 50k pilot.

**Not delivered yet:** source-pinned FYP v1 graphical Watch, deterministic held-out policy evaluation, evidence-linked human reviews for FootballV1, policy packaging/promotion, multi-agent teamwork competency. These are separate FYP research and integration gates; the legacy Generalist implementations must not be reused without new ABI and provenance checks.
