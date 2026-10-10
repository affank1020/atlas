# Football Policy Evaluation — M2 Exit Gates and General Policy Handoff
Updated 2026-10-10. Document status: roadmap, not a claim of deployed capability.

## Phase boundaries
M2: Build defensible individual football skills via drills, accurate real physics outcomes and reproducible held-out seeded evaluation.
M3: Training/inference orchestration and monitoring. Multi-arena/headless/viewer are operational, but streaming events and complete lifecycle state still need work.
M4: General shared-policy architecture with a unified input/output contract, task conditioning, skill transfer, specialist fine-tuning and forgetting tests.
M5: Small-sided multi-agent games, with passing, receiving, cooperation, roles and 2v2/3v3.

## M2 remaining — implementation order

1. Stage 1 diagnostic trust. Instrument start player–ball distance, closest player–ball distance, time to first physical contact, episode duration and termination reason. Expose bounded per-episode details via Atlas and mark older measurements absent. Regression-test with a fresh Unity evaluation. Compare against random/no-op and simple scripted baselines.
2. Stabilise basic approach. Evaluate every checkpoint on fixed held-out multi-seed suites (at least three seeds, >=100 episodes/seed), track physical contacts/near misses and failure categories, not PPO reward alone. Record policy/config/build hashes and confidence intervals. Example gate: >=80% contact on each held-out seed; agree threshold before promotion. Current 20k policy: 61/300 (20.3%) versus independently trained 100k policy: 108/300 (36.0%) on seeds 515/616/717; not ready for next stage.
3. Stage 2 first touch then Stage 3 dribble. Train real ball-control displacement and retention, reject accidental movement exploits. Implement checkpoint continuation and policy lineage between manual stages, or deliberately compare from-scratch baselines. Test approach retention and later dribbling generalization; the current three presets create independent policies.
4. Define a versioned unified football observation/action contract before serious general policy training. Include egocentric body/ball/goal and target state, velocities, missing-agent masks and task cue. Add explicit kick timing/strength/aim alongside throttle/steering. Retain old v1 model compatibility; cannot silently load 10-observation/2-action policies into expanded contracts.
5. Upgrade and validate drills: movement waypoint completion; shooting actual kicks/goals; passing a real receiver; receiving physical teammate feed rather than only a virtual scripted pass; defending versus at least a scripted ball carrier; integrated possession transitions. Require matching baselines and real success outcomes for each drill.
6. M2 exit gate: repeatable, physically meaningful skill demonstration on varied seeds; verified reward semantics, no known exploits, diagnostic reporting, reliable headless/visualised inference, at least one strong approach/control policy and credible evidence from other key drills. Separate runnable scaffold from mastered behaviour.

## General policy (M4)
A foundation football agent should take a shared versioned observation vector and action vector, conditioned on a task or goal. Train across movement + approach/control first, confirm switching and skill retention, then add touch, dribble, shooting, passing, receiving, defending. Compare mixed-task training to distinct specialist policies and continued fine-tuning. Inspect catastrophic forgetting and cross-task transfer. A policy is only general if evaluation demonstrates multi-task capability; naming it general does not create that capability.

## Atlas Football Training app next iterations
P0: Evaluation diagnostics. Typed bounded evaluation-detail action, distance/time and real contact summaries, termination reasons and paged episode explorer. Unity+Python, Atlas server+Node and web must all agree. Old records show missing measurements rather than zero. Currently implemented in local code, pending live deployment/verification.
P1: Policy Library V3. Friendly model names, tags, roles, task/stage, contract version, model hash, checkpoint selection, parent policy and training lineage, indexed/exported/evaluated/selected states, archived filtering, direct Watch and evaluation links.
P2: Evaluation Suites. Named and versioned seed distributions, episodes, success criteria, automatic batch evaluation, progress/queue/retry/cancel, per-seed contact/timing/distance and uncertainty. Connect measured results to policy/Unity build/config hashes.
P3: Comparison Lab. Same-seed comparisons of multiple policies/checkpoints; learning and regression across tasks, confidence intervals, baseline/champion promotion decisions, visualization and qualitative replay notes.
P4: Live Run/Evaluation Control Rooms. Structured append-only events, Node cursored reads, server push/SSE with polling fallback, reliable terminal reasons and reconnect handling. Native Unity viewer remains independent; embedded browser video requires separate capture technology.
P5: General-policy experiment workspace. Task mixtures and curriculum, shared observation/action contract, checkpoint transfer, retention tests, role specialists, and later 2v2/3v3 match metrics.

## Two-part M2 acceptance rule
Every feature requires (A) working Unity/driver behavior, reproducible measurements and tests, AND (B) corresponding Atlas launch, inspection, validation and history. Neither side should silently diverge.

## Explicit constraints
The existing Run Control Room polls bounded trainer logs, not a live structured metric stream. The new diagnostic fields only appear after a fresh Unity evaluation with updated source; historical evaluation reports cannot reconstruct them. Shared policy training and stage transfer are not implemented yet.
