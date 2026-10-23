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

## Rollback and installer direction

To roll back, revert the two Benchmark workflow files and CI reporting
adapter changes in a reviewed PR. Leave the existing `npm test`,
read-only CI identity and `Atlas Deploy` configuration intact.

A future few-click Benchmark installation should detect existing CI
workflows, identify JUnit/LCOV producers, generate a preview diff in a
setup pull request, and pin the released trusted workflows automatically.
Different monorepos may require adapter logic; installing a GitHub App
must never silently grant write privileges to untrusted PR workflows.
