import { z } from 'zod';
import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { ApplicationDefinition, ApplicationCaller } from './registry.js';
import type { GitHubReviewHistoryReader } from './github-review-history.js';
import { structuredReviewSchema, assertStructuredCaller, existingStructuredReview, saveStructuredReview, type StructuredReview } from './review-submission.js';
import type { AtlasData } from '../types.js';
import { readPrTimeline } from './review-timeline.js';
import type { ReviewPublicationService } from './review-publication.js';
import type { ManagedSummaryPreviewService } from './managed-summary.js';
import type { ManagedSummaryPublicationService } from './managed-summary-publication.js';
import type { InlineThreadPreflightService } from './inline-thread-preflight.js';
import type { InlineThreadInventoryService } from './inline-thread-inventory.js';
import { reconcileGitHubReviews, CODE_REVIEWS_PROJECT_ID, REVIEW_RUNS_STORE, REVIEW_FINDINGS_STORE, type ReviewSource } from './review-import.js';
export { CODE_REVIEWS_PROJECT_ID, REVIEW_RUNS_STORE, REVIEW_FINDINGS_STORE } from './review-import.js';

type ReviewCatalogue = Pick<CoreService, 'listStores' | 'queryRecords' | 'store' | 'createRecordInState'>;

/** Project-scoped review history. Import is manually confirmed; publishing is a later capability. */
export class CodeReviewsService {
    constructor(private readonly catalog: ReviewCatalogue,
        private readonly history?: Pick<GitHubReviewHistoryReader, 'read'> & Partial<Pick<GitHubReviewHistoryReader, 'discover' | 'currentHead'>>,
        private readonly trustedPublishers: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
        private readonly publisher?: Pick<ReviewPublicationService, 'publishRun'>,
        private readonly managedSummary?: Pick<ManagedSummaryPreviewService, 'preview'>,
        private readonly managedPublisher?: Pick<ManagedSummaryPublicationService, 'publish'>,
        private readonly inlinePreflight?: Pick<InlineThreadPreflightService, 'preview'>,
        private readonly inlineInventory?: Pick<InlineThreadInventoryService, 'preview'>) {}

    private async storeIds() {
        const stores = await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs = stores.find(store => store.name === REVIEW_RUNS_STORE);
        const findings = stores.find(store => store.name === REVIEW_FINDINGS_STORE);
        if (!runs || !findings)
            throw new AtlasError('Code Reviews project requires the Review Runs and Review Findings Stores.', 'CAPABILITY_UNAVAILABLE');
        return { runs: runs.id, findings: findings.id };
    }

    /** Read-only preview by default. Apply persists atomically and is safe to repeat. */
    async importPullRequest(repository: string, prNumber: number, apply: boolean) {
        if (!this.history) throw new AtlasError('GitHub review history import is unavailable.', 'CAPABILITY_UNAVAILABLE');
        const trustedIds = this.trustedPublishers.get(repository.toLowerCase());
        if (!trustedIds?.size)
            throw new AtlasError('No trusted Code Reviewer publisher IDs are configured for this repository.', 'CAPABILITY_UNAVAILABLE');
        const ids = await this.storeIds();
        const snapshot = await this.history.read(repository, prNumber);
        if (!apply)
            return reconcileGitHubReviews(this.catalog, await this.catalog.store.snapshot(),
                ids, repository, prNumber, snapshot, false, trustedIds);
        return this.catalog.store.transaction(state =>
            reconcileGitHubReviews(this.catalog, state, ids, repository, prNumber, snapshot, true, trustedIds));
    }

    /** Save an independently structured review; no GitHub review is published. */
    async submitStructuredReview(untrusted: StructuredReview, caller?: ApplicationCaller) {
        assertStructuredCaller(caller);
        const input = structuredReviewSchema.parse(untrusted);
        const ids = await this.storeIds();
        // A lost response can be retried after the PR advances: return the
        // original immutable receipt rather than publishing/reviewing again.
        const previous = existingStructuredReview(await this.catalog.store.snapshot(), ids, input, caller!);
        if (previous) return previous;
        if (!this.history?.currentHead)
            throw new AtlasError('GitHub PR head verification is unavailable.', 'CAPABILITY_UNAVAILABLE');
        const remote = await this.history.currentHead(input.repository, input.prNumber);
        if (!remote.open || remote.headSha !== input.headSha) {
            // Another identical submission may have committed while this call was
            // fetching GitHub. Serialize the fallback read with writers so that
            // a committed receipt wins, without relaxing validation for new IDs.
            return this.catalog.store.transaction(state => {
                const committed = existingStructuredReview(state, ids, input, caller!);
                if (committed) return committed;
                throw new AtlasError('Pull request is closed or its head has changed; review the current open head.', 'CONFLICT');
            });
        }
        const verifiedAt = new Date().toISOString();
        return this.catalog.store.transaction(state =>
            saveStructuredReview(this.catalog, state, ids, input, remote.headSha, verifiedAt, caller!));
    }

