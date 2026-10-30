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
approve or resolve GitHub threads. The **write-enabled** persistent PR bot summary and dedicated publishing
identity remain later milestones; a read-only managed-summary preflight now
exposes the planned body and existing Bot-owned comment state.

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

### Managed GitHub PR summary — read-only safety preflight

`code_reviews_managed_summary_preview({repository,prNumber})` now produces a
**deterministic, non-publishing draft** of the proposed one-comment-per-PR GitHub
summary using only the *latest saved Atlas round* and its linked findings.
It is not yet the write-enabled managed summary publisher. No GitHub POST,
PATCH, claim, approval or thread resolution occurs, even if an owned comment
already exists. It rejects invalid owner/repository path segments (including
`.` and `..`) and canonicalizes valid repository names to lowercase
before querying Atlas or inspecting GitHub, matching native structured-submission
storage. New GitHub history imports also persist canonical lowercase names.
Older GitHub history imports may still contain mixed-case names: the managed
preview performs a **read-only, bounded, PR-number-scoped scan** (up to 1,000
candidate runs), compares the complete repository identity case-insensitively,
and sorts/selects the latest matching run from saved chronological order.
Other repositories with the same PR number are excluded from both preview
and recorded-round count. If the legacy scan exceeds its bound, changes count
during pagination or returns incomplete/duplicate pages, preview fails
closed instead of reporting a misleading empty or partial history.
This does **not** rewrite/migrate existing stored records, and other
exact-match Code Reviews timeline queries retain their current semantics.
The preview only materializes the selected saved round's linked findings,
preserving existing strict cardinality and lineage integrity checks; missing
history never establishes a clean review.

The preview distinguishes structured source coverage from partial historical
imports. Counts are **for the selected saved round**, not all unique root
causes or all GitHub review history. It includes latest reviewed SHA, verdict,
recorded round count, severity observations, explicit finding-state labels
and *reviewer-asserted* resolutions with limited supporting text. No lifecycle
outcome is inferred from disappeared observations or outdated comments. Body
length and untrusted Markdown/HTML marker handling are bounded:
inline title/evidence strings flatten line breaks and escape Markdown
metacharacters, while file paths and lineage keys use safely delimited
code spans (including embedded backticks). This prevents embedded headings,
GitHub alerts and false status banners from being rendered as trusted
summary structure.

The proposed summary uses a **PR-scoped marker**, distinct from the legacy
one-comment-per-review publisher:

```text
<!-- atlas-code-reviews-managed-summary:v1:owner/repo#123 -->
```

To inspect GitHub ownership, Atlas retrieves a repository-scoped GitHub App
**read** token and independently verifies the App Bot's immutable GitHub
user ID, not just the comment's claimed login or embedded marker. It
paginates up to 500 issue/PR conversation comments. Results distinguish
`no_owned_comment`, `current` and `needs_update`. A copied marker posted
by another author does **not** count as an owned summary. Duplicate or
malformed App-owned markers, incomplete pagination, unavailable GitHub or
invalid JSON fail closed. A synthesized GitHub comment URL is based on the
validated repository/PR and numeric comment ID rather than untrusted
`html_url` fields. `publicationVerified:false` makes clear that a
matching remote comment does not prove Atlas has a durable publication
receipt. Missing records yield `no_saved_review` and no body.

**Write publication is deliberately absent.** An owned-comment lookup is
not enough to safely create/update comments across retries or concurrent
review rounds. The next slice must implement an explicit opt-in publisher
using an appropriately provisioned bot identity, strict permissions,
durable claim and remote-body reconciliation for initial POST and subsequent
PATCH. It must prohibit stale/out-of-order round updates and uncertain
duplicate sends; existing Code Reviewer GitHub publication is already
active and must remain the sole publisher until migration is reviewed.
No `ATLAS_CODE_REVIEW_*` publish allowlist or GitHub App permission is
changed by this work.

### Opt-in managed GitHub PR summary publisher (draft implementation)

`code_reviews_managed_summary_publish({repository,prNumber,apply?})` builds
on the managed preview. **Default `apply:false` never writes**. A deliberate
`apply:true` requires the verified MCP OAuth caller to match the latest
complete structured Review Run's saved submitter, an exact current open
GitHub PR head, and an independently configured repository opt-in:

```text
ATLAS_CODE_REVIEW_MANAGED_SUMMARY_REPOSITORIES=owner/repo
```

