# Football Training V2 — implementation log
Date: 2026-10-16. Owner: FYP Football Training application.

## Intent
Make Atlas useful for understanding **what trained football agents can actually do**, not just discovering training artifacts. Keep training, evaluation, presentation and frozen model artifacts separate. No automatic policy promotion.

## Built locally (not yet deployed)
1. **Activity UX** — Home active training and evaluation section, link through to run/evaluation detail, training-run status filters, evaluation history filter/search with policy-first display; completion states are taken from recorded receipts, not inferred from elapsed wall time.
2. **Drill taxonomy + selector** — skill groupings Contact, Dribbling, Interception/Receiving, Shooting/Kicking, Passing, Defending, Teamplay; classification independent of roadmap. Grouped drill catalogue and shared drill picker in Train/Watch/Evaluate. Scenario IDs, objectives and physics unchanged. 'Benchmark candidate' does not mean certified; Watch-only showcase is a demo.
3. **Policy lifecycle** — explicit curated Featured vs candidate vs incompatible/history sections. Musiala explicitly featured in `validation/generalist/policy-curation.json`. Node action `generalist_policy_update` updates display name/featured only in separate presentation metadata (atomic write), never renaming source immutable policy bundles or IDs.
4. **Assessment evidence** — Node action `generalist_assessments` derives four dribbling metrics from saved evaluation episodes, grouping verified alias+original IDs by identical model SHA-256, deduplicating receipts; excludes Watch, training rewards, baseline and unmeasured partial runs. Policy profile bars show numerator/denominator, seed count and provisional status. No FIFA-like aggregate rating.
5. **Policy navigation and naming** — evaluation headings use selected policy display name; navigate original/alias history to the featured player when same model. Individual skill quick-evaluation buttons.

## Dribbling Assessment v1 specification
See `validation/generalist/dribbling-assessment-v1.json` in Unity workspace. Four 100-episode candidates: stationary 3m, sharp turns, near reversals, qualified moving-ball interception. Historical evaluations from reused seeds are **provisional regardless of success rate**. Certification requires future unseen seeds, frozen scenario and environment fingerprints, explicit policy-model checksum and complete measured episodes. We have NOT run or certified a new suite.

## Deferred / next phases
- Orchestrated **suite runner** with a durable sequential task/queue, fresh seed allocation and one assessment-result receipt (avoid running many simultaneous Unity jobs or inferring certification from pre-existing results).
- Policy comparisons on exact matching suite versions, bootstrap/wilson uncertainty bounds, skill progress across successive models.
- Backfill older training/evaluation associations not expressed in newer receipt formats, while never fabricating missing data.
- Visual and interaction testing in the deployed app, especially active job display, searchable picker, rename + feature roundtrip, and hosted Mac Node routing.
- Deployment: built locally in already-dirty main workspace; Server/Web require release, Node agent must restart. No commit, deployment or production migration has been attempted.

## Validation
- `npm run build` succeeded (protocol, view-runtime, server, node, web).
- `npm test` could not complete: local PostgreSQL at 127.0.0.1:5432 refuses connections; web Vitest stage is after backend suite, so NOT claimed as passed.
- Added Node unit tests for curation and model-checksum aggregation; added web tests for taxonomy/skill profiles. These require execution in a working test setup.
- Original Unity policy weights, physics, PPO scripts, stored evaluations and manifest have not been changed during this UI/backend work (besides creation of presentation curation/proposed assessment metadata).

## Acceptance checks after deployment
- Musiala named and featured; other compatible saved policies remain candidates and old incompatible policies are archived.
- Live jobs appear in Home and their respective lists; no stale completed job marked active.
- Evaluate → drill picker grouped by skill; Watch-only demo excluded from Train and Evaluate.
- Alias+original run evaluations produce **same model** provisional skill evidence, deduplicated by ticket.
- Naming/featuring survives Node restart, and does not alter ONNX/bundle provenance hashes.

## Validation update — 2026-10-16
- Confirmed the existing in-progress V2 changes in Atlas workspace rather than overwriting them. Fixed a broken test-file regular-expression literal at `apps/web/src/FootballGeneralistExperience.test.tsx:265` that prevented TypeScript compilation.
- Re-ran full `npm run build`: **passed**, including protocol, views, server, Node and web/Vite.
- Re-ran monorepo `npm test`: still **blocked** because local PostgreSQL `127.0.0.1:5432` returns `ECONNREFUSED` during integration database setup. This failure does not certify or disprove the new Node/web tests. No production deployment, database migration or policy promotion performed.
- Next: bring test PostgreSQL online, run the complete Node/web suites and test curation rename/feature, alias evidence aggregation, incomplete evaluation exclusion, live refresh and the grouped drill picker; then review staging UI prior to deployment.
