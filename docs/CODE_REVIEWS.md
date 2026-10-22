# Code Reviews Application — Foundation

The Code Reviews Application belongs to an Atlas Project, not a standalone Application.
It is registered as `#/projects/008b191b-96c2-4a5f-92f6-1f13d6d790d5/applications/code-reviews`.

## Provisioned Atlas project

- Name: **Code Reviews**
- Project ID: `008b191b-96c2-4a5f-92f6-1f13d6d790d5`
- Storage: native Atlas Stores backed by PostgreSQL.
- Store: **Review Runs** (one observation per independently reviewed PR head).
- Store: **Review Findings** (one finding observation per reviewed run, linked by `reviewRunId`).

Atlas Project/Store provisioning is operational state and is **not** recreated by a schema migration.
Deployments against another database must provision the same Project and the two named Stores
before opening the Application. The read-only Application exposes an error rather than silently
returning zero metrics when the Stores are missing.

### Review Runs schema (v1)

`repository` string required (owner/repo), `prNumber` number required, `headSha` string
required, `reviewer` string required, `verdict` enum required
(`changes_requested`, `concerns_to_verify`, `non_blocking`, `no_findings`, `inconclusive`),
`reviewedAt` datetime required, `githubReviewId` string optional,
`githubReviewUrl` string optional, `coverage` object optional, `counts` object optional,
`schemaVersion` number required with default 1.

### Review Findings schema (v1)

`reviewRunId` string required (Atlas Review Runs record ID),
`findingKey` string required (stable across review rounds), `severity` enum required
(`sev1`, `sev2`, `sev3`, `sev4`), `title` string required,
`description` string required, `filePath` string optional, `line` number optional,
`state` enum required (`new`, `persisting`, `resolved`, `unverified`),
`evidence` object optional, `githubCommentId` string optional, `schemaVersion` number
required with default 1.

The two Store IDs are **not** hardcoded in the Application: it resolves them by name
inside the fixed Project scope. This allows identical schemas with environment-specific Store IDs.

## Current behaviour

The Application provides three read-only MCP operations:
- `code_reviews_overview` — total Review Runs and Finding observations.
- `code_reviews_list_runs` — bounded, sorted, paginated review history.
- `code_reviews_list_findings` — bounded findings for a validated Review Run ID.

It does **not** publish reviews, submit approvals, reconcile existing GitHub review threads,
run AI analysis, or claim historical completeness. Existing Code Reviewer GitHub publication
continues unchanged until there is an independently reviewed replacement.

## Planned follow-ups

1. GitHub history importer and idempotent reconciliation, including clear provenance for
   recovered data and unknown finding lifecycle states.
2. Validated and authorised structured review submission to Atlas, with immutable run
   receipts, idempotency, SHA freshness checks, and append-only history.
3. Dedicated GitHub App publisher with inline findings, GitHub review submissions, and
   per-commit check runs; secure token scoping and explicit approval semantics.
4. App review timelines, PR-level latest-state summaries, metrics, and Chatflow integration.

Review rounds, distinct reviewed commit SHAs, and unique finding identities are separate
metrics. An empty Store does not imply any repository is free of issues.
