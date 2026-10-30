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

### Authenticated structured reviewer submission

The `code_reviews_submit_structured` operation requires a **verified MCP OAuth
session**. Atlas derives the permitted Auth0 subject and issuer from its
configured and successfully verified OAuth token. This identity is passed
through trusted transport/dispatch context, **not** request JSON, `client`,
`x-atlas-client`, or arbitrary HTTP headers. Direct HTTP
`/api/tools/code_reviews_submit_structured`, unauthenticated/local MCP,
and internal calls lacking this context are denied. Read-only Code Reviews
operations and historical import permissions are unchanged.

The run's `coverage.authenticatedCaller` records
`{ kind: "mcp-oauth", subject, issuer }`. Receipts can only be retrieved by
the same authenticated subject/issuer, including an idempotent retry after a
PR-head change. Previously created structured records without verified actor
metadata cannot be replayed through the new gate; they remain readable through
ordinary store history.

Atlas currently authorizes one configured Auth0 subject for MCP. This is
**account-level provenance only**, not proof of the particular AI client,
model, Code Reviewer skill invocation, or independence from the PR author.
GitHub publication is still disabled. A future reviewer-scoped credential and
publisher policy must be evaluated before claiming independent authorship.

### Structured native review submission

The `code_reviews_submit_structured` Application operation creates one
**append-only-through-this-operation, server-timestamped review run** and zero to thirty **structured
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
      "lineageKey": "root-cause-input-validation",
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
it for retries, and supply unique finding keys within that review. An optional
`lineageKey` (same bounded character format as `key`) identifies a **reviewer-asserted
root cause across rounds of the same repository and PR**. When a re-review
verifies that an observation concerns the same underlying issue, reuse its
`lineageKey` even if the submission-local `key`, changed line or commit
differs. Each explicit lineage key may occur only once within a review run.
Do **not** invent a lineage key for uncertain matches; omission keeps the
observation unlinked. A repeated key is an identity assertion, **not** proof
that a finding persists or has been resolved. Cross-PR matches are never inferred.

Atlas stores the optional key in the existing Review Findings
`evidence.lineageKey` object without changing Store schemas or the immutable
`findingKey: structured:<submissionId>:<key>` observation identity.
Existing/historical imports have no asserted lineage keys; source GitHub
comment IDs and similar descriptions must not be auto-matched. Without an explicit lifecycle
assessment, the finding remains `new`; see the reviewer-asserted
lifecycle protocol below.

Accepted verdicts are `changes_requested`, `concerns_to_verify`, `non_blocking`,
`no_findings` and `inconclusive`. A `no_findings` verdict cannot include
findings. The server validates all fields strictly, bounds text and findings,
and produces finding counts itself.

Atlas obtains a repository-scoped `pull_requests:read` GitHub App token and
verifies the PR is open and the submitted SHA matches GitHub's current head
**before starting the write transaction**. There remains an unavoidable short
race between remote verification and committing locally; the recorded
`githubHeadVerifiedAt` timestamps the completed GitHub read, not a guarantee the
head never changed afterward. The server issues the review timestamp instead
of trusting caller-supplied dates.

The response returns `findingIds` **in the original submitted finding-key order**
and `findingReceipts: [{ key, id }]` explicitly mapping each client key to
its persisted record ID. The initial response and identical retries preserve
this mapping even when PostgreSQL reorders equal-timestamp rows by UUID.

The ID and a payload SHA-256 fingerprint are stored as receipt metadata.
The submission operation has no update/delete pathway, but Atlas's generic
Store administration APIs can still edit or archive records; strict
immutability across *all* administrator operations is not yet guaranteed. A
retry with the **same ID and identical normalized payload** returns the
original run/finding IDs without another GitHub fetch, even if the PR has
advanced. If an identical concurrent retry observes a changed or closed GitHub
head, the server rechecks for a committed matching receipt under the database
transaction lock; a new or altered submission still fails head validation. Reusing that ID for different content fails with a conflict.
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

### Explicit review-round lifecycle assessments

A structured review may now include **reviewer-supplied lifecycle assertions**
for a previously observed root cause, without editing the older Review Runs or
Review Findings. This is **not automatic resolution detection**, and Atlas does
not independently execute or verify the claimed tests/fix. All assertions
are attributed only to the authenticated MCP OAuth account and the particular
GitHub PR head verified at submission.

For a finding still observable at the new head, include an explicit
`lineageKey` and, optionally, an `assessment`:

```json
{
  "key": "still-reproducible",
  "lineageKey": "root-cause-input-validation",
  "severity": "sev3",
  "title": "Input validation still fails",
  "description": "Malformed values still reach the handler.",
  "assessment": {
    "state": "persisting",
    "evidence": "Reproduced with the named input-validation regression case at this commit."
  }
}
```

