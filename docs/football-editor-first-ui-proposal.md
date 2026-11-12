# Football Training: editor-first UI proposal

Date: 2026-11-12
Status: implemented locally; pending visual acceptance and deployment
Scope: Atlas Web Football Training experience for the standalone FYP FootballV1 workflow

## Recommendation

Make the FYP path read as an editor-connected experiment workflow, rather than a headless trainer dashboard with an editor note. Put Unity readiness and the next action first, make the learner-to-Play handshake explicit, and keep training, evaluation, and evidence tied to a specific checkpoint. Preserve the existing typed Atlas operations, ABI checks, receipts, and separation between a candidate model and an approved policy.

This is a UI information-architecture and interaction change. It does not change Unity physics, training semantics, model compatibility, or policy-promotion rules.

## What the current page communicates

The deployed Football Training page already has a dedicated FYP v1 panel, editor preflight, bounded smoke and pilot actions, run receipts, and editor checkpoint evaluation. The inspected page showed the correct FYP workspace, loaded scene, ready trainer, completed smoke receipts, and completed evaluations.

Several surrounding cues still suggest the older headless/generalist workflow:

- The page title is **Generalist**, while the selected view is **FYP v1 training**.
- The experiment navigation still includes **Choose scenario** and **Set up training**, although this FYP route uses one named scene and a specific 25-observation/8-action contract.
- Readiness, training, all historical receipts, and evaluation controls are stacked into one long page. The user has to infer what to do next from explanatory copy.
- After launching a learner, the important next action is to press **Play** in the Unity Editor. This is currently a note below the training buttons rather than a distinct waiting state.
- Training and evaluation share one seed input, even though they are separate experiments and should be reproducible independently.
- The latest-operation receipt can say `launching` while the evaluation history already says `completed`, leaving two conflicting status sources on screen.
- Contract numbers and the scene path get prominent space, while operationally useful states such as compiling, stale heartbeat, active learner, and waiting for Play are easy to miss.

## Proposed interaction

### 1. Rename and simplify the FYP route

Use **FYP Football** as the page title and **Experiments**, **Evidence**, and **Archive** as the primary sections, matching the existing simplification roadmap. Keep historical Generalist workflows reachable under Archive or a clearly labelled legacy route; do not mix them into the main FYP launch path.

Remove the FYP route's **Choose scenario** and **Set up training** step buttons. The FYP experiment identity is already fixed by its scene and contract. Keep compatible training and evaluation controls within that experiment.

### 2. Put a compact Unity readiness panel above the controls

Show the states that determine the next action in one line or compact card:

| Signal | Example display |
| --- | --- |
| Unity Editor | Open / Closed |
| Scene | `OpenGoalClose` loaded / Wrong scene / Not loaded |
| Editor mode | Edit Mode / Play Mode |
| Compilation | Ready / Compiling |
| Trainer | Ready / Missing |
| Connection | Waiting for Play / Connected |
| Heartbeat | Fresh / Stale, with last update time |

Use plain-language labels and one primary call to action based on the state. For example, when the correct scene is open in Edit Mode and the trainer is ready, show **Start smoke run**. After the learner request is accepted, replace the launch action with **Waiting for Unity — press Play in the FYP Editor** and show the run receipt beside it. When connected, show **Training in Unity** and the current progress available from the existing status data.

Keep the contract and source fingerprint in a compact **Experiment details** disclosure. The model ABI remains visible before launch, but does not compete with readiness and the next action.

### 3. Treat smoke and pilot as different commitment levels

Keep the 2,048-step smoke as the primary action. Present the 50k pilot as a secondary action with a short step-count and expected-work disclosure, and gate both on a fresh preflight and absence of another active FYP training operation. A disabled action should explain whether Unity, the trainer, the scene, or an existing run is blocking it.

After either action, keep the operation's lifecycle visible in place:

`Ready → Learner starting → Waiting for Play → Connected / Training → Completed or Failed`

An accepted ticket means **requested/launching**, not training success. Replace the current separate, potentially stale “latest operation” message when a newer receipt is authoritative; retain older receipts in the history list. Keep completion tied to the durable run receipt, including exit code and ONNX export state.