This flag is **separate** from
`ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES` (legacy comment-only GitHub
reviews). Both default to disabled. No existing environment flag or GitHub App
permission is changed by the PR. It uses the existing installation's
pull-request read/write token; this is **not** an independently verified
dedicated Code Reviewer bot. Production should remain disabled until
independent approval and an authorized manual acceptance exercise.

Publishing first uses the already verified GitHub App Bot comment inventory.
An unclaimed bot-owned marker is a conflict, not automatically adopted.
Without an owned comment or previous receipt, the operation plans exactly
one new issue/PR conversation comment using the PR-scoped machine-readable
marker. With a previously **published** receipt, the operation requires the
same numeric bot comment ID and exact prior SHA-256 body hash before planning
a PATCH to that comment. A previous review's publisher receipt is never
removed or rewritten by later rounds.

Before either POST or PATCH, Atlas checks that the latest complete structured
review is for the still-open current GitHub head, acquires the repository's
write-scoped token, and **persists a transactionally exclusive claim**
(`coverage.githubManagedSummary`) on the latest Review Run. The transaction
verifies a fingerprint of saved PR rounds and linked finding records, no
other pending claim and stable previous publication identity. This is an
Atlas-side concurrency fence, not a GitHub conditional-write guarantee.

After persisting the claim, Atlas performs a final read-only GitHub PR
head check **before initiating any POST/PATCH**. If this read fails, no remote
write has been attempted: a serialized transaction conditionally removes
only that exact claim ID. The caller receives the original head/read error
and can submit a new reviewed head (or retry after a transient read error)
without manually unlocking anything. If transactional release itself fails,
the response is `prewrite_recovery_required` and Atlas leaves the claim
intact for investigation; it never guesses that the claim was cleared.

Once POST or PATCH has *started*, the outcome may be ambiguous and the
claim must not be released automatically. A subsequent read from GitHub must
verify the Bot-owned PR marker, unique comment ID and exact body hash before
Atlas records a `published` receipt. A malformed response, HTTP failure,
timeout or receipt-commit failure **after write initiation** leaves the claim
unresolved. **Retry never repeats the POST/PATCH automatically.** It only
inspects GitHub and, if the exact expected body and comment identity are
attested, records the receipt. If a newer review arrives while an older
claim is unresolved, the older claim must first be reconciled. Otherwise
the operation remains `uncertain` and needs operator investigation.

A previously published receipt whose remote comment was edited is reported
as `published_remote_drift`; it is not silently overwritten or classified
as current. Review completion is still reviewer-asserted; the comment does
not approve a PR, resolve inline discussions, establish independent AI
reviewer provenance, or infer a fix from absent findings.

**Rollout limitations:** Explicit interactive calls only (no background
scheduler or webhook). No automatic migration from an existing Code Reviewer
GitHub review to a managed summary. The write flow assumes this GitHub App is
the sole writer of its managed comment: GitHub's issue-comment PATCH API
cannot provide an atomic compare-and-swap against external writers, so
remote changes can race after preflight and must be handled operationally.
Unresolved claims have no automated force-unlock. The separate inline GitHub
conversation publisher and dedicated bot identity remain subsequent
milestones. Full production acceptance requires checking the connected
MCP catalogue, current deployed revision, reviewer identity, App permissions,
initial POST, update PATCH and manual uncertain-response recovery.

### Read-only inline thread anchor preflight

`code_reviews_inline_thread_preflight({repository,prNumber})` analyzes the
latest saved Code Reviews round to prepare for a **future, separately
approved** inline discussion publisher. It never sends GitHub review
comments, replies, thread-resolution mutations or publication claims.

The operation reads the Code Reviews Stores with the existing bounded,
legacy-case-aware latest-round timeline. When a round exists, it uses a
repository-scoped GitHub App **read** token to obtain the PR and its changed
files (one page, fewer than 100 files), then reads the PR again. A closed
PR or reviewed-head mismatch cannot yield an eligible new thread location;
a head change *during* inspection fails the entire preview instead.

GitHub's file metadata must be structurally valid. Only `added` or
`modified` files with complete, parseable unified diff hunks and exact
`additions`/`deletions` totals can produce an added `RIGHT`-side line
candidate. Renames, copies, deletions, missing/truncated patches, unchanged
context lines, unknown locations and collisions where multiple findings
name the same path/line stay **summary-only**. A full 100-file page is
treated as incomplete rather than silently ignoring subsequent pages.

