# Benchmark PR reporting for Atlas

This repository uses **Benchmark v0.1.0**, pinned to reviewed commit
`bff973c94597897c095f76e0538ec145d7ecdc45`. The two trusted GitHub
Actions workflows run only after `Atlas CI` starts/finishes. PR code is
executed only in the read-only CI job; the reporter/lifecycle own the
write-capable PR comment permissions.

## CI producer

`npm test` remains unchanged. Only GitHub CI uses
`npm run test:benchmark`, which executes **the same build, server/node
integration tests, Vitest web tests, and native UI check once each**.
Its reporters emit:

- `benchmark-junit` containing root `junit.xml`: aggregated Node-native
  JUnit + Vitest JUnit, with no re-execution of test suites
- `benchmark-lcov` containing root `lcov.info`: Node V8 coverage restricted
  to exercised `apps/*/{src,dist}` and `packages/*/{src,dist}` modules
  **within the actual Atlas checkout root** (never nested dependency or fixture paths)

**Coverage is Node-side exercised-module coverage, not whole-monorepo
coverage.** It does not include files never loaded by the Node tests,
Vitest/browser component coverage, nor Docker/native build coverage.
Do not present it as total Atlas codebase coverage or treat a high percentage
as proof that all apps and packages are covered.

Artifacts are uploaded with `if: always()`, including after a test failure
if report files were produced. The existing `images` job continues to
depend on `test` and only pushes Docker images from `main`. The
separate `Atlas Deploy` workflow is not modified.

## Trust and activation

- `.github/workflows/benchmark-lifecycle.yml` handles trusted CI-start
  lifecycle events. A completed CI run may skip the visible Waiting stage.
- `.github/workflows/benchmark-report.yml` consumes `benchmark-junit` and
  `benchmark-lcov` by exact ID after CI finishes. Only a successful
  `main` CI run on the PR's **exact base SHA** is a valid coverage baseline.
- Both workflow files must be merged into the **default branch** before
  GitHub will activate them. Thus the *integration PR itself* cannot validate
  the new trusted comment workflows. First verify that merge-to-main CI
  uploads both new artifacts; then open a fresh PR based on that merge
  to exercise Waiting → Processing → Ready and exact-base comparison.
- Fork-originated PR identity and permissions are designed to fail closed,
  but have not been proven by a live Atlas fork PR.

## Live acceptance of the released integration

To verify a new Benchmark installation without disturbing application code:

1. Confirm that **Atlas CI on the installation's merge commit** succeeded on `main` and uploaded distinct `benchmark-junit` and `benchmark-lcov` artifacts.
2. Create a **fresh pull request based on that exact merge commit**. An already-running CI job that started before installation may not emit these artifacts, even if the newly installed lifecycle creates a Waiting comment.
3. Check that Benchmark creates or reuses **one** bot-owned PR comment with the exact current head SHA and CI run attempt, then updates it to Ready after the PR's CI finishes. Faster CI may skip an intermediate Waiting or Processing state.
4. Confirm that the trusted reporter downloads the current JUnit and LCOV artifacts by **different, verified artifact IDs**, and that the coverage baseline comes from the successful `main` push CI for the PR's **exact base SHA**. If that baseline is absent, Benchmark must show it as unavailable rather than inventing a percentage-point comparison.
5. Confirm test counts and Node-scoped line/function/branch coverage in the comment; compare the source scope across the current PR and baseline. A passing build with a missing/malformed reporter artifact is **not** full acceptance.
6. Confirm CI and Docker build behavior stayed unchanged: PR jobs remain read-only, image publishing remains main-only, and `.github/workflows/deploy.yml` was not modified.

Record the exact CI, reporter and lifecycle run links, artifact IDs, final comment ID, and unresolved limitations in the validation PR description. A real fork-originated PR remains a separate optional acceptance exercise; a same-repository PR does not prove it.

## Rollback and installer direction

To roll back, revert the two Benchmark workflow files and CI reporting
adapter changes in a reviewed PR. Leave the existing `npm test`,
read-only CI identity and `Atlas Deploy` configuration intact.

A future few-click Benchmark installation should detect existing CI
workflows, identify JUnit/LCOV producers, generate a preview diff in a
setup pull request, and pin the released trusted workflows automatically.
Different monorepos may require adapter logic; installing a GitHub App
must never silently grant write privileges to untrusted PR workflows.