### 4. Make evaluation a checkpoint-specific next step

Show **Evaluate** only for a completed run with an exported checkpoint. Put the action on that run's row or detail card so the relationship is clear. Give evaluation its own episode count and seed controls, separate from the training seed. Present its lifecycle and measured numerator/denominator together, for example `10/10 episodes · 1 goal · 10%`.

Keep evaluation in the visible Unity Editor flow: communicate when the user should stop Play Mode, when Atlas has started the inference runner, and when Unity must be put into Play Mode. Do not describe an accepted evaluation as completed until its final receipt arrives.

### 5. Separate candidate evidence from approval

Label a successful export as a **candidate checkpoint**. Link its training receipt and evaluations in the Evidence section. Preserve the current rule that Atlas does not automatically evaluate, promote, or advance a research phase. Archive keeps historical and legacy runs readable without presenting them as FYP v1 candidates.

## Suggested page structure

```text
FYP Football                         Experiments | Evidence | Archive

Unity readiness                      Experiment details (collapsed)
Open · OpenGoalClose · Edit Mode     FootballV1 · 25 observations · 8 actions
Trainer ready · Waiting for Play     Source fingerprint · MA-POCA

Start smoke run       Run 50k pilot (secondary)
Seed: [training seed]

Current operation / active run       Recent FYP runs
status, next action, progress         checkpoint, seed, state, export
                                      [Evaluate] when eligible
```

Evaluation settings can expand inline from an eligible run. Evidence and archive use their own views rather than extending the launch page indefinitely.

## Delivery sequence

1. **First pass: clarity and navigation.** Rename the FYP route, remove obsolete FYP step labels, group readiness and launch, make waiting-for-Play a visible lifecycle state, separate training/evaluation seeds, and reconcile operation status against durable receipts.
2. **Second pass: run-focused evidence.** Give each run a compact detail view with checkpoint/export facts, evaluation summaries, and recent episode outcomes. Keep raw diagnostics bounded and easy to inspect.
3. **Follow-up only if needed.** Add a typed graceful-stop operation before offering a Stop control; the current FYP operation set does not expose one. Consider richer progress only where the Node provides measured fields. Do not imitate headless throughput charts or invent an ETA from episode count.

## Acceptance criteria

- A first-time user can tell which Unity project and scene are required and what to do next without reading a long paragraph.
- The page title and navigation describe the FYP editor workflow; obsolete scenario/setup steps are absent from the FYP path.
- The UI distinguishes an accepted request, waiting for Play, an active trainer connection, completed training, and failure.
- A stale operation ticket cannot contradict a newer completed evaluation or run receipt.
- Training and evaluation seeds are independent and recorded with their respective receipts.
- A second training launch is unavailable while an FYP learner is active, with the reason shown.
- Evaluation is attached to the exact completed checkpoint, and success is displayed as measured episodes/goals rather than an unqualified percentage.
- The 25/8 contract, source identity, and candidate-only status remain visible or one click away.
- Legacy evidence remains readable, and no UI action automatically promotes a model or advances the research phase.

## Boundaries and open implementation checks

- Use existing FYP manifest, preflight, run, evaluation, and operation receipt data. Any missing lifecycle state or concurrency guarantee should be added through the typed Atlas protocol and Node capability before the UI assumes it exists.
- The existing page polls several FYP resources every three seconds. In the first pass, retain the bounded refresh behavior unless profiling shows it needs changing; avoid adding a separate streaming architecture just for this redesign.
- No stop action is proposed until a supported, graceful FYP stop operation exists.
- The inspected hosted page and current source both show the title/navigation/status mismatches above. Review the local branch against the deployed build before implementation so the UI change does not overwrite newer work.
- The unrelated Unity `NoSubscription` message observed during the smoke run should not be treated as trainer failure when the durable training receipt reports exit code 0 and exported artifacts. If it recurs, present it as a separate Unity diagnostic rather than a training lifecycle state.

## References

- `apps/web/src/FypV1Experience.tsx`
- `apps/web/src/FootballGeneralistExperience.tsx`
- `docs/football-atlas-simplification-roadmap.md`
- `docs/football-training-application.md`
