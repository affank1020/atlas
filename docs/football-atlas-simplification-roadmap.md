# Football Training in Atlas — simplification roadmap

Date: 2026-11-11
Status: Partial local implementation plus remaining delivery plan. No Atlas deployment or policy promotion has occurred.

## What happened on 11 November

- The original Mac Atlas folder cannot currently be treated as a working source checkout: `git status` fails with `fatal: bad object HEAD`, its `main` ref points to a missing commit, and the active Football component plus several imports are absent from `apps/web/src`. These observations do not establish the underlying filesystem cause. Existing files and Git metadata were left in place.
- A clean checkout was made from GitHub, then based on the open FootV1 integration branch from PR #220. The local `codex/atlas-simplification` branch implements a first UI slice: Experiments / Evidence / Archive navigation, a visible training setup summary, contract and scenario hashes on run cards, and matching loading UI. It changes no Atlas Node, Server, Unity runner, saved model, or policy promotion logic.
- The focused Football UI suite passed 20/20 tests and `npm run build:web` passed in that clean checkout. These checks do not prove the Mac Node or hosted Web has loaded the change.
- Automatic approval review rejected the attempt to push the branch to `affank1020/atlas`: implementation was authorized, but publication of the code and documentation to that remote was not explicitly authorized. No branch was pushed and no PR was opened. A local patch is saved at the Atlas workspace root as `atlas-simplification-20261111.patch`; it applies on top of PR #220's head, not directly to current `main`.

### Completion ledger

| Area | Current state | Remaining result |
| --- | --- | --- |
| A0 supported path | FootV1 typed operations exist on open PR #220; local UI slice builds against that branch | Restore a reliable Mac checkout, verify PR #220 and active Node/Web, then integrate the UI slice |
| A1 G0.5 evidence | Run cards show the recorded scenario and contract hashes; setup distinguishes FootV1 54/7 | Comparison cases, negative controls, learned results, Watch packet, and human decision still need a connected evidence view |
| A2 routine workflow | Three primary sections and a setup summary are implemented locally | Unify status wording and policy selection; check the full workflow in the live Atlas app |
| A3 G1–G3 | Planned | Build only when those FYP protocols and results exist |
| A4 G4 cooperation | Planned | Build only after the G4 research gate opens |

## Purpose

Keep Atlas useful as the managed front end for the changing FYP experiments while making the normal path easier to understand. The user should be able to answer, from one place: **what experiment is this, which controls and policy contract does it use, what happened, and what evidence supports the next decision?**

The transcript's design direction is not an automatic dribble mode. The intended research split is a bounded player motor and physically/contact-gated ball-touch capability, with the policy learning when, where, and how strongly to use it. Forward-facing movement and striking should retain a useful bias; sideways corrections are available, while fast backward travel and powerful rearward kicks are not the default. Atlas should expose the experiment and its evidence without implying that the UI or controller solved the learned behavior.

## Scope and guardrails

- Keep the existing typed, allow-listed Atlas operations and provenance checks. Simplification is primarily about navigation, labels, and evidence presentation, not removing execution safeguards.
- Keep old runs, policies, evaluation receipts, scenario definitions, and source-pinned viewers readable. Archive or label legacy paths; do not delete, rewrite, or silently reinterpret history.
- A change to contact physics needs a new environment fingerprint. A changed action meaning or new learned touch action needs its own versioned policy contract. Tensor shape alone is not compatibility evidence.
- Distinguish scripted mechanical feasibility from learned policy behavior. An Atlas launch receipt, successful packaging, or high shaped reward is not a competency or promotion result.
- G0.5 remains an experimental decision gate. Atlas must not automatically select a mechanics variant, promote a policy, or advance the FYP phase.

## Proposed Atlas experience

Use one primary **Experiments** workflow with three linked steps:

1. **Set up** — choose a named phase/scenario, mechanics variant, compatible policy or explicit scratch initialization, run size, and seed. Show the actual environment and action contract before launch.
2. **Review** — see the run state and bounded diagnostics; compare scripted physics probes or learned candidates under matched conditions; open the correct source-pinned Watch where available.
3. **Decide** — record the human visual verdict and the evidence-backed next action: keep current mechanics, adopt a versioned variant, revise, or stop. Atlas records the decision; it does not make it for the researcher.

The home view should prioritize the active phase, next required gate, latest relevant evidence, and any blocked action. The primary routes should be **Experiments**, **Evidence**, and **Archive**. Training, evaluation, policy selection, and Watch are controls within an experiment rather than competing top-level concepts. Contract and run provenance stay visible at the point a user makes a compatibility-sensitive choice. Historical specialist and other archived workflows stay read-only and remain separately reachable.

