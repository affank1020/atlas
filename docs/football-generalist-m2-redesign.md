# M2 Generalist Programme — Architecture & Atlas product contract
Status: proposed / migration R0 (2026-10-14). No generalist checkpoint verified. Replaces the separate-specialist training roadmap **prospectively**; historical data remains available.

## Product intent
The default Football Training tab is Generalist. Show the current canonical policy, capability/contract versions, verified skills, curriculum stage, retained regressions, latest comparable evaluation, and policy playback. Do not infer progress from completed jobs, run count, reward curves, or legacy policy count. A missing measurement is 'not evaluated', not zero.

## Data model to implement
- GeneralistPolicy: policy ID, training lineage, observationContractVersion, actionContractVersion, curriculumVersion, checkpoint, originating run, hash, promotion status and timestamps.
- AgentContract: Unity-exported ordered observations (name, count, coordinate frame, scale, mask/optional semantics) and actions (index, range, interpretation, actuator/clamping). Show the exact live contract in Atlas, never a manually copied approximation.
- CurriculumScenario: ID, stage, objective, physical setup, arena bounds, target visual, difficulty parameters, reward design, terminal conditions, training mixture weight, playback seed, build fingerprint and canonical scenario version.
- GraduationEvidence: checkpoint, scenario version, deterministic seed set, success criteria, measured baseline/agent outcome, video/viewer replay link, contact and kick physical outcomes, retention test, decision and reviewer.
- Legacy: preserved checkpoints/configs/scenes/runs with 'legacy-m2' classification. Active generalist index should filter to explicitly compatible contract versions.

## UI information architecture
1. Generalist (default): hero policy and verification state; capability matrix; S0-S5 progression; observations/actions contract inspector; latest validated benchmark and recent regressions; primary Watch action.
2. Curriculum: stage dependency map, current mixture, scenario cards, physical difficulty ladders, decision complexity, admission/graduation tests.
3. Drills: active scenarios first; legacy catalogue separated and visually labelled. Each card documents purpose, target visual, metrics, initial conditions, reset/termination and playback status.
4. Runs: existing live feed, logs, throughput, stoppage, launch receipts unchanged; add linked policy and scenario metadata.
5. Evaluation: existing real evaluations and episode diagnostics, plus retention and baseline panels.
6. Policies / Watch: generalist checkpoints first, compatible replay only, legacy accessible behind filter. Show scene/version/build/obs-action signatures prominently.
7. Roadmap: R0 audit/archive → R1 interface → R2 curriculum + replay → R3 movement/possession → R4 kicking/distribution → R5 decisions → R6 opposition and final validation.

## Proposed fixed agent interface (needs physics and Unity code audit before freeze)
Observations: egocentric self kinematics, ball relative position/velocity, pitch boundaries and goal geometry, teammate/opponent slots and masks, match state, kick readiness. Fixed shape across scenarios; reserve agent slots; canonical ordering, transforms and normalisations specified in code plus generated manifest. No 'correct action' or privileged teacher label in the deployed observation stream.
Actions: continuous Move X/Y, Turn, Kick trigger, Kick power, Kick angle; define exact local coordinate semantics, threshold/retrigger/cooldown, clamp and impulse map. Confirm whether Unity's existing actuator is compatible before training; contract change implies new version and fresh evaluation.
Future match decision-making emerges from action selection and game rewards; early goal-directed subtask guidance must not become a mandatory oracle input. Test for reliance on masks/task labels.

## Curriculum protocol
Separate physical difficulty (distance, velocity, geometry, precision and pressure) from decision complexity (number of viable football actions and their outcomes).
S0 contact; S1 controlled possession and directional dribbling; S2 deliberate finishing; S3 pass + receive; S4 choose dribble/shoot/pass in blended scenarios; S5 opposition and basic defending. Offer simple two-choice decisions by S1 rather than postponing all decision learning.
Stage promotion requires seeded held-out success versus baselines and visual rollout on a reconstructed scenario, plus retention thresholds on all earlier skills. Percentages and sampling weights are hypotheses to tune, not hard-coded facts.
Sample both current and previous stages, favour learning-progress bottlenecks, and diagnose absent legal contact/kicks before launching expensive PPO. Do not silently advance a stage on reward alone.

## Unity training arena / Watch parity
Visible grass/pitch coloration, clear high-contrast border walls with correct physical colliders, target labels at waypoints, ground-projected waypoint/dribble arrows, actual goalposts and goal line, labelled passing receiver/zone, contrasting pillar dummies for blockers and scripted defenders. A minimal in-world overlay gives scenario ID, stage, objective, success/fail signal, episode duration, current difficulty, metrics, seed and policy ID.
Training and Watch must load the same ScenarioDefinition, reproducible seed, spawn positions, reward/terminal contract and physical objects; presentation toggles cannot change physics. Headless scenes may disable rendering but never omit colliders or target definitions. Physical boundary bounce/wall contact must be checked for unwanted rotation, trapping and collisions. Never claim playback parity until automated reproducibility tests and a watched sample pass.

## Migration and release gates
R0: create immutable inventory of all tracked and untracked specialist scenes, scripts, policies, checksums, config and runs, including recent dirty Unity changes. No deletion.
R1: unify agent/physics/obs/actions; version and test contract with vector-shape and semantics tests.
R2: introduce data-driven scenario definitions, scenario HUD/markers/walls, reproducible headless/viewer parity test and one S0 scenario. Archive legacy in UI without hiding historic evidence.
R3-R6: train/evaluate/promote sequentially with mixed rehearsal and reproducible visuals. Check regressions and empirical decision discrimination.
Before deploy: run Atlas web tests/build; Unity compile and build tests; physical scenario verification; real Watch test on a compatible checkpoint; cross-app data/status verification; deployment of Web/Server/Node versions as required.

## Research rationale
Google Research Football Football Academy (2020), From Motor Control to Team Play in Simulated Humanoid Football (2022), Reverse Curriculum Generation (2017), and Prioritized Level Replay (2021) inform scenario-based skill acquisition, skill reuse, adaptive starts and rehearsal. They do not prove an optimal schedule for this project.