    /** Preview by default; explicit apply sends one comment-only GitHub review. */
    async publishReview(runId: string, includeInline: boolean, apply: boolean, caller?: ApplicationCaller) {
        assertStructuredCaller(caller);
        if (!this.publisher) throw new AtlasError('GitHub review publisher is unavailable.', 'CAPABILITY_UNAVAILABLE');
        return this.publisher.publishRun(runId, includeInline, apply, caller);
    }

    /** Preview a prospective one-comment-per-PR summary and verify App Bot ownership.
     * This capability does not claim or write any GitHub comment.
     */
    async previewManagedSummary(repository: string, prNumber: number) {
        if (!this.managedSummary)
            throw new AtlasError('Managed PR summary preview is unavailable.', 'CAPABILITY_UNAVAILABLE');
        return this.managedSummary.preview(repository, prNumber);
    }

    /** Durable, opt-in GitHub PR comment create/update. Never approves a PR. */
    async publishManagedSummary(repository: string, prNumber: number, apply: boolean,
        caller?: ApplicationCaller) {
        assertStructuredCaller(caller);
        if (!this.managedPublisher)
            throw new AtlasError('Managed summary publication is unavailable.', 'CAPABILITY_UNAVAILABLE');
        return this.managedPublisher.publish(repository, prNumber, apply, caller);
    }

    /** Read-only verified new-side diff target analysis; no GitHub threads are written. */
    async previewInlineThreads(repository: string, prNumber: number) {
        if (!this.inlinePreflight)
            throw new AtlasError('Inline thread preflight is unavailable.', 'CAPABILITY_UNAVAILABLE');
        return this.inlinePreflight.preview(repository, prNumber);
    }

    /** Verify existing App-owned GitHub inline roots against stable stored lineages. */
    async previewInlineThreadInventory(repository: string, prNumber: number) {
        if (!this.inlineInventory)
            throw new AtlasError('Inline thread inventory is unavailable.', 'CAPABILITY_UNAVAILABLE');
        return this.inlineInventory.preview(repository, prNumber);
    }

    /** GitHub PR discovery is read-only. Explicit numbers are required for batch apply. */
    async discoverPullRequests(repository: string, page: number) {
        if (!this.history?.discover)
            throw new AtlasError('GitHub pull request discovery is unavailable.', 'CAPABILITY_UNAVAILABLE');
        return this.history.discover(repository, page);
    }

