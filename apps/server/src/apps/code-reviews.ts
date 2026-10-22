import { z } from 'zod';
import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { ApplicationDefinition } from './registry.js';
import type { GitHubReviewHistoryReader } from './github-review-history.js';
import { reconcileGitHubReviews, CODE_REVIEWS_PROJECT_ID, REVIEW_RUNS_STORE, REVIEW_FINDINGS_STORE } from './review-import.js';
export { CODE_REVIEWS_PROJECT_ID, REVIEW_RUNS_STORE, REVIEW_FINDINGS_STORE } from './review-import.js';

type ReviewCatalogue = Pick<CoreService, 'listStores' | 'queryRecords' | 'store' | 'createRecordInState'>;

/** Project-scoped review history. Import is manually confirmed; publishing is a later capability. */
export class CodeReviewsService {
    constructor(private readonly catalog: ReviewCatalogue,
        private readonly history?: Pick<GitHubReviewHistoryReader, 'read'>,
        private readonly trustedPublishers: ReadonlyMap<string, ReadonlySet<number>> = new Map()) {}

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
                name: 'code_reviews_list_findings',
                description: 'List saved findings for one review run, without accessing other Projects.',
                inputSchema: { reviewRunId: z.string().uuid(), limit, offset },
                invoke: ({ reviewRunId, limit, offset }: { reviewRunId: string; limit: number; offset: number }) => service.findings(reviewRunId, limit, offset),
            },
        ],
    };
}