Allowed observed assessments are `persisting` and `unverified`. The
`evidence` must be a non-blank string between 20 and 4,000 characters.
Without an assessment, an observation remains `new` and matching
`lineageKey` values do **not** automatically mark it persisting.

To explicitly assert a fix without submitting a new finding observation,
include a `resolutions` array on the same authenticated structured review:

```json
{
  "resolutions": [{
    "lineageKey": "root-cause-input-validation",
    "evidence": "Verified the fix at this reviewed head with a focused regression test."
  }]
}
```

A resolution is a **new immutable-through-the-review-operation assertion**
stored on the new Review Run as `coverage.lifecycleResolutions`, not a
destructive update to the prior finding. A `no_findings` review may include
these assertions while its `findings` list remains empty. Every assertion
must reference an **existing active, complete structured finding with the
same lineage key in the exact same repository and PR**, checked inside the
write transaction. The check considers only **complete source runs that
actually supply a referenced root**. An unrelated older run with archived or
damaged findings does not invalidate a lifecycle assertion backed by another
complete run. An archived or otherwise incomplete **matching** run alone is
never sufficient proof of identity. Untrusted historical Markdown, other PRs,
same-round findings or invented keys cannot justify transitions.
Each root cause may appear once per outcome collection and cannot be both
observed and resolved in the same review. No implicit actions occur for
unmentioned keys. Retries remain idempotent under the original submission UUID
and fingerprint.

Every persisted assessment records its supplied evidence, the verified
reviewed SHA and the server timestamp. This is an **account-attributed reviewer
claim**, not independent proof that the code is fixed, and it does not close
or resolve GitHub threads, publish a review, modify PR permissions, or
automatically reclassify the previous observation. The existing
`code_reviews_publish_github` single-review COMMENT publisher explicitly
**rejects** structured runs containing these new lifecycle assertions,
including preview: it cannot render resolution evidence or safely reply
inside existing GitHub inline threads. Wait for the separately reviewed
managed-summary/thread publisher; do not double-publish through the old
plugin or Atlas's legacy publisher.

The PR timeline now returns explicit `round.resolutions`, optional
`finding.lifecycleAssessment` and page-scoped lineage
`assessments`/`latestAssessmentInPage`. The web PR-status expansion shows
these assertions and their evidence. Historical reviews remain partial, and
the newest assertion **in the loaded Atlas page** is not necessarily the
globally latest GitHub status. No lifecycle outcome is inferred from a missing
finding, changed commit or manually resolved GitHub conversation. Generic
Store admin APIs can still mutate historical data, so these records are not
a cryptographically immutable audit ledger.

### Native GitHub publication (explicit opt-in)

The `code_reviews_publish_github` Application operation can publish an
existing **authenticated structured** Atlas review as a GitHub **COMMENT**
review. It never requests approval, `REQUEST_CHANGES`, merges, or posts from
historical Markdown imports.

Publication is **disabled by default**. After deploying and independently
reviewing the publisher, explicitly add permitted repositories to the Atlas
Server's `ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES` (comma-separated full
`owner/repo` names) and recreate the production server container. The
GitHub App must grant `pull_requests:write` for those repositories; Atlas
requests an installation token scoped to just that repository and permission.
Do **not** configure publication on a Node or expose the App key to a client.

1. Preview: `code_reviews_publish_github({runId:"<Review Runs UUID>"})`. The
   authenticated MCP user must match the original submission account.
   Preview verifies the current open PR head and shows the exact COMMENT
   body, without mutating GitHub or Atlas.
2. Apply deliberately: same `runId` plus `apply:true`. The server checks
   current GitHub head, reviews, and optionally the diff, then durably
   records an exclusive `claimed` publication intent in the Atlas run
   **before** the one GitHub POST. It finally records `published` and
   the verified GitHub review URL/ID on success.
3. Optional inline comments: `includeInline:true` during both preview and
   apply requires **all** 1–20 findings to contain a path and line
   corresponding to an **added RIGHT-side line** in GitHub's current,
   complete (fewer than 100 files) PR diff. Missing/truncated patches,
   invalid or duplicate positions and old-side-only lines fail closed.
   The default is a safer summary-only GitHub COMMENT review.