    /** Bounded, deterministic selection. All source requests must finish successfully
     * before one database transaction begins; a conflict rolls back the entire batch.
     */
    async backfillPullRequests(repository: string, prNumbers: number[], apply: boolean) {
        if (!this.history) throw new AtlasError('GitHub review history import is unavailable.', 'CAPABILITY_UNAVAILABLE');
        if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository) ||
            !Array.isArray(prNumbers) || prNumbers.length < 1 || prNumbers.length > 8 ||
            prNumbers.some(n => !Number.isSafeInteger(n) || n < 1 || n > 1_000_000) ||
            new Set(prNumbers).size !== prNumbers.length)
            throw new AtlasError('Choose between 1 and 8 distinct valid pull request numbers.', 'INVALID_REQUEST');
        const trusted = this.trustedPublishers.get(repository.toLowerCase());
        if (!trusted?.size)
            throw new AtlasError('No trusted Code Reviewer publisher IDs are configured for this repository.', 'CAPABILITY_UNAVAILABLE');
        const stores = await this.storeIds();
        // No writes occur until every requested GitHub snapshot has arrived and validated.
        const sources: { prNumber: number; snapshot: ReviewSource }[] = [];
        for (const prNumber of prNumbers)
            sources.push({ prNumber, snapshot: await this.history.read(repository, prNumber) });
        const reconcile = (state: AtlasData, persisted: boolean) => {
            // The preview runs the same in-memory mutations against a disposable snapshot.
            // This detects conflicts *between* selected PRs before apply, but writes
            // nothing to the database. The live transaction is the same algorithm.
            const results = sources.map(({ prNumber, snapshot }) => ({
                ...reconcileGitHubReviews(this.catalog, state, stores, repository, prNumber, snapshot, true, trusted),
                dryRun: !persisted,
            }));
            return {
                repository, dryRun: !persisted, prNumbers: [...prNumbers], results,
                totals: {
                    runsCreated: results.reduce((sum, result) => sum + result.runsCreated, 0),
                    runsAlreadyPresent: results.reduce((sum, result) => sum + result.runsAlreadyPresent, 0),
                    findingsCreated: results.reduce((sum, result) => sum + result.findingsCreated, 0),
                    findingsAlreadyPresent: results.reduce((sum, result) => sum + result.findingsAlreadyPresent, 0),
                    skippedUntrusted: results.reduce((sum, result) => sum + result.skippedUntrusted, 0),
                },
            };
        };
        if (!apply) return reconcile(await this.catalog.store.snapshot(), false);
        return this.catalog.store.transaction(state => reconcile(state, true));
    }

    /** An on-demand PR read. Never infer a clean review from absent/partial history.
     * The database query selects the latest *recorded* round; GitHub is read
     * independently because the PR head can advance after that round.
     */
    async prSummary(repository: string, prNumber: number) {
        const ids = await this.storeIds();
        const saved = await this.catalog.queryRecords({
            projectId: CODE_REVIEWS_PROJECT_ID, storeId: ids.runs,
            filters: [
                { field: 'repository', operator: 'eq', value: repository },
                { field: 'prNumber', operator: 'eq', value: prNumber },
            ],
            sort: [{ field: 'reviewedAt', direction: 'desc' }], limit: 1, offset: 0,
        });
        const record = saved.items[0];
        if (saved.total > 0 && !record)
            throw new AtlasError('Latest Code Reviews record could not be loaded.', 'CAPABILITY_UNAVAILABLE');

        let latest: null | {
            runId: string; headSha: string; reviewedAt: string; verdict: string;
            source: 'structured' | 'historical' | 'unknown';
            severityCounts: { sev1: number; sev2: number; sev3: number; sev4: number } | null;
        } = null;
        if (record) {
            const data = record.data;
            if (typeof data.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(data.headSha) ||
                typeof data.reviewedAt !== 'string' || Number.isNaN(Date.parse(data.reviewedAt)) ||
                typeof data.verdict !== 'string' ||
                !['changes_requested', 'concerns_to_verify', 'non_blocking', 'no_findings', 'inconclusive'].includes(data.verdict))
                throw new AtlasError('Latest Code Reviews record has unsupported fields.', 'CAPABILITY_UNAVAILABLE');
            const coverage = data.coverage && typeof data.coverage === 'object' && !Array.isArray(data.coverage)
                ? data.coverage as Record<string, unknown> : undefined;
            const counts = data.counts && typeof data.counts === 'object' && !Array.isArray(data.counts)
                ? data.counts as Record<string, unknown> : undefined;
            const validCount = (v: unknown): v is number => typeof v === 'number' &&
                Number.isSafeInteger(v) && v >= 0;
            const severityCounts = counts && validCount(counts.sev1) && validCount(counts.sev2) &&
                validCount(counts.sev3) && validCount(counts.sev4)
                ? { sev1: counts.sev1, sev2: counts.sev2, sev3: counts.sev3, sev4: counts.sev4 } : null;
            latest = {
                runId: record.id, headSha: data.headSha.toLowerCase(),
                reviewedAt: data.reviewedAt, verdict: data.verdict,
                source: coverage?.source === 'atlas_structured_submission' ? 'structured'
                    : coverage?.source === 'github_pull_request_review' ? 'historical' : 'unknown',
                severityCounts,
            };
        }

        // An unavailable GitHub installation/endpoint is not evidence that
        // a recorded review is current, stale, clean or absent.
        let currentHead: { state: 'open' | 'closed' | 'unavailable'; sha?: string; checkedAt?: string } =
            { state: 'unavailable' };
        if (this.history?.currentHead) {
            try {
                const head = await this.history.currentHead(repository, prNumber);
                currentHead = { state: head.open ? 'open' : 'closed',
                    sha: head.headSha.toLowerCase(), checkedAt: new Date().toISOString() };
            } catch (error) {
                if (!(error instanceof AtlasError) ||
                    !['GITHUB_UNAVAILABLE', 'GITHUB_REQUEST_FAILED', 'CAPABILITY_UNAVAILABLE'].includes(error.code))
                    throw error;
            }
        }
        return {
            repository, prNumber, recordedRounds: saved.total, latest, currentHead,
            latestReviewHead: !latest ? 'no_stored_review'
                : currentHead.state === 'unavailable' ? 'unknown'
                : latest.headSha === currentHead.sha ? 'current' : 'outdated',
        };
    }

    /** Read-only, page-scoped lineage; does not infer fixes from missing evidence. */
    async prTimeline(repository: string, prNumber: number, limit: number, offset: number) {
        const ids = await this.storeIds();
        return readPrTimeline(this.catalog, ids, repository, prNumber, limit, offset);
    }

    async overview() {
        const ids = await this.storeIds();
        const [runs, findings] = await Promise.all([
            this.catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: ids.runs, limit: 1, offset: 0 }),
            this.catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: ids.findings, limit: 1, offset: 0 }),
        ]);
        return { projectId: CODE_REVIEWS_PROJECT_ID, reviewRuns: runs.total, findingObservations: findings.total };
    }

    async runs(limit: number, offset: number) {
        const ids = await this.storeIds();
        return this.catalog.queryRecords({
            projectId: CODE_REVIEWS_PROJECT_ID, storeId: ids.runs,
            sort: [{ field: 'reviewedAt', direction: 'desc' }], limit, offset,
        });
    }

    async findings(reviewRunId: string, limit: number, offset: number) {
        const ids = await this.storeIds();
        return this.catalog.queryRecords({
            projectId: CODE_REVIEWS_PROJECT_ID, storeId: ids.findings,
            filters: [{ field: 'reviewRunId', operator: 'eq', value: reviewRunId }],
            sort: [{ field: 'createdAt', direction: 'asc' }], limit, offset,
        });
    }
}