The output labels each finding either `candidate` (a structurally
verified new-side location for the latest current structured review) or
`summary_only` with a specific reason. Persisting/unverified
observations and reviewer-asserted resolutions require an existing
GitHub thread identity and evidence before any reply or resolution action;
historical imported Markdown never authorizes a new thread. The service
does **not** match GitHub discussions across commits, claim thread
ownership, establish the independent reviewer identity, or validate an
already-published thread inventory. Even a `candidate` is **not permission
to post**: the future publisher must separately verify author, existing
GitHub thread IDs/markers, changed head and one-shot durable claims before
the very first mutating HTTP request. This stage is diagnostic only.

### Read-only GitHub inline thread identity inventory

`code_reviews_inline_thread_inventory({repository,prNumber})` is a **read-only**
inventory of possible existing inline conversations for the latest saved
review. It does not create comments, adopt legacy threads, mark a finding
fixed, resolve a GitHub discussion or write Atlas Store records.

The identity design for a future reviewer-published inline thread uses a
stable, opaque marker of the exact **canonical owner/repo, PR number and
reviewer-asserted lineage key**:

```text
<!-- atlas-code-reviews-thread:v1:<sha256> -->
```

The marker must be the **single trailing marker** in a root inline comment.
It is not an authentication secret. The reader independently resolves the
installation's numeric GitHub App Bot user ID and requires that the comment
was actually posted by that Bot. A copied marker from a human/other Bot
is recorded as untrusted and cannot establish thread ownership. Replies
(`in_reply_to_id`) cannot be adopted as new roots.

The inventory reads the GitHub PR review-comments REST endpoint with
installation-scoped **read-only** tokens, one page at a time, up to five
100-comment pages. It validates every comment ID and fails closed for
duplicate App-owned roots, malformed owned markers, missing reply parents,
unreadable pages, invalid metadata and ambiguous full fifth pages.
It preserves numeric root IDs and safe GitHub discussion links while
identifying human/bot replies by count. It never treats
`line === null` as evidence of a resolved finding: GitHub may merely
indicate that the original diff location is outdated.

Only the **exact structured lineage** saved in Atlas can match an owned
root. Finding title, path, review timestamp and changing line number do
not establish root-cause identity. The output distinguishes
`owned_thread_found`, `no_owned_thread`,
`missing_stable_lineage` and `historical_or_partial_evidence`,
and reports older unmatched owned threads without deleting them.
Reviewer-asserted resolutions remain labelled assertions with
GitHub resolution state `unknown`; REST review comments do not attest
whether a GitHub conversation was resolved. The separate diff preflight
still determines whether an initial new-line anchor is safe.

**Not yet enabled:** actual inline comment publication, existing-thread
replies, automated verification of a fix, GitHub conversation resolution,
durable one-shot per-thread claims or retroactive adoption of human-owned
Code Reviewer skill comments. Those actions require an independently
reviewed publisher identity/permissions and an opt-in workflow that
prevents duplicate initial threads and ambiguous network retries.

### Opt-in first inline GitHub review thread publisher (draft)

`code_reviews_publish_initial_inline_root({repository,prNumber,findingId,apply?})`
prepares one **new** GitHub inline root comment for a complete structured
Code Reviews finding. The default `apply:false` is read-only. An explicit
`apply:true` is permitted only when its canonical repository is in a new,
independent, **disabled-by-default** allowlist:

```text
ATLAS_CODE_REVIEW_INLINE_ROOT_REPOSITORIES=owner/repository
```

This does not inherit the legacy COMMENT-review allowlist or the managed
summary publisher allowlist. The authenticated MCP OAuth caller must match
the latest saved structured review's original submitting account; the
review must have its native submission receipt and must not already have
legacy GitHub review publication metadata. A missing stable structured
lineage key, historical imported review, persisting/unverified observation,
closed/outdated PR, multiple findings at one diff location, or missing
complete verified added RIGHT-side patch anchor cannot create a thread.

Each root has a deterministic opaque GitHub marker derived from the
canonical repository, PR number, and explicit root-cause lineage key.
The existing **read-only** Bot-owned inline inventory checks every
bounded page for an existing root and refuses duplicate or unclaimed
matches. Human or unrelated Bot comments that copy markers are not
trusted as App-owned; older human Code Reviewer skill conversations are
**not** automatically adopted.

