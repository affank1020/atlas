# Atlas Football Validation V1 — Local implementation handoff (12 October 2026)

## Scope and status

This implementation is **in the local dirty Atlas main workspace only**. It has not been committed, deployed, or restarted on Hosted Server/Web/Mac Node. All existing football assets, checkpoints, training jobs, scenes and evaluation provenance are preserved. As of this handoff `npm test` succeeds: **155 backend/Node tests, 74 web tests, native Mac Node UI check**, and production TypeScript builds.

Atlas Web: **Applications → Football Training → Validation**.

The first-party Football Training Application exposes:
- `football_validation_status`: read past per-run receipts (up to 30 recent), availability and source fingerprint
- `football_validate_python`: run precisely `python3 -m unittest discover -s tests -v` in AI Football Workspace with fixed argv (no shell/user path/environment override), capped output, 180-second local timeout
- `football_validate_editor_gates`: sequential four deterministic Unity Editor tests (Stage3/Shooting v2/Receiving v2/Defending v2), new-console-event verification, scene-state / Unity compiler / trainer-idle preflight
- `football_validate_physics_smoke`: optional **shared Rigidbody**, real Play Mode collision/goal smoke, fresh Console PASS and Editor-return-to-stopped checks. Requires explicit confirmation in Web. It **does not** demonstrate policy quality or end-to-end Shooting/Receiving agents.

All actions route via `FOOTBALL_PROJECT_ID` and active AI Football Unity Workspace to Mac Node. Structured outcomes are saved atomically as `training-driver-runs/atlas-validations/val_<uuid>.json` in the AI Football root. Receipts include status, duration, partial output/errors, checks, local source SHA-256 manifest (relevant C# / Python tests / trainer contracts) and timestamps. Failures, exceptions and missing PASS records are stored as failed evidence. Web reads saved receipts; no historical manual PASS is falsely represented as a new automated result.

## Safety and approval

- Only the FYP Unity Workspace can invoke these actions. No generic command execution.
- Python runs a fixed command and cannot accept arbitrary command, argv, path or environment.
- Unity invocation still uses the existing `UnityAdapter` owner-command approval: with default Mac Node configuration, `menu` remains **unapproved** and corresponding Web buttons stay disabled. Even if approved, the Adapter accepts **only** these five exact football validation menu paths and blocks all arbitrary menu paths and menu listings:
  1. `Football/Drills/Test Stage-3 Control Gate`
  2. `Football/Drills/Test Shooting v2 Gates`
  3. `Football/Drills/Test Receiving v2 Control Gate`
  4. `Football/Drills/Test Defending V2 Physical Gate`
  5. `Football/Drills/Run Physical Collision Smoke (Play Mode)`
- To enable after local rebuild/deployment, the **Mac operator** may add `menu` to `ATLAS_UNITY_ALLOWED_COMMANDS` in the private Mac Node environment **while preserving the existing approved commands**, then restart only the Mac Node via its existing controlled operator procedure. Atlas itself cannot change this permission through MCP/HTTP. Restrict changes to the local private operator configuration; never expose credentials.
- Unity runs require correct Editor root, stopped Play Mode, clean scenes, completed successful compile, zero active/queued football trainers. No second Editor or build. A run is accepted only on fresh Unity Console events, not existing log history.
- The shared physical smoke enters Play Mode in whichever scene is open. The current `MovementEvaluation` scene starts its own evaluation harness on Play; ML-Agents will log an inference fallback without a trainer. That noise is not test failure, but this **is not isolated enough for future agent-level scientific experiments**. A later dedicated PlayMode test assembly or isolated-player runner should solve this before M2 specialist acceptance.
- Existing editor smoke emits real physics PASS from the user’s manual run. Atlas automation backend code has been unit/mocked-integration tested, but **has not yet been executed end-to-end against deployed Atlas Server + live Mac Node**.

## Activation

1. Use the existing Atlas deployment/operator workflow to deploy the updated Server, Web and Node sources together. Do not restart another Unity Editor or delete Library/locks. Deployment is separate and needs user authorisation.
2. Open Football Training → Validation. `Run Python tests` should work without adding a Workspace dev-task or changing DB definitions (direct, bounded first-party validation action). Old prototype `scripts/football-dev-tasks.json` is superseded by this dedicated action and should not be registered unless explicitly wanted for WorkspacePanel parity.
3. If automatic Unity checks are desired, owner approves the restricted `menu` capability via Mac Node environment as above and restarts the Node. Then Unity gate and physics buttons become available; verify scenes clean and training stopped.
4. Use Validation receipts to check real passes, failures, source hash and log. No silent policy promotion. For M2 skill competency, separately run agent-level physics positives/negatives and matched seeded runner comparisons.

## Verified implementation testing

- 155 server/Node tests include scoped football tools, fixed Python PASS/FAIL receipts, local permission rejection, arbitrary menu rejection, fresh physical PASS vs stale-Console-PASS-and-new-exception, existing infrastructure suites.
- 74 web tests include Validation actions, status/history rendering, disabled Editor commands without owner approval and physics Play confirmation.
- Native Mac Node UI typecheck passed.
- No service deployment, PPO launch, new ONNX model, commit or Git reset performed.