export function codeReviewsApplication(service: CodeReviewsService): ApplicationDefinition {
    const limit = z.number().int().min(1).max(100).default(50);
    const offset = z.number().int().min(0).max(100000).default(0);
    return {
        type: 'code-reviews', slug: 'code-reviews', projectId: CODE_REVIEWS_PROJECT_ID,
        name: 'Code Reviews',
        description: 'Inspect independent AI review history, findings and repository quality metrics.',
        tools: [
            {
                name: 'code_reviews_overview',
                description: 'Read project-scoped Code Reviews totals; no GitHub publication.',
                inputSchema: {}, invoke: () => service.overview(),
            },
            {
                name: 'code_reviews_pr_summary',
                description: 'Read the latest saved review and compare its commit with the current GitHub PR head. Unknown state is not clean; no writes.',
                inputSchema: { repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
                    prNumber: z.number().int().min(1).max(1_000_000) },
                invoke: ({ repository, prNumber }: { repository: string; prNumber: number }) =>
                    service.prSummary(repository, prNumber),
            },
            {
                name: 'code_reviews_pr_timeline',
                description: 'Read bounded saved PR rounds and explicit finding lineage; missing history and resolutions remain unknown.',
                inputSchema: {
                    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
                    prNumber: z.number().int().min(1).max(1_000_000),
                    limit: z.number().int().min(1).max(10).default(5),
                    offset,
                },
                invoke: ({ repository, prNumber, limit, offset }: {
                    repository: string; prNumber: number; limit: number; offset: number;
                }) => service.prTimeline(repository, prNumber, limit, offset),
            },
            {
                name: 'code_reviews_managed_summary_preview',
                description: 'Read-only managed PR summary draft and verified existing GitHub App Bot comment ownership. No posts, updates or claims.',
                inputSchema: { repository: z.string().regex(/^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/),
                    prNumber: z.number().int().min(1).max(1_000_000) },
                invoke: ({ repository, prNumber }: { repository: string; prNumber: number }) =>
                    service.previewManagedSummary(repository, prNumber),
            },
            {
                name: 'code_reviews_managed_summary_publish',
                description: 'Explicit, opt-in create/update of one bot-owned PR summary comment; dry-run by default, durable claims block uncertain retries. Never approves or replies.',
                inputSchema: {
                    repository: z.string().regex(/^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/),
                    prNumber: z.number().int().min(1).max(1_000_000),
                    apply: z.boolean().default(false),
                },
                invoke: ({ repository, prNumber, apply }: {
                    repository: string; prNumber: number; apply: boolean;
                }, caller?: ApplicationCaller) =>
                    service.publishManagedSummary(repository, prNumber, apply, caller),
            },
            {
                name: 'code_reviews_inline_thread_preflight',
                description: 'Read-only current PR diff checks for potential inline finding anchors; unverified, outdated, historical and lifecycle outcomes remain summary-only. Does not create or reply to comments.',
                inputSchema: {
                    repository: z.string().regex(/^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/),
                    prNumber: z.number().int().min(1).max(1_000_000),
                },
                invoke: ({ repository, prNumber }: { repository: string; prNumber: number }) =>
                    service.previewInlineThreads(repository, prNumber),
            },
            {
                name: 'code_reviews_inline_thread_inventory',
                description: 'Read-only verification of App Bot-owned GitHub inline thread roots against saved reviewer lineage keys. Does not write replies or infer resolved threads.',
                inputSchema: {
                    repository: z.string().regex(/^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/),
                    prNumber: z.number().int().min(1).max(1_000_000),
                },
                invoke: ({ repository, prNumber }: { repository: string; prNumber: number }) =>
                    service.previewInlineThreadInventory(repository, prNumber),
            },
            {
                name: 'code_reviews_list_runs',
                description: 'List saved independent review runs in descending review time.',
                inputSchema: { limit, offset }, invoke: ({ limit, offset }: { limit: number; offset: number }) => service.runs(limit, offset),
            },
            {
                name: 'code_reviews_import_pull_request',
                description: 'Preview an authenticated GitHub PR review history import. Set apply=true to save supported reviews and severity-labelled inline findings atomically. No GitHub publication.',
                inputSchema: { repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
                    prNumber: z.number().int().min(1).max(1_000_000), apply: z.boolean().default(false) },
                invoke: ({ repository, prNumber, apply }: { repository: string; prNumber: number; apply: boolean }) =>
                    service.importPullRequest(repository, prNumber, apply),
            },
            {
                name: 'code_reviews_discover_pull_requests',
                description: 'List a page of recent GitHub PR numbers in a repository for deliberate selection. Read-only; pages can shift as new PRs arrive.',
                inputSchema: { repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
                    page: z.number().int().min(1).max(100).default(1) },
                invoke: ({ repository, page }: { repository: string; page: number }) =>
                    service.discoverPullRequests(repository, page),
            },
            {
                name: 'code_reviews_backfill_pull_requests',
                description: 'Preview up to 8 explicitly selected GitHub PRs with apply=false. Set apply=true for atomic, idempotent batch import. Never automatically selects PRs.',
                inputSchema: { repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
                    prNumbers: z.array(z.number().int().min(1).max(1_000_000)).min(1).max(8)
                        .refine(numbers => new Set(numbers).size === numbers.length, 'PR numbers must be distinct'),
                    apply: z.boolean().default(false) },
                invoke: ({ repository, prNumbers, apply }: { repository: string; prNumbers: number[]; apply: boolean }) =>
                    service.backfillPullRequests(repository, prNumbers, apply),
            },
            {
                name: 'code_reviews_submit_structured',
                description: 'Persist an immutable, idempotent structured review run and findings. Requires current open GitHub PR head; never publishes to GitHub.',
                inputSchema: { submission: structuredReviewSchema },
                invoke: ({ submission }: { submission: StructuredReview }, caller?: ApplicationCaller) =>
                    service.submitStructuredReview(submission, caller),
            },
            {
                name: 'code_reviews_publish_github',
                description: 'Preview structured review GitHub COMMENT publication. Requires verified OAuth, apply=true and repository opt-in. Durable claim prevents duplicate posts; never approves.',
                inputSchema: { runId: z.string().uuid(), includeInline: z.boolean().default(false),
                    apply: z.boolean().default(false) },
                invoke: ({ runId, includeInline, apply }: { runId: string; includeInline: boolean; apply: boolean },
                    caller?: ApplicationCaller) => service.publishReview(runId, includeInline, apply, caller),
            },
            {
                name: 'code_reviews_list_findings',
                description: 'List saved findings for one review run, without accessing other Projects.',
                inputSchema: { reviewRunId: z.string().uuid(), limit, offset },
                invoke: ({ reviewRunId, limit, offset }: { reviewRunId: string; limit: number; offset: number }) => service.findings(reviewRunId, limit, offset),
            },
        ],
    };
}