## Work plan

### A0 — Establish the supported path (before more Atlas UI work)

- Confirm the current canonical Football Generalist route and operation set; label the Generalist interface as the current path and the legacy specialist surface as read-only archive.
- Reconcile the FootV1 Atlas integration with the current G0.5 state. PR #220 is documented as open and unmerged, the Mac checkout/service has a file-read failure, and the 50k Atlas request was rejected by the stale service. Treat those as operational blockers to resolve and verify; do not add another launch path as a workaround by default.
- Define a short source-of-truth mapping: FYP roadmap and experiment record own research decisions; Atlas owns launch/status/evaluation/viewer receipts and links back to that evidence.
- Acceptance: one documented Atlas route can launch only an allowed, correctly versioned experiment; the UI identifies when that route is unavailable and does not imply a launch occurred.

### A1 — Make G0.5 mechanics comparison legible

- Add explicit variant labels for baseline capsule, passive side/foot contacts, and (only if retained) deliberate contact-gated gentle touch. Display environment fingerprint, observation/action contract, policy lineage, runner/build hash, scenario, and initialization status together.
- Provide an experiment summary that separates: scripted physics cases, negative controls, learned training, held-out evaluation, and human Watch review. Show counts and actual outcomes, not just pass/fail or reward.
- Present the G0.5 A/B packet around the roadmap's same-pose cases and 8–12 varied Watch episodes. Mark comparisons as unmatched where scenario, controller, runner, or policy differs. Include limitations such as a scratch 2k FootV1 policy being less trained than V7.
- Record the human decision explicitly as pending / keep / adopt / revise / stop, with the selected version and rationale. Do not translate a visual review into universal competency.
- Acceptance: a user can tell whether an observed left/right redirection came from physical collision, a gated touch request, or learned policy behavior, and can distinguish that result from a matched performance comparison.

### A2 — Reduce routine workflow friction

- Consolidate Train, Runs, Evaluate, Policies, and Watch into the experiment's guided flow while retaining their existing typed backend actions.
- Default to the next authorized phase action and show a compact setup summary; require intentional selection for scratch versus warm start, contract variant, seed, and smoke/pilot budget.
- Use consistent plain-language status terms: requested, launching, running, completed with evidence, failed, or unverified. Keep packaging/registration separate from training completion and policy promotion.
- Replace duplicate default/featured policy choices with one provenance-safe selector organized by compatible candidates, frozen baselines, and historical policies. Do this only after the selector's contract checks are verified.
- Acceptance: a normal G0.5 or G1 task does not require users to understand Atlas's internal service names, and no simplified control can launch an incompatible contract or conceal an unresolved status.

### A3 — Carry the same evidence pattern into G1–G3

- Reuse the experiment summary for varied starts, retrieval, turning, shooting, blocked lanes, and a real defender. Keep solo and defended tasks distinct and label scripted opponent versus learned opponent.
- Compare candidates against frozen V7 or a subsequently approved Striker baseline on matched environment/seed/task conditions; show retained skills alongside new-task results.
- Add only the diagnostics that answer a decision question: goal success, successful time-to-goal, ball recovery/control events, legal contact/kick, blocked versus wide shots, and concise movement/contact traces.
- Make the required visual packet, verdict, and next hypothesis part of each phase gate.
- Acceptance: phase advancement is supported by reproducible held-out evidence and an explicit human review, and failed or awkward episodes remain easy to inspect.

### A4 — Add cooperative views only when G4 is ready

- Introduce group size, team roles, and MA-POCA-specific controls only in the distinct cooperative experiment path after solo/1v1 evidence warrants them.
- Keep solo policy ABI, cooperative policy ABI, and historical V2/V3 group probes explicit. Compare solo and 2v1 on the same held-out opponent conditions.
- Show real assists, controlled receptions, team goal rate, contributions by player, and separation; do not rank by group reward or pass count.
- Acceptance: Atlas makes it clear whether an apparent team gain comes from meaningful support or one agent doing all the work.

## Not in the first simplification pass

- No new dribble state, automatic ball attachment, automatic follow-up touch, tactical oracle, or learned possession privilege.
- No broad Unity/Atlas architecture rewrite, full dashboard project, duplicate launch CLI, or viewer replacement.
- No automatic roadmap advancement or policy promotion.
- No cleanup that renames run IDs, erases old UI routes before the archive works, rewrites historical scenario meaning, or changes training/reward semantics under a UI-only task.

## Delivery and decision gates

