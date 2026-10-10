# Football Training — Run Control Room & Live Evaluation Plan
Status: first React control-room MVP implemented locally and tests passing, 2026-10-10; advanced structured telemetry and SSE remain proposed.
Implementation (local worktree, NOT deployed):
- New `apps/web/src/FootballRunControlRoom.tsx` and `football-control-room.css`, with clickable run detail via `?run=`, a bounded log poll (3.5s), reward plot, step budget, checkpoints, Watch/Index/Evaluate/Stop actions, completion labelled only as 'likely' from evidence, and final evaluation detail view.
- `FootballTraining.tsx` opens run and evaluation details and automatically polls evaluation launch receipts every 4 seconds, then refreshes recorded results. Native Unity viewer remains separate.
- `FootballRunControlRoom.test.tsx` and `FootballTraining.test.tsx` include parser/detail/navigation checks.
- Verified `npm test` (138 server/Node + 64 web tests passing) and `npm run build:web` succeeding.
- GitHub plugin branch-write attempt refused with 403 Resource not accessible by integration. Changes must be committed/pushed from local Atlas working tree to trigger normal deployment. No change to hosted server/Node contracts has been deployed.

Owner: FYP / Atlas Football Training
Scope: Atlas Node + driver contracts, Atlas Server transport, Atlas Web application

## Context and motivation
- 2026-10-10 M2 ball-control stage-1 `approach` run `ball_control_v1_20261010_101826_7d9b40` ran 2 arenas (seed 515, port 5250), logged 10k and 20k steps, exported a final ONNX model, then appeared as `not_running`.
- The actual PPO `max_steps` was 20,000, so ~118 seconds to reach budget was expected. `not_running` is insufficient to distinguish completed, cancelled, failed, and unexpected termination.
- Existing app has separate Overview, Drills, Train, Runs, Evaluation, Policies, Watch; Runs offers selected-job inspector + manual 120-line log fetch; evaluation status and viewer launch receipts require manual checks; Unity Watch opens a separate Mac process and is not a browser-embedded video stream.

## Target user flows
1. Select a run from Runs -> dedicated run detail page with stable deep link.
2. While running, see stage, budget, elapsed time, effective throughput, latest reward and drill-specific measured progress; timeline of checkpoints/events; continuously tailed logs.
3. Launch/inspect separate read-only Unity Watch on Mac without replacing or terminating PPO; optional status of viewer session inside detail.
4. After completion, see final reason, exported artifacts/checkpoints, evaluation entry point, and evaluation history for its indexed policy.
5. Select an evaluation -> dedicated evaluation detail page with episode progress and measured metrics streaming as they complete, final summary after completion.

## IA and desktop layout
- Keep top-level tabs: Overview, Drills, Train, Runs, Evaluation, Policies, Watch.
- Runs remains the searchable/indexed list; clicking a run opens `/apps/football/runs/:runId` (route subject to current Atlas app router convention), with breadcrumb to Runs. Running + recent remain distinct from archive.
- Run control room:
  - header: drill/stage + readable run label, status, started/ended, seed, arena count, config hash, training target, Watch on Mac, Stop if running;
  - metric ribbon: steps/target and ETA **only when based on actual recent throughput**, elapsed, steps/sec, latest mean reward, stage-specific primary metric when actually measured;
  - left: step-indexed reward/performance charts, configurable windows, checkpoints & structured event timeline;
  - right: stage objectives, configuration, artifacts/policy and associated evaluations, viewer connection status;
  - bottom (resizable): log stream with follow/pause, level filter, search, time/step annotations, copy/download; scrollback preserved on navigation.
- Evaluation detail reuses same header/metrics/timeline/log architecture with episode progress, success/contact counts, reward, stage-specific metrics, completed seed, checkpoint/policy comparison. Clear distinction between preliminary values and final evaluation results.

## P0 — correct run lifecycle and budgets (driver/Node -> server -> web)
- Driver records terminal state and exit reason durably: `completed` (step target reached and final export), `stopped` (requested graceful interruption), `failed` (error/exit nonzero), `interrupted`/ `unknown` (unreconciled process or stale state); not merely `not_running`. Preserve raw data when migration needed.
- Job details expose `maxSteps`, `currentSteps`, `duration`, `endedAt`, `exitCode` where known, checkpoint path(s), final artifact, metrics timestamp, preset, curriculum stage, config hash. Do not infer success just because ONNX file exists if error remains.
- Expose a bounded allow-listed budget/preset for launch (e.g. quick verification ~20k vs real training ~200k-1M, exact presets configured in driver), persist resolved settings for reproducibility; no arbitrary command/paths.
- Ensure Watch child process/session lifecycle independent of PPO; integration test closing viewer while headless trainer continues.
- Avoid writing misleading zeroes for fields not yet available.

