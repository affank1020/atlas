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

### Manual GitHub history import

The new `code_reviews_import_pull_request` MCP operation imports **one PR at a time**.
It authenticates through the existing Atlas GitHub App using a repository-scoped
`pull_requests:read` token; the App must be installed on the repository.
No GitHub token is returned to the caller.

### Trusted publisher configuration

Before using preview **or** apply, configure `ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON`
on the Atlas Server. It is a JSON object mapping the **exact GitHub repository**
to one or more **immutable GitHub numeric user IDs** that actually publish the
Code Reviewer skill's reviews. For example, for the existing Atlas reviews
published through the GitHub account with numeric ID `58519561`:

```env
ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON='{"affank1020/atlas":[58519561]}'
```

Verify the ID through an authenticated GitHub user/review lookup before
approving the configuration. Add another repository explicitly when needed.
Repository keys are case-insensitive, but only full owner/repository mappings
are accepted. A missing, empty, or malformed trust map **fails closed**;
import requests for repositories without approved publishers fail before
fetching GitHub data, including dry runs. The user cannot supply a publisher
ID through the import MCP operation.

GitHub's review `user.id` must match an approved publisher ID for that
repository **and** the review must have the Code Reviewer heading.
Untrusted or deleted actors are excluded from saved runs and findings
and counted as `skippedUntrusted`. `coverage.sourceActorId` records the
verified identity used for classification. This is an account-level
provenance gate, **not proof** that each review was actually authored by
the Code Reviewer skill if its publishing account also submits other reviews.

1. Preview: `{ "repository": "affank1020/atlas", "prNumber": 69 }`.
   An omitted `apply` defaults to `false`. The response counts prospective
   review runs and inline findings without writing any records.
2. Apply: `{ "repository": "affank1020/atlas", "prNumber": 69, "apply": true }`.
   This persists review runs and explicit severity-labelled inline findings
   in **one Atlas transaction**. Repeating the call adds only missing source IDs.
3. Check `code_reviews_overview` and `code_reviews_list_runs` to view imported
   history. Inspect `coverage` for original review text and source metadata.

For historical markdown, only native GitHub reviews from a configured trusted
publisher **and** whose body begins with a **Code Reviewer** heading are recognized. Review heads, authors, timestamps and
GitHub source IDs are retained. Inline review comments with an explicit
Sev1–Sev4 label are imported as findings with **unverified** lifecycle state.
The finding key identifies the source GitHub comment; it does not imply two
comments describe the same root cause. Reviewer Markdown body findings without
a corresponding labelled inline comment are retained in the original review
text but **not** transformed into structured finding records. Accordingly
`findingObservations` is not the total number of historical findings, and
the resulting records are not proof of complete review history.

Pagination is bounded to five 100-item pages for each source. A fifth **full**
page (500 or more reviews/comments), or a malformed response, stops without
persisting a potentially partial import.
The importer never republishes reviews, submits approvals, or infers that a
historical issue has been resolved. Importing later comments for an already
seen review is supported; existing snapshots are append-only.

It does **not** publish reviews, submit approvals, run AI analysis,
automatically scan repositories, or claim historical completeness.
Existing Code Reviewer GitHub publication continues unchanged
until there is an independently reviewed replacement.

## Planned follow-ups

1. Repository-level batch backfill, source completeness summaries and optional GitHub webhook reconciliation.
2. Validated and authorised structured review submission to Atlas, with immutable run
   receipts, idempotency, SHA freshness checks, and append-only history.
3. Dedicated GitHub App publisher with inline findings, GitHub review submissions, and
   per-commit check runs; secure token scoping and explicit approval semantics.
4. App review timelines, PR-level latest-state summaries, metrics, and Chatflow integration.

Review rounds, distinct reviewed commit SHAs, and unique finding identities are separate
metrics. An empty Store does not imply any repository is free of issues.
