import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { CodeReviewsService, codeReviewsApplication, CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/code-reviews.js';

const runsId = '0140b619-4f75-454e-92a3-c8b595c9dee5';
const findingsId = '17fb7f1e-fd26-415b-a70a-f1ae786b19c6';
const runId = '00000000-0000-4000-8000-000000000023';

function fixture() {
    const queries: any[] = [];
    const projects: string[] = [];
    const catalog = {
        async listStores(projectId: string) {
            projects.push(projectId);
            return [{ id: runsId, name: 'Review Runs' }, { id: findingsId, name: 'Review Findings' }];
        },
        async queryRecords(input: any) {
            queries.push(input);
            return { items: [], total: input.storeId === runsId ? 3 : 5, limit: input.limit, offset: input.offset };
        },
    };
    const service = new CodeReviewsService(catalog as any);
    const app = new ApplicationRegistry([codeReviewsApplication(service)]);
    return { queries, projects, service, app };
}

test('Code Reviews is a project-owned first-party Application', () => {
    const { app } = fixture();
    assert.equal(app.list(CODE_REVIEWS_PROJECT_ID)[0]?.slug, 'code-reviews');
    assert.equal(app.list('some-other-project').length, 0);
    assert.throws(() => app.get(null, 'code-reviews'), /not found/);
    for (const operation of ['code_reviews_overview', 'code_reviews_list_runs', 'code_reviews_list_findings']) {
        assert.equal(app.hasTool(operation), true);
    }
});

test('Overview counts only the two Project-owned Stores', async () => {
    const { app, queries, projects } = fixture();
    assert.deepEqual(await app.invoke('code_reviews_overview', {}), {
        projectId: CODE_REVIEWS_PROJECT_ID, reviewRuns: 3, findingObservations: 5,
    });
    assert.deepEqual(projects, [CODE_REVIEWS_PROJECT_ID]);
    assert.equal(queries.length, 2);
    for (const q of queries) assert.equal(q.projectId, CODE_REVIEWS_PROJECT_ID);
});

test('Review runs are bounded, ordered and cannot be queried from another Project', async () => {
    const { app, queries } = fixture();
    await app.invoke('code_reviews_list_runs', { limit: 12, offset: 2 });
    assert.deepEqual(queries[0], {
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: runsId, limit: 12, offset: 2,
        sort: [{ field: 'reviewedAt', direction: 'desc' }],
    });
    await assert.rejects(app.invoke('code_reviews_list_runs', { limit: 101 }), /too_big|number|100/i);
    await assert.rejects(app.invoke('code_reviews_list_runs', { offset: -1 }), /small|number|0/i);
    // Unknown caller fields are stripped by the shared ApplicationRegistry parser;
    // they must never override the Project scope enforced by CodeReviewsService.
    await app.invoke('code_reviews_list_runs', { projectId: 'other' });
    assert.equal(queries[1].projectId, CODE_REVIEWS_PROJECT_ID);
});

test('Findings require a valid review ID and are queried by review-run relation', async () => {
    const { app, queries } = fixture();
    await assert.rejects(app.invoke('code_reviews_list_findings', { reviewRunId: 'not-a-uuid' }), /uuid|Invalid/i);
    await app.invoke('code_reviews_list_findings', { reviewRunId: runId });
    assert.deepEqual(queries[0].filters, [{ field: 'reviewRunId', operator: 'eq', value: runId }]);
    assert.equal(queries[0].projectId, CODE_REVIEWS_PROJECT_ID);
    assert.equal(queries[0].storeId, findingsId);
});

test('Store misconfiguration is reported instead of silently returning zeros', async () => {
    const service = new CodeReviewsService({
        listStores: async () => [{ id: runsId, name: 'Review Runs' }],
        queryRecords: async () => { throw new Error('must not query partial installation'); },
    } as any);
    await assert.rejects(service.overview(), /requires the Review Runs and Review Findings Stores/);
});