Once claimed, Atlas **never automatically issues another POST**. If the
network times out, GitHub returns ambiguous data, the process crashes,
or database confirmation fails, retrying this operation performs **remote
reconciliation only**. A marker by itself is **not** trusted: Atlas
authenticates the actual GitHub App bot's numeric user ID using the GitHub
App JWT, requires an exact body match, verifies that the review was a
`COMMENT` on the reviewed commit, and checks the full set of expected
inline comments (including author, text and RIGHT-side position).
The expected inline comments are preserved in the durable claim before
posting, including the exact added RIGHT-side diff position calculated
from GitHub's current complete patch. Reconciliation first uses populated
current line/side fields, then stable original-line/original-commit anchors
for outdated threads. GitHub's batch-review API can return null
`line`, `original_line` and `side`; in that case Atlas requires the
previously verified diff position and exact original commit SHA.
Neither a null position alone nor matching comment text alone can attest
the source anchor. This also permits recovery after later commits make
current lines outdated, without relying on a changed PR diff.
Even an unrelated review with a copied marker or a very long body must
not cause false publication. If the expected review is found, `apply:true`
records its verified ID without reposting. If not found, the claim remains
`uncertain` and **manual investigation is required**: Atlas will not
interpret absence in a bounded review list as proof that a POST did not
succeed. Review pagination beyond 500 items is refused. A normal POST
response is also reverified before recording a `published` receipt.

A published review is durable publication metadata in `coverage.githubPublication`
inside the Atlas Review Runs Store, not proof of independent reviewer
authorship. The existing MCP OAuth subject identifies the authorized
account; no proof of independent skill invocation is claimed. General
Atlas Store administrators can still mutate records, and GitHub may advance
a head immediately after verification. Publication does not update the
`Review Findings` lifecycle automatically.

### Review-history details in the Atlas web UI

Each saved Review Run can be expanded to read its linked findings through
`code_reviews_list_findings` on demand. A review row shows the reviewed
repository, PR, commit, verdict, review time, provenance and recorded severity
counts where available. The details display the finding severity, title,
description, location and recorded state; historical `unverified` observations
are explicitly labelled as such. Native publication receipts may link to
their GitHub review using a validated numeric review ID.

The interface makes no inference that an empty finding Store proves a clean PR.
It does not automatically update finding lifecycle after new commits, and it
never infers publication from a stored summary. Review-run and finding pages
are independently bounded to avoid fetching unrelated findings for collapsed
rows. Missing Project/Store data, unsupported records and API failures have
distinct error or empty states.

### PR-level latest review status (read-only)

`code_reviews_pr_summary({repository,prNumber})` reads a **single exact
repository/PR identity** from the Code Reviews Project's Review Runs Store
using a server-filtered, descending `reviewedAt` query (one row plus total
count). The stored total is **review rounds recorded in Atlas**, not unique
commits or complete GitHub review history. Queries are exact against stored
repository names; use the recorded repository spelling for historical records.

The response includes `recordedRounds`, `latest` (run ID, recorded head SHA,
timestamp, verdict, source and *recorded* severity counts when valid),
`currentHead` and `latestReviewHead`. Current GitHub head is read on demand
using the existing repository-scoped GitHub App read token. The result
distinguishes `open`, `closed` and `unavailable`; available heads have an
observed `checkedAt` timestamp. Freshness is `current`, `outdated`,
`unknown`, or `no_stored_review`. None implies a passing review:
`no_stored_review` means **no matching rows in Atlas**, not that GitHub has
never been reviewed; `unknown` means the GitHub head was not verified.

Historical Markdown imports represent **partial finding coverage** even when
their stored verdict is `no_findings`. A missing or invalid recorded
`counts` object is returned as `severityCounts: null`, never as invented
zero findings. Invalid latest record fields cause an explicit error rather
than masking stored data problems. Unavailable GitHub responses do not
silently make an old review appear current.

The web Review history offers an **on-demand PR status** expansion beside
the existing finding drill-down; the GitHub check is not performed for
collapsed rows or every PR in a page. Manual Refresh revalidates the active
expanded panel. This operation is read-only and does not backfill, publish,
approve or resolve GitHub threads. The persistent PR bot summary, stable
finding lifecycle and dedicated publishing identity remain later milestones.

### Bounded PR timeline and explicit cross-round lineage (read-only)

`code_reviews_pr_timeline({repository,prNumber,limit?,offset?})` reads the exact
repository and PR from **Atlas's saved records only**. The default page has
five rounds, maximum ten; rounds are sorted newest first and can be paginated
with an offset. Each round queries at most 100 linked finding observations.
The response includes `recordedRounds`, `rounds`, `hasMore`,
`storedWindowComplete`, `unlinkedObservations` and `lineages`.
`storedWindowComplete` means the selected page covers all **saved** rounds
and their first 100 findings, **not** that GitHub review history is complete.
More than 100 findings in a saved round is visibly labelled truncated.

