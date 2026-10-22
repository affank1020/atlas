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
in `infra/production.env` and restart/recreate the Atlas Server container using
the production Compose stack. This setting is passed only to the Server.
Do not set it on Atlas Nodes or in the web bundle. It is a JSON object mapping the **exact GitHub repository**
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

### Bounded repository backfill

The `code_reviews_discover_pull_requests` operation lists **50 GitHub pull
requests per page** (newest created first), including open and closed PRs.
Call `{ "repository": "affank1020/atlas", "page": 1 }`, then inspect the
returned PR numbers and `nextPage`. GitHub pages can shift when PRs are
created, so this list is for discovery **only**; it does not imply all PRs were
checked or all history was imported. A full page indicates only a *possible*
next page; discovery stops at page 100 (up to 5,000 PRs), returning
`truncatedAtLimit: true` when that final page is full. Discovery requires an Atlas GitHub App installation, but does not
write records or require trusted-publisher configuration.

Select **1–8 explicit, distinct PR numbers** for each backfill batch. Nothing
automatically selects a moving discovery page for import:

1. Preview using `code_reviews_backfill_pull_requests` with
   `{ "repository": "affank1020/atlas", "prNumbers": [69, 79] }`.
   `apply` defaults to `false`. The response has per-PR provenance/skip
   counts, total new/existing runs and findings, and no stored changes.
2. After inspecting the preview, repeat the **same PR numbers** with
   `"apply": true`. All requested GitHub review/comment snapshots are
   fetched and validated before a **single PostgreSQL transaction**.
   No partial writes occur if a later fetch fails or an existing record
   conflicts. A repeat is idempotent.
3. Continue deliberately with another set of explicit PR numbers. There is
   **no automatic background job, webhook listener, or unattended sweep**.

Both preview and apply require the previously configured repository-specific
`ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON` publisher allowlist. Every PR
uses the original Code Reviewer heading/actor checks, retains original GitHub
evidence, and marks recovered findings as `unverified`. Preview simulates
in-memory writes against a disposable catalogue snapshot to detect duplicate
source IDs *within* the requested batch; it does not persist them.
Concurrency with other imports between preview and apply may change counts,
so the apply transaction revalidates everything.

Batch operations fail as a whole on GitHub errors, oversized per-PR
pagination, malformed source data or Store conflicts. The maximum of eight
PRs per call bounds synchronous GitHub requests and database work, not the
overall repository's history. A PR with zero matching Code Reviewer reviews
is reported as zero new runs, **not** as evidence it was never reviewed.

### Structured native review submission

The `code_reviews_submit_structured` Application operation creates one
**immutable, server-timestamped review run** and zero to thirty **structured
findings** directly in the existing Code Reviews PostgreSQL Stores. It does
not parse Markdown, publish a GitHub review, create a Check, or approve a PR.

Call with a single `submission` object, for example:

```json
{
  "submission": {
    "submissionId": "3c7435fa-956e-4ba1-b759-e9805570a33c",
    "repository": "affank1020/atlas",
    "prNumber": 84,
    "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "verdict": "non_blocking",
    "summary": "One actionable issue; no confirmed merge blockers.",
    "findings": [{
      "key": "validate-input",
      "severity": "sev3",
      "title": "Validate incoming review input",
      "description": "A malformed input reaches the handler unchecked.",
      "filePath": "apps/server/src/apps/code-reviews.ts",
      "line": 42
    }]
  }
}
```

The example SHA is illustrative: **use the exact 40-character current GitHub
PR head SHA**. Each caller must generate a stable UUID submission ID, retain
it for retries, and supply unique finding keys within that review. Accepted
verdicts are `changes_requested`, `concerns_to_verify`, `non_blocking`,
`no_findings` and `inconclusive`. A `no_findings` verdict cannot include
findings. The server validates all fields strictly, bounds text and findings,
and produces finding counts itself.

Atlas obtains a repository-scoped `pull_requests:read` GitHub App token and
verifies the PR is open and the submitted SHA matches GitHub's current head
**before starting the write transaction**. There remains an unavoidable short
race between remote verification and committing locally; the recorded
`githubHeadVerifiedAt` describes a point-in-time check, not a guarantee the
head never changed afterward. The server issues the review timestamp instead
of trusting caller-supplied dates.

The ID and a payload SHA-256 fingerprint are stored as receipt metadata. A
retry with the **same ID and identical normalized payload** returns the
original run/finding IDs without another GitHub fetch, even if the PR has
advanced. Reusing that ID for different content fails with a conflict.
Concurrent submissions with the same ID serialize through the database.
Different submission IDs can represent independent review rounds, including
multiple reviews of the same commit. A failure to save any finding rolls back
the entire run and finding set.

Structured runs use server-assigned `reviewer: atlas-structured-review` and
`coverage.source: atlas_structured_submission`. They are **not** attributed to
a verified GitHub publishing account. A successful Atlas submission only means
the currently authenticated Atlas caller wrote a structured observation;
actual Code Reviewer session identity or reviewer/author independence cannot
yet be cryptographically established. Publisher identity verification and
GitHub review publication are a separate later milestone. Findings are saved
with state `new`; their lifecycle is not inferred from subsequent GitHub
commits. Existing historical imports stay unchanged.

## Planned follow-ups

1. Repository-level source completeness summaries, optional GitHub webhook reconciliation and guided operator backfill UI.
2. Independent reviewer provenance and authorization hardening for native structured submissions.
3. Dedicated GitHub App publisher with inline findings, GitHub review submissions, and
   per-commit check runs; secure token scoping and explicit approval semantics.
4. App review timelines, PR-level latest-state summaries, metrics, and Chatflow integration.

Review rounds, distinct reviewed commit SHAs, and unique finding identities are separate
metrics. An empty Store does not imply any repository is free of issues.
