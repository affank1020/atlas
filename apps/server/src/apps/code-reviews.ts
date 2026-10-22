import { z } from 'zod';
import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { ApplicationDefinition } from './registry.js';

export const CODE_REVIEWS_PROJECT_ID = '008b191b-96c2-4a5f-92f6-1f13d6d790d5';
export const REVIEW_RUNS_STORE = 'Review Runs';
export const REVIEW_FINDINGS_STORE = 'Review Findings';

type ReviewCatalogue = Pick<CoreService, 'listStores' | 'queryRecords'>;

/** Project-scoped, read-only foundation. Publication is intentionally a later capability. */
export class CodeReviewsService {
    constructor(private readonly catalog: ReviewCatalogue) {}

    private async storeIds() {
        const stores = await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs = stores.find(store => store.name === REVIEW_RUNS_STORE);
        const findings = stores.find(store => store.name === REVIEW_FINDINGS_STORE);
        if (!runs || !findings)
            throw new AtlasError('Code Reviews project requires the Review Runs and Review Findings Stores.', 'CAPABILITY_UNAVAILABLE');
        return { runs: runs.id, findings: findings.id };
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
                name: 'code_reviews_list_findings',
                description: 'List saved findings for one review run, without accessing other Projects.',
                inputSchema: { reviewRunId: z.string().uuid(), limit, offset },
                invoke: ({ reviewRunId, limit, offset }: { reviewRunId: string; limit: number; offset: number }) => service.findings(reviewRunId, limit, offset),
            },
        ],
    };
}