Each returned review round has its reviewed SHA, timestamp, verdict, source
(`structured`, `historical` or `unknown`), finding completeness
(`structured`, `historical_partial`, `unknown`), and saved finding
observations. The result rejects invalid/mismatched Store records instead of
silently hiding them. For structured submissions, the reader also requires
a well-formed original `coverage.findingCount` (0–30) matching the total of
active saved findings. Generic Store administration can archive records;
a missing or changed count therefore fails closed rather than advertising
complete structured evidence. Historical imports do not carry this
structured-count guarantee: Markdown and missing inline comments remain
partial source evidence.

An observation enters a lineage **only** when a structured review explicitly
submitted a valid `lineageKey` and its stored evidence matches that review's
submission namespace. Key reuse across rounds means the reviewer asserted the
same root cause: `observed_multiple_times_in_page` is not independently
verified persistence. Unlinked or imported observations are **never**
joined by title, file, line, comment ID or apparent disappearance. Within a
page, duplicate asserted lineage keys in a single round cause an error rather
than miscounting. `lineages[].observationsInPage` and recurrence labels are
strictly scoped to that loaded page, including when additional older Atlas
rounds exist. Different repository/PR identities are never combined.

**No resolution is inferred** when an issue vanishes from a subsequent review,
when a PR moves to a new SHA, or when a GitHub discussion becomes outdated.
The response always carries `resolutionInferred:false`. The historical
`state` field on a finding is merely its saved observation label, not a
verified GitHub thread state or fresh fix confirmation. `no_findings` on a
historical import does not establish complete issue coverage.

The web application's existing **PR status** expansion now lazily retrieves
this timeline alongside GitHub head freshness. Round details expand in place
and older round pages can be navigated with Previous/Next; Refresh rechecks
both active read operations. Collapsed rows perform neither PR-scoped read.
No implicit background job, GitHub publication, Store mutation, lifecycle
transition, historical import or permission change is involved.

Explicit, evidence-backed lifecycle transitions, globally scoped finding
queries and managed GitHub bot/thread publication remain later work.

### MCP discovery for bounded tool catalogues

The Server's Application registry includes the Code Reviews tools, but some
ChatGPT connector clients surface only an initial portion of a large MCP tool
list. Atlas registers Code Reviews' ten operations near the beginning
of that list, after the existing priority football generalist tools. This does
**not** introduce an alternate API, relax authenticated MCP OAuth requirements,
enable native GitHub publication, or imply that this ChatGPT connection already
has a refreshed tool catalogue. The normal Application dispatch path remains
authoritative.

For integration acceptance after an independently reviewed deployment:

1. Refresh/reconnect the Atlas MCP connection and inspect the **actual exposed**
   `code_reviews_overview`, `code_reviews_list_runs`,
   `code_reviews_list_findings` and `code_reviews_submit_structured` tools.
   The three read operations are safe for baseline checks; a submit operation
   must still require verified OAuth and an explicit request to persist a review.
2. Verify that the Code Reviews Project and both Stores exist. An empty Store
   is a legitimate baseline, not evidence the latest PR has been reviewed.
3. Make one authorised structured submission for the **exact current open PR
   SHA**, retain the receipt and repeat it idempotently; confirm linked run and
   findings in the Application. Do not call `code_reviews_publish_github`
   for a review that the existing Code Reviewer already published.
4. Distinguish a missing tool after deployment from an operation returning
   an application-level error. A code merge alone does not refresh the
   connected connector or deploy/restart the Server.

The change prioritises operations in the MCP registration order only.
Connector-specific catalogue limits and refresh behaviour must be verified
against a real connected client; successful local discovery tests alone do
not prove production exposure.

### Code Reviewer plugin integration

The separate private `Code Reviewer` plugin (from version `1.0.6`) has an
optional Atlas integration workflow. When an authenticated Atlas MCP session
actually exposes `code_reviews_submit_structured`, the skill can store a
structured observation after its ordinary independent GitHub review.
It must not call `code_reviews_publish_github` for the **same** review, since
that would publish it twice. A review-only request remains read-only unless
the user explicitly asks to store a receipt.

Installing the plugin update does **not** automatically deploy the Code
Reviews Application or reconfigure the connected Atlas MCP tool list.
The application must exist in the target Atlas environment, and the
authenticated structured operation must be available to the client.
Account-level OAuth attribution does not prove the AI review was independently
performed.

## Planned follow-ups

1. Repository-level source completeness summaries, optional GitHub webhook reconciliation and guided operator backfill UI.
2. Independent reviewer provenance and authorization hardening for native structured submissions.
3. Dedicated GitHub App publisher with inline findings, GitHub review submissions, and
   per-commit check runs; secure token scoping and explicit approval semantics.
4. App review timelines, PR-level latest-state summaries, metrics, and Chatflow integration.

Review rounds, distinct reviewed commit SHAs, and unique finding identities are separate
metrics. An empty Store does not imply any repository is free of issues.