Before a GitHub POST, Atlas obtains a repo-scoped installation write
token, independently checks the current open PR head, and creates a
transactionally exclusive claim under
`Review Findings.evidence.githubInlineThread`. The transaction fences
all current PR run/finding records, prior claims for the same lineage
across rounds, and the selected latest structured finding. Atlas then
re-checks the PR head. A failure **before** any POST is attempted
conditionally releases only the exact claim ID. If that cleanup cannot
be confirmed, it fails closed.

Once the POST may have started, Atlas **never automatically retransmits
an ambiguous write**. The publisher distinguishes GitHub's explicit
`POST /pulls/:pr/comments` HTTP **403 or 422 rejection** from ambiguous
network failures, HTTP 5xx/other statuses, malformed responses and lost
acknowledgements. Even an explicit rejection is **not** enough to release
a claim alone: Atlas first performs a fresh, complete, independently
Bot-authenticated GitHub inline-root inventory. Only if that inventory
succeeds, finds **no owned root with the claim's exact marker** and no
contradictory copied-marker evidence does a serialized transaction
conditionally release the **same finding's exact claim ID and marker**.
The response is `rejected_not_published` and a *new explicitly authorized
apply* can retry after a corrected permission or diff anchor. If the
read fails, a root exists, or the claim changed concurrently, the
claim stays `claimed` and the outcome is `uncertain`: it must **not**
automatically POST again. The allowlist for release is deliberately
small and does not treat generic `GITHUB_REQUEST_FAILED` as proof of
non-acceptance.

Successful POSTs independently re-read the Bot-owned root and check
its numeric comment ID, trailing marker, SHA-256 Markdown body,
original reviewed commit, file path, and original line before committing
a `published` receipt. Any ambiguous response or unsuccessful
verification retains the claim; later calls only read/reconcile an
exact remote match. A later review repeating the same lineage cannot
create a duplicate root. This slice does **not** reply to existing
threads, infer resolution, resolve GitHub conversations, or approve
any PR.

**Important rollout boundary:** Keep this environment allowlist empty
until independent Code Reviewer review, green CI, real connected Atlas
deployment acceptance and a deliberate decision about the existing
Code Reviewer skill's publication path. Otherwise the two publishers
could post the same finding in separate GitHub discussions, since
unmarked human-authored threads cannot be reliably deduplicated by
identity. The dedicated Code Reviews Bot remains an optional future
identity/permission milestone. Native GitHub reply/resolution workflows
require separate, independently reviewed durable claims and owner
controls.

### Opt-in persisting-finding GitHub inline replies

`code_reviews_publish_inline_reply({repository,prNumber,findingId,apply?})`
supports the second round of a managed inline GitHub conversation: **one
reply to an existing verified App-owned root per saved persisting finding**.
The default `apply:false` is a read-only preview; all real writes require
`apply:true`, the original structured review's authenticated OAuth
submitter and a **separate disabled-by-default allowlist**:

```text
ATLAS_CODE_REVIEW_INLINE_REPLY_REPOSITORIES=owner/repository
```

Enabling initial inline-root publication or managed summaries does not
enable replies. Before preparing any reply, Atlas requires the latest
complete native structured review, a new reviewed commit, an explicitly
trusted shared lineage, and a `persisting` observation carrying its
reviewer-submitted assessment/evidence for that commit. A fresh submission
ID on the same reviewed commit does **not** permit another reply for
that lineage when a reply has already been claimed for the same SHA.
The root must
have a saved `published` first-thread claim in an *older* review and
be independently verified in the fully paginated GitHub review-comment
inventory: Bot account, root ID, marker, original SHA, path, line and exact
body checksum. This does **not** adopt or reply to unverified human/legacy
Code Reviewer comments, or infer persistence from unchanged text.

The unique reply marker binds the canonical owner/repository, PR,
verified root ID and immutable finding record ID; it never relies on
title matching, moved line numbers or GitHub's resolved checkbox. A
bounded Bot-authenticated inventory examines both root and reply comments,
ignores copied human markers as ownership evidence, rejects duplicate
Bot-owned reply markers, and confirms replies belong to the exact root.
The operation never creates a new initial thread or a GitHub review
event, approves a PR or changes a GitHub conversation's resolved state.