1. **A0 operational check:** recover a reliable Atlas Node workspace/service path and reconcile the FootV1 integration branch without blind checkout, reset, or merge. Verify the supported Atlas route with an explicitly bounded smoke only when the existing FYP gate authorizes it.
2. **A1 G0.5 evidence view:** implement and review the comparison summary before using it to decide on adoption. Show source and environment stamps and real case outcomes.
3. **A2 workflow pass:** simplify navigation and routine setup without weakening typed operation, status, or contract checks. Retain an accessible archive route.
4. **A3/A4 phase-specific views:** add only when each FYP phase has an approved protocol and real evidence to display.

Each delivery should be a small Atlas change with its own acceptance evidence. Building a bundle is not proof that the running Node or hosted Web uses it; deployment and the relevant Mac graphical acceptance check remain separate. Do not restart Atlas services while a training job is active.

## Remaining implementation tickets, in order

### R0 — Make the Atlas source and FootV1 route usable

Inspect the damaged Mac checkout without reset or overwrite, inventory any local changes, and work from a verified complete checkout. Resolve the missing Git objects and files or retire that checkout after preserving its contents. Check PR #220's current diff and CI, reconcile it with any local Node/UI work, and verify the Mac Node can read and build `apps/node`. Once integrated and deployed, confirm the actual Generalist manifest, FootV1 training allowlist, policy packaging, and source-pinned Watch from the connected Mac. **Done when:** Git status and Node/Web builds work in the chosen checkout, the running service reports the new capability, and a rejected or accepted launch is represented by its real receipt. No 50k run is implied by this ticket.

### R1 — Represent one experiment's evidence

Define a compact experiment record keyed by scenario, mechanics variant, action contract, environment/build fingerprints, policy lineage, and seed partition. Attach existing run, scripted physics, negative-control, evaluation, and Watch receipts by immutable IDs; retain source links rather than copying or changing historical outcomes. Add a G0.5 evidence view with separate sections for mechanical feasibility and learned performance. **Done when:** a baseline-versus-FootV1 view names its exact conditions and flags unmatched scenario, controller, build, or policy comparisons. Missing evidence is shown as missing, never as a pass.

### R2 — Prepare reproducible visual review and decision capture

Build the 8–12 episode packet from recorded seed/episode IDs, including failures and awkward starts. Expose a source-pinned Watch action only where the saved runner/model contract verifies. Store the reviewer's verdict, observed failure, decision rationale, selected version, and next hypothesis against the experiment; use pending / keep / adopt / revise / stop. **Done when:** a decision can be traced to exact receipts and the user can reopen the same cases. A visual verdict does not automatically feature a policy or advance the roadmap.

### R3 — Finish the routine workflow cleanup

Map backend receipt states to clear UI labels without treating an accepted launch as completion. Keep training, packaging, registration, evaluation, and promotion as separate facts. Replace duplicate policy defaults with one selector that groups compatible candidates, frozen baselines, and historical playback, and validates the chosen operation against the recorded contract. Preserve the read-only archive and run/profile detail paths. **Done when:** the user can set up, inspect, evaluate, and watch a compatible candidate from the guided flow, while incompatible or unavailable choices explain why they are disabled.

### R4 — Connect the G0.5 decision to later phases

After the FYP chooses a mechanics variant, make the chosen version explicit in G1 launch presets and scenario descriptions. Reuse the evidence and review record for G1–G3: varied starts, goal scoring, blocked lanes, and a physical defender. Show matched held-out goal success, time-to-goal, earlier-skill retention, and concrete failure cases. **Done when:** a proposed phase advance has the specified measurements and a human review record; an unapproved candidate remains experimental.

### R5 — Add cooperation only at the G4 gate

Introduce a separate cooperative setup and comparison view with explicit group size, MA-POCA contract, opponent conditions, and Striker initialization compatibility. Show team goals and time, genuine assists and receptions, each player's contribution, and separation. Keep archived V2/V3 probes distinct. **Done when:** the solo and 2v1 results can be compared under the same held-out conditions and the display makes one-player-only success visible.

## Source alignment

- FYP canonical sequence and Atlas cleanup principles: `validation/generalist/goal-driven-football-roadmap-20261110.md`.
- G0.5 mechanics, contact invariants, evidence suite, and adoption gate: `validation/generalist/g0-5-foot-contact-prototype-plan-20261110.md`.
- Current Atlas application boundaries and operation semantics: `docs/football-generalist-atlas-migration.md` and `docs/football-training-application.md`.
- This roadmap is an Atlas delivery plan under those research decisions; if they change, update this plan rather than create a competing FYP research roadmap.