## P1 — structured metrics + run streaming
- Extend `football_driver.py` to produce append-only, persisted structured events/metrics while running. Prefer explicit JSONL event emission or an authoritative metrics store to brittle parsing of ML-Agents human logs; optionally derive PPO scalars from TensorBoard data when justified.
- Suggested envelope: `{ runId, seq, occurredAt, kind, step?, payload }`, kinds `run.started`, `run.progress`, `run.metric`, `checkpoint.saved`, `run.finished`, `log.line`, `viewer.started`, `viewer.stopped`.
- Drill-specific measured metrics: for approach use true physical contact count/success rate, optionally average time/distance to contact; retain generic mean reward/episode length and PPO values if available. Distinguish rollout/training estimate from seeded evaluation.
- New bounded Node capability operations `run_detail`, `run_events` (`sinceSeq`, `limit`) and `evaluation_detail`/`evaluation_events`. Resolve only allow-listed IDs under bound workspace; never accept absolute paths, shell commands or arbitrary cursor contents.
- Server authenticates owner/workspace through existing NodeRouter, offers snapshot endpoint plus a streaming transport. Recommend per-active-run **SSE** from server to web with one shared upstream poll (2-5s) of Mac Node; existing Node websocket remains request/response. Cursor/Last-Event-ID for reconnect, ordered events, bounded buffers, dedupe, heartbeat, node-offline reporting; fallback polling.
- Prefer one active subscription per run; idle/hidden-page throttling and no unrestricted log forwarding. Store progress in durable local run files so page reload and reconnect recover state.

## P2 — run detail React UI
- Refactor monolithic `apps/web/src/FootballTraining.tsx`: `RunList`, `RunDetail`, `RunMetricStrip`, `MetricChart`, `RunEventTimeline`, `LogTail`, `ViewerControls`.
- Separate summary refresh from streaming subscriptions; chart downsampling and append-only time series; preserve scroll and filters; data freshness + connection state. Avoid fake percentages and invented ETA.
- Actions remain explicit/confirmed for stop, index, evaluate. Viewer launch is read-only with independent state.
- Deep linking and responsive single-column fallback; retain current graphite/indigo system; minimal dashboard chrome, not an overdesigned trading screen.

## P3 — evaluation detail and comparisons
- Evaluation runner emits bounded progress after episode or batch: completed/target episodes, wins/success/contact counts, mean reward, distances and metric-specific summaries; only mark final on exit and result persisted.
- SSE/polling detail route + shared timeline/chart/log widgets. Completed view includes stage success rate, numerator/denominator, variability or confidence interval as appropriate, artifact/policy revision, seed, link back to source training run.
- Later add seeded side-by-side checkpoints, baselines, stage advancement gating against reproducible evaluation threshold, never auto-promote solely on mean reward.

## P4 — optional visual streaming (separate decision)
- First deliver browser telemetry + local native `Watch on Mac`; current Unity viewer does not provide browser video. Browser-embedded video would need explicit capture/encode/transport, controls, bandwidth and security design. Do not imply that run telemetry alone is a video stream.
- Retain per-arena selector/camera controls for a possible viewer follow-up; ensure any capture is opt-in and read-only.

## Testing and acceptance criteria
- Normal 20k-step completion visibly says `Completed — step budget reached`; cancellation/failure clearly different; logs and checkpoints retained.
- Closing Unity Watch does not stop PPO or change run state, tested with two arenas.
- Live metric/log output appears without Refresh; reconnect resumes from cursor without duplication, order loss, or silent truncation.
- Step target and elapsed/throughput shown; stage-1 contact-success remains absent until actual physics measurements are available.
- When Mac disconnects, dashboard says `connection lost / last updated` rather than inventing current metrics or terminal state; returns on reconnect.
- Performance remains bounded for long (1M+ step) runs; logs tail capped, persisted history accessible, frontend chart sampling controlled.
- Evaluation partial counters and final results agree; no claim of success before final output.
- Tests for Node operation schemas, auth scoping, lifecycle mapping, cursor handling, frontend SSE fallback, route navigation, stop/index/evaluate/watch actions.

## Delivery order
1. Fix terminal-state semantics and preset training budgets.
2. Driver structured events and Node bounded cursored reads; server SSE with polling fallback.
3. Dedicated Runs control room route and shared chart/log components.
4. Evaluation control room + result/curriculum comparisons.
5. Only later, consider actual embedded Unity video streaming.
