import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { CodeReviewsService, codeReviewsApplication, CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/code-reviews.js';
import { createMcpTransport } from '../apps/server/src/api/mcp/index.js';
import { footballTrainingApplication } from '../apps/server/src/apps/football-training.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { TransportServices } from '../apps/server/src/server/dispatch.js';
import { AtlasError } from '../apps/server/src/shared/errors.js';

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

test('Code Reviews operations are visible early in bounded MCP catalogues without a second dispatch path', async () => {
    const { service, app } = fixture();
    // Mirror the production registry ordering: the Code Reviews operation
    // definitions would otherwise appear near the very end of the tool list.
    const applications = new ApplicationRegistry([
        footballTrainingApplication({ call: async () => null } as any),
        codeReviewsApplication(service),
    ]);
    const invoked: string[] = [];
    const server = createMcpTransport({
        applications,
        dispatch: async (name: string, input: unknown, _transport: unknown, caller: unknown) => {
            invoked.push(name);
            return app.invoke(name, input, caller as any);
        },
    } as unknown as TransportServices);
    const client = new Client({ name: 'code-reviews-mcp-prefix', version: '1' });
    const [serverConnection, clientConnection] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(serverConnection);
        await client.connect(clientConnection);
        const { tools } = await client.listTools();
        assert.deepEqual(tools.slice(6, 18).map(tool => tool.name), [
            'code_reviews_overview',
            'code_reviews_pr_summary',
            'code_reviews_pr_timeline',
            'code_reviews_managed_summary_preview',
            'code_reviews_managed_summary_publish',
            'code_reviews_list_runs',
            'code_reviews_list_findings',
            'code_reviews_submit_structured',
            'code_reviews_import_pull_request',
            'code_reviews_discover_pull_requests',
            'code_reviews_backfill_pull_requests',
            'code_reviews_publish_github',
        ]);
        assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length,
            'prioritized tools must not also be registered at the end');
        const write = tools.find(tool => tool.name === 'code_reviews_submit_structured');
        assert.ok(write?.inputSchema.properties?.submission,
            'MCP should retain the structured submission schema');
        const response = await client.callTool({ name: 'code_reviews_overview', arguments: {} });
        assert.equal(response.isError, undefined);
        assert.deepEqual(response.structuredContent?.result, {
            projectId: CODE_REVIEWS_PROJECT_ID, reviewRuns: 3, findingObservations: 5,
        });
        // Early tool discovery must not turn the authenticated write path
        // into an unauthenticated operation. No OAuth identity is installed.
        const rejected = await client.callTool({
            name: 'code_reviews_submit_structured',
            arguments: { submission: {
                submissionId: 'def9bc8e-5c7e-468e-9c3d-ecb886962f83',
                repository: 'affank1020/atlas', prNumber: 114,
                headSha: 'a'.repeat(40), verdict: 'inconclusive', findings: [],
            } },
        });
        assert.equal(rejected.isError, true);
        assert.match(JSON.stringify(rejected.content), /authenticated MCP OAuth caller/);
        assert.deepEqual(invoked, ['code_reviews_overview', 'code_reviews_submit_structured'],
            'the advertised operations must use the existing authenticated dispatch path');
    } finally {
        await client.close();
        await server.close();
    }
});

test('MCP fails fast when a partially registered Code Reviews app omits required operations', () => {
    const applications = new ApplicationRegistry([
        footballTrainingApplication({ call: async () => null } as any),
        { type: 'code-reviews', slug: 'code-reviews', name: 'Code Reviews',
            description: '', tools: [{ name: 'code_reviews_overview', description: '',
                inputSchema: {}, invoke: async () => ({}) }] },
    ]);
    assert.throws(() => createMcpTransport({
        applications, dispatch: async () => null,
    } as unknown as TransportServices), /Required Code Reviews MCP tool missing.*code_reviews_pr_summary/);
});