For `apply:true`, Atlas performs a read-only current-head check, obtains
a scoped GitHub write token, and saves a durable transactionally fenced
claim into `Review Findings.evidence.githubInlineReply` **before** calling
`POST /pulls/{pr}/comments/{rootId}/replies`. A failed second
read-only head check releases only the exact unsent claim. A POST timeout,
HTTP 5xx, malformed GitHub response or failed remote attestation retains
the claim and will **never** be POSTed automatically again. After a
successful reply, Atlas re-reads the independent Bot-owned inventory
and requires the exact parent, marker, reply ID and body checksum before
recording a `published` receipt. Prior claims can be reconciled using
the original finding ID even after later review rounds.

Only an explicitly rejected POST (HTTP 403/422), followed by a complete
verified absence check and an exact transactional claim release, allows a
later separately authorised retry after correction. Any conflicting
remote evidence, incomplete page or failed release stays uncertain.

**Rollout:** Keep this new allowlist empty until the Code Reviews Bot and
single-authoritative-publisher design are accepted against a real PR. A
review-only request remains nonmutating. Verified fix replies and actual
GitHub conversation resolution are separate follow-up milestones; missing
comments, outdated code anchors and reviewer assertions do not themselves
prove that GitHub threads should be marked resolved.

### Explicit reviewer-verified fix acknowledgement on an inline thread

`code_reviews_publish_fix_evidence({repository,prNumber,runId,lineageKey,apply?})`
is the **separate, opt-in** final *comment* in the managed inline discussion
lifecycle. It does **not** automatically close, collapse or resolve the
GitHub conversation. The default `apply:false` is a read-only preview,
and live replies require authenticated original structured-review submitter,
explicit `apply:true` and a fourth, independent default-empty flag:

```text
ATLAS_CODE_REVIEW_INLINE_FIX_REPOSITORIES=owner/repository
```

A "fix" requires the latest saved structured review on an advanced SHA to
contain exactly one explicit **resolved** assertion for this lineage, with
nontrivial evidence and metadata asserting it was assessed on that SHA.
An omitted finding never implies resolution. The origin must be exactly
one older **published, App-owned** root with a retained matching Store
receipt and verifiable GitHub root ID, owner, trailing marker, original SHA,
path/line and raw body hash. Historical imports and human-authored comments
cannot be adopted. This is *reviewer evidence*, not an independently
computed code proof: the GitHub comment intentionally states that the
reviewer assessed the issue as addressed.

Fix messages use a separate trailing
`<!-- atlas-code-reviews-fix:v1:... -->` marker, based on canonical
repository/PR, numeric root ID, immutable review-run UUID and lineage.
The bounded GitHub inventory verifies this specific Bot-owned reply
parent, body checksum and marker and detects conflicting copied human
markers and duplicates independently of existing persisting-issue replies.

The durable claim belongs to `Review Runs.coverage.githubFixReplies` keyed
by explicit root-cause lineage, since a resolved lineage has **no finding
observation** in that round. Both the entire PR history fingerprint and
the per-run claim are checked under PostgreSQL Store transactions. The
current head and original GitHub root are re-checked after the claim but
before any reply POST. Timeout, HTTP 5xx and uncertain GitHub outcomes
keep the claim and never trigger automatic retransmission. An explicit
403/422 rejection only permits exact-claim release after a separate,
complete verification that no Bot-owned matching fix reply exists.
Subsequent invocations can reconcile pending claims through the original
review-run ID even after newer reviews.

The same root and commit cannot be acknowledged twice merely through a
new review submission ID. No thread is closed by this operation; a future
GraphQL resolution workflow needs explicit **GitHub review-thread node ID**
mapping, permission validation, fresh open/resolved-state checks, immutable
claims and independent read-back, plus a policy for reopened discussions.
The REST review-comments endpoint alone does **not** provide proof of
GitHub's thread-resolved state. <https://docs.github.com/en/graphql/reference/pulls>

**Rollout:** Keep this new flag empty until independent review, a real
multi-SHA integration test and a deliberate one-authoritative-publisher
transition from the existing human Code Reviewer plugin. GitHub's
`resolveReviewThread` mutation is *not implemented or invoked* by this PR.

### MCP discovery for bounded tool catalogues

The Server's Application registry includes the Code Reviews tools, but some
ChatGPT connector clients surface only an initial portion of a large MCP tool
list. Atlas registers Code Reviews' application operations near the beginning
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
