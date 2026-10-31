import assert from 'node:assert/strict';
import test from 'node:test';
import { CodeReviewsService, codeReviewsApplication } from '../apps/server/src/apps/code-reviews.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';

const runsId = '0140b619-4f75-454e-92a3-c8b595c9dee5';
const findingsId = '17fb7f1e-fd26-415b-a70a-f1ae786b19c6';
const repo = 'affank1020/atlas';
const ids = [
    'c827a293-24fa-48bb-8f54-7c998c482101',
    'c827a293-24fa-48bb-8f54-7c998c482102',
    'c827a293-24fa-48bb-8f54-7c998c482103',
];
const submissionA = '76894d70-4b4d-481b-9d68-e05b1e536b01';
const submissionB = '76894d70-4b4d-481b-9d68-e05b1e536b02';
const headA = 'a'.repeat(40);
const headB = 'b'.repeat(40);

const rounds = [
    { id: ids[0], data: { repository: repo, prNumber: 116, headSha: headB,
        reviewedAt: '2026-10-30T15:00:00Z', verdict: 'non_blocking',
        coverage: { source: 'atlas_structured_submission', submissionId: submissionB, findingCount: 2 } } },
    { id: ids[1], data: { repository: repo, prNumber: 116, headSha: headA,
        reviewedAt: '2026-10-30T14:00:00Z', verdict: 'changes_requested',
        coverage: { source: 'atlas_structured_submission', submissionId: submissionA, findingCount: 1 } } },
    { id: ids[2], data: { repository: repo, prNumber: 116, headSha: headA,
        reviewedAt: '2026-10-29T14:00:00Z', verdict: 'no_findings',
        coverage: { source: 'github_pull_request_review' } } },
];
function observation(runId: string, submissionId: string, suffix: string, lineageKey?: string) {
    return { id: 'e39a62b2-a86f-4e96-ae8c-' + suffix.padStart(12, '0'), data: {
        reviewRunId: runId, findingKey: `structured:${submissionId}:${suffix}`,
        severity: 'sev3', title: 'Same root cause', description: 'Review evidence',
        state: 'new', evidence: { source: 'atlas_structured_submission', localKey: suffix,
            ...(lineageKey && { lineageKey }) },
    } };
}
const findingByRun: Record<string, any[]> = {
    [ids[0]]: [observation(ids[0], submissionB, '2', 'same-root'), observation(ids[0], submissionB, 'extra')],
    [ids[1]]: [observation(ids[1], submissionA, '1', 'same-root')],
    [ids[2]]: [{ id: 'e39a62b2-a86f-4e96-ae8c-000000000099', data: {
        reviewRunId: ids[2], findingKey: 'github-review-comment:900',
        severity: 'sev4', title: 'Historical inline observation', description: 'Partial Markdown import',
        state: 'unverified',
    } }],
};

function fixture(override: { rounds?: any[]; findings?: Record<string, any[]>; counts?: Record<string, number> } = {}) {
    const queries: any[] = [];
    const allRounds = override.rounds ?? rounds;
    const findings = override.findings ?? findingByRun;
    const catalog = {
        listStores: async () => [{ id: runsId, name: 'Review Runs' }, { id: findingsId, name: 'Review Findings' }],
        queryRecords: async (q: any) => {
            queries.push(q);
            const filter = Object.fromEntries((q.filters ?? []).map((f: any) => [f.field, f.value]));
            if (q.storeId === runsId) {
                assert.deepEqual(filter, { prNumber: 116 });
                return { total: allRounds.length, items: allRounds.slice(q.offset, q.offset + q.limit) };
            }
            assert.equal(q.storeId, findingsId);
            assert.deepEqual(q.filters, [{ field: 'reviewRunId', operator: 'eq', value: filter.reviewRunId }]);
            const list = findings[filter.reviewRunId] ?? [];
            return { total: override.counts?.[filter.reviewRunId] ?? list.length,
                items: list.slice(q.offset, q.offset + q.limit) };
        },
    };
    return { app: new ApplicationRegistry([codeReviewsApplication(new CodeReviewsService(catalog as any))]), queries };
}

test('timeline keeps review rounds, explicitly asserted root causes and unlinked historical evidence separate', async () => {
    const { app, queries } = fixture();
    const result = await app.invoke('code_reviews_pr_timeline', { repository: repo, prNumber: 116 }) as any;
    assert.equal(result.recordedRounds, 3);
    assert.equal(result.storedWindowComplete, true);
    assert.equal(result.hasMore, false);
    assert.equal(result.resolutionInferred, false);
    assert.equal(result.rounds.length, 3);
    assert.equal(result.rounds[0].headSha, headB);
    assert.equal(result.rounds[1].headSha, headA);
    assert.equal(result.rounds[2].findingCoverage, 'historical_partial');
    assert.equal(result.rounds[2].findings[0].lineageKey, null);
    assert.equal(result.unlinkedObservations, 2);
    assert.deepEqual(result.lineages.map((lineage: any) => [lineage.key, lineage.observationsInPage, lineage.recurrence]),
        [['same-root', 2, 'observed_multiple_times_in_page']]);
    assert.equal(result.rounds[0].findings[0].state, 'new', 'persisting is not inferred from repeat keys');
    assert.equal(queries.length, 4);
    assert.equal(queries[0].limit, 5);
    assert.equal(queries[0].projectId, CODE_REVIEWS_PROJECT_ID);
    for (const query of queries.slice(1)) {
        assert.equal(query.projectId, CODE_REVIEWS_PROJECT_ID);
        assert.equal(query.limit, 100);
        assert.equal(query.offset, 0);
    }
});