test('PR summary reports latest saved round, exact GitHub head and recorded counts without conflating commits', async () => {
    const queries: any[] = [];
    const latestSha = 'a'.repeat(40);
    const newerSha = 'b'.repeat(40);
    let head = newerSha;
    let open = true;
    const latest = { id: runId, data: {
        repository: 'affank1020/atlas', prNumber: 114, headSha: latestSha,
        reviewedAt: '2026-10-30T12:00:00.000Z', verdict: 'non_blocking',
        counts: { sev1: 0, sev2: 0, sev3: 1, sev4: 0 },
        coverage: { source: 'atlas_structured_submission' },
    } };
    const service = new CodeReviewsService({
        listStores: async () => [{ id: runsId, name: 'Review Runs' }, { id: findingsId, name: 'Review Findings' }],
        queryRecords: async (input: any) => {
            queries.push(input);
            return { items: [latest], total: 3, limit: 1, offset: 0 };
        },
    } as any, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => ({ repository: 'affank1020/atlas', prNumber: 114, headSha: head, open }),
    });
    const app = new ApplicationRegistry([codeReviewsApplication(service)]);
    const outdated = await app.invoke('code_reviews_pr_summary',
        { repository: 'affank1020/atlas', prNumber: 114 }) as any;
    assert.equal(outdated.recordedRounds, 3, 'these are rounds, not distinct reviewed commits');
    assert.equal(outdated.latestReviewHead, 'outdated');
    assert.equal(outdated.currentHead.state, 'open');
    assert.equal(outdated.currentHead.sha, newerSha);
    assert.ok(!Number.isNaN(Date.parse(outdated.currentHead.checkedAt)));
    assert.deepEqual(outdated.latest, {
        runId, headSha: latestSha, reviewedAt: latest.data.reviewedAt,
        verdict: 'non_blocking', source: 'structured',
        severityCounts: { sev1: 0, sev2: 0, sev3: 1, sev4: 0 },
    });
    assert.deepEqual(queries[0], {
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: runsId,
        filters: [
            { field: 'repository', operator: 'eq', value: 'affank1020/atlas' },
            { field: 'prNumber', operator: 'eq', value: 114 },
        ],
        sort: [{ field: 'reviewedAt', direction: 'desc' }], limit: 1, offset: 0,
    });
    head = latestSha;
    open = false;
    const closed = await app.invoke('code_reviews_pr_summary', {
        repository: 'affank1020/atlas', prNumber: 114,
    }) as any;
    assert.equal(closed.latestReviewHead, 'current');
    assert.equal(closed.currentHead.state, 'closed');
    await assert.rejects(app.invoke('code_reviews_pr_summary',
        { repository: 'evil/repo?x=1', prNumber: 114 }), /Invalid|regex|match/i);
    await assert.rejects(app.invoke('code_reviews_pr_summary',
        { repository: 'affank1020/atlas', prNumber: 0 }), /Invalid|number|greater/i);
});

test('PR summary retains explicit unknown status for missing, incomplete or unavailable evidence', async () => {
    const run = { id: runId, data: {
        headSha: 'a'.repeat(40), reviewedAt: '2026-10-30T12:00:00.000Z',
        verdict: 'no_findings', coverage: { source: 'github_pull_request_review' },
    } };
    let items: any[] = [];
    let total = 0;
    let failGitHub = true;
    const service = new CodeReviewsService({
        listStores: async () => [{ id: runsId, name: 'Review Runs' }, { id: findingsId, name: 'Review Findings' }],
        queryRecords: async () => ({ items, total, limit: 1, offset: 0 }),
    } as any, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => {
            if (failGitHub) throw new AtlasError('GitHub unavailable', 'GITHUB_UNAVAILABLE');
            return { repository: 'affank1020/atlas', prNumber: 114, headSha: 'b'.repeat(40), open: true };
        },
    });
    const noRun = await service.prSummary('affank1020/atlas', 114);
    assert.equal(noRun.latest, null);
    assert.equal(noRun.latestReviewHead, 'no_stored_review');
    assert.deepEqual(noRun.currentHead, { state: 'unavailable' });
    total = 1; items = [run];
    const historical = await service.prSummary('affank1020/atlas', 114);
    assert.equal(historical.latest?.source, 'historical');
    assert.equal(historical.latest?.severityCounts, null, 'inline-only imports are not complete zero-finding verdicts');
    assert.equal(historical.latestReviewHead, 'unknown');
    failGitHub = false;
    assert.equal((await service.prSummary('affank1020/atlas', 114)).latestReviewHead, 'outdated');
    items = [];
    await assert.rejects(service.prSummary('affank1020/atlas', 114),
        /could not be loaded/);
    items = [{ id: runId, data: { ...run.data, headSha: 'broken' } }];
    await assert.rejects(service.prSummary('affank1020/atlas', 114),
        /unsupported fields/);
});