test('pagination only claims lineage occurrences within the loaded page', async () => {
    const { app, queries } = fixture();
    const first = await app.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116, limit: 1, offset: 0 }) as any;
    assert.equal(first.hasMore, true);
    assert.equal(first.storedWindowComplete, false);
    assert.equal(first.lineages[0].observationsInPage, 1);
    assert.equal(first.lineages[0].recurrence, 'observed_once_in_page');
    const older = await app.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116, limit: 1, offset: 1 }) as any;
    assert.equal(older.lineages[0].observationsInPage, 1);
    assert.equal(older.storedWindowComplete, false);
    assert.equal(older.rounds[0].runId, ids[1]);
    assert.equal(queries[0].limit, 1);
    await assert.rejects(app.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116, limit: 11 }), /10|less_than_equal|too_big/i);
    await assert.rejects(app.invoke('code_reviews_pr_timeline',
        { repository: 'bad/repo?q=1', prNumber: 116 }), /Invalid|regex|match/i);
});

test('missing history remains empty rather than clean; truncated findings surface explicitly', async () => {
    const empty = fixture({ rounds: [], findings: {} });
    const none = await empty.app.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116 }) as any;
    assert.equal(none.recordedRounds, 0);
    assert.deepEqual(none.lineages, []);
    assert.deepEqual(none.rounds, []);
    assert.equal(none.resolutionInferred, false);

    const firstHundred = Array.from({ length: 100 }, (_, i) =>
        observation(ids[0], submissionB, String(i + 1).padStart(3, '0')));
    // Only a historical/partial import can legitimately exceed the strict
    // structured-submission limit of 30 finding observations.
    const historicalMany = { ...rounds[2] };
    const historicalFindings = firstHundred.map((f, i) => ({
        ...f, data: { ...f.data, reviewRunId: ids[2],
            findingKey: `github-review-comment:${i + 1}`, state: 'unverified',
            evidence: undefined },
    }));
    const partial = fixture({ rounds: [historicalMany],
        findings: { [ids[2]]: historicalFindings }, counts: { [ids[2]]: 101 } });
    const truncated = await partial.app.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116 }) as any;
    assert.equal(truncated.rounds[0].findingsTruncated, true);
    assert.equal(truncated.storedWindowComplete, false);
    assert.equal(truncated.rounds[0].totalFindingObservations, 101);
});

test('structured finding count is checked against original submission metadata, not active rows', async () => {
    // Generic Atlas Store archiving removes a finding from active-only query results.
    // Comparing active page.items to page.total alone falsely marked these runs complete.
    const archived = fixture({ rounds: [rounds[0]], findings: {
        [ids[0]]: [findingByRun[ids[0]][0]],
    } });
    await assert.rejects(
        archived.app.invoke('code_reviews_pr_timeline', { repository: repo, prNumber: 116 }),
        /structured review findings are incomplete/i);

    // A zero-finding structured submission is valid only with an explicit count of zero.
    const zero = { ...rounds[0], data: { ...rounds[0].data,
        coverage: { ...rounds[0].data.coverage, findingCount: 0 } } };
    const complete = fixture({ rounds: [zero], findings: { [ids[0]]: [] } });
    const result = await complete.app.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116 }) as any;
    assert.equal(result.rounds[0].totalFindingObservations, 0);
    assert.equal(result.storedWindowComplete, true);

    for (const count of [undefined, null, -1, 1.5, '2', 31, 0]) {
        const invalid = { ...rounds[0], data: { ...rounds[0].data,
            coverage: { ...rounds[0].data.coverage, findingCount: count } } };
        const app = fixture({ rounds: [invalid] }).app;
        await assert.rejects(app.invoke('code_reviews_pr_timeline',
            { repository: repo, prNumber: 116 }), /structured review findings are incomplete/i);
    }

    // Legacy historical imports never declare the structured count contract.
    const historical = fixture({ rounds: [rounds[2]] }).app;
    const imported = await historical.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116 }) as any;
    assert.equal(imported.rounds[0].findingCoverage, 'historical_partial');
    assert.equal(imported.rounds[0].totalFindingObservations, 1);
});

test('malformed, mismatched and duplicate lineage observations fail closed', async () => {
    const duplicate = fixture({ rounds: [rounds[0]], findings: {
        [ids[0]]: [observation(ids[0], submissionB, '1', 'same-root'),
            observation(ids[0], submissionB, '2', 'same-root')],
    } });
    await assert.rejects(duplicate.app.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116 }), /duplicate lineage/i);
    const crossRun = fixture({ rounds: [rounds[0]], findings: {
        [ids[0]]: [observation(ids[1], submissionB, '1', 'same-root'),
            observation(ids[0], submissionB, '2')],
    } });
    await assert.rejects(crossRun.app.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116 }), /mismatched finding/i);
    const falseAssertion = fixture({ rounds: [rounds[2]], findings: {
        [ids[2]]: [{ ...findingByRun[ids[2]][0], data: {
            ...findingByRun[ids[2]][0].data, evidence: { lineageKey: 'claimed-root' },
        } }],
    } });
    await assert.rejects(falseAssertion.app.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116 }), /unsupported lineage assertion/i);
    const incomplete = fixture({ rounds: [rounds[0]], counts: { [ids[0]]: 3 } });
    await assert.rejects(incomplete.app.invoke('code_reviews_pr_timeline',
        { repository: repo, prNumber: 116 }), /incomplete finding page/i);
});
