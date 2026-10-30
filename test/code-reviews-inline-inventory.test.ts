import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubInlineThreadReader, InlineThreadInventoryService, inlineThreadMarker }
    from '../apps/server/src/apps/inline-thread-inventory.js';
import { CodeReviewsService, codeReviewsApplication } from '../apps/server/src/apps/code-reviews.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';

const repository = 'affank1020/atlas';
const prNumber = 125;
const runId = 'c827a293-24fa-48bb-8f54-7c998c482101';
const submissionId = '76894d70-4b4d-481b-9d68-e05b1e536b01';
const sha = 'a'.repeat(40);
const timestamp = '2026-10-30T18:00:00Z';
const botId = 89123;
const marker = inlineThreadMarker(repository, prNumber, 'root-a');
const markerB = inlineThreadMarker(repository, prNumber, 'root-b');
const root = (id: number, body = 'Observed root cause.\n' + marker, overrides: object = {}) => ({
    id, body, path: 'src/a.ts', original_commit_id: sha, original_line: 12,
    line: null, user: { id: botId, type: 'Bot' }, ...overrides,
});
const reply = (id: number, parentId: number, body = 'An author replied.') => ({
    id, in_reply_to_id: parentId, body,
    user: { id: 777, type: 'User' }, path: 'src/a.ts',
});

function githubFixture(pages: unknown[][], identity = botId) {
    const requests: { url: string; method: string }[] = [];
    const reader = new GitHubInlineThreadReader({
        pullRequestReadToken: async (repo: string) => {
            assert.equal(repo, repository); return 'read-token';
        },
        reviewPublisherBot: async (repo: string) => {
            assert.equal(repo, repository); return { id: identity };
        },
    } as any, (async (url: string, init: RequestInit) => {
        assert.equal(init.method, 'GET');
        assert.equal(init.body, undefined);
        assert.equal((init.headers as any).Authorization, 'Bearer read-token');
        requests.push({ url, method: init.method! });
        const index = Number(new URL(url).searchParams.get('page')) - 1;
        return new Response(JSON.stringify(pages[index] ?? []), { status: 200 });
    }) as typeof fetch);
    return { reader, requests };
}

test('stable opaque identity is canonical and cannot be copied across PR or lineage', () => {
    assert.equal(inlineThreadMarker('Affank1020/Atlas', prNumber, 'root-a'), marker);
    assert.notEqual(inlineThreadMarker(repository, prNumber + 1, 'root-a'), marker);
    assert.notEqual(inlineThreadMarker(repository, prNumber, 'root-b'), marker);
    assert.match(marker, /^<!-- atlas-code-reviews-thread:v1:[0-9a-f]{64} -->$/);
    assert.throws(() => inlineThreadMarker('../atlas', prNumber, 'root-a'));
    assert.throws(() => inlineThreadMarker(repository, prNumber, '../invalid '));
    assert.throws(() => inlineThreadMarker(repository, 0, 'root-a'));
});

test('bounded multi-page reader verifies Bot-owned root, ignores copied human marker and counts replies', async () => {
    const first = [root(110), ...Array.from({ length: 99 }, (_, i) =>
        ({ id: i + 200, body: 'Unrelated discussion', user: { id: 777, type: 'User' } }))];
    const { reader, requests } = githubFixture([first, [
        reply(400, 110),
        root(401, 'An impostor copied the marker.\n' + marker,
            { user: { id: 777, type: 'User' } }),
    ]]);
    const result = await reader.inspect('Affank1020/Atlas', prNumber);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(x => x.url.includes('/pulls/125/comments?per_page=100')));
    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0]!.id, 110);
    assert.equal(result.roots[0]!.currentLine, null,
        'outdated GitHub line null does not mean reviewer-verified resolution');
    assert.equal(result.roots[0]!.originalLine, 12);
    assert.equal(result.roots[0]!.originalCommitSha, sha);
    assert.match(result.roots[0]!.url, /#discussion_r110$/);
    assert.equal(result.replies.get(110), 1);
    assert.deepEqual(result.copiedMarkers, [marker]);
});

test('duplicate owned roots, copied Bot reply and missing reply parents are conflicts', async () => {
    await assert.rejects(githubFixture([[root(110), root(111)]]).reader.inspect(repository, prNumber),
        /conflicting identity/);
    await assert.rejects(githubFixture([[root(110),
        root(112, 'A misleading reply.\n' + marker, { in_reply_to_id: 110 })]])
        .reader.inspect(repository, prNumber), /conflicting identity/);
    await assert.rejects(githubFixture([[root(110), reply(113, 999)]])
        .reader.inspect(repository, prNumber), /absent root/);
    const copiedOnly = await githubFixture([[
        root(401, 'Someone copied this marker.\n' + marker,
            { user: { id: 777, type: 'User' } }),
    ]]).reader.inspect(repository, prNumber);
    assert.equal(copiedOnly.roots.length, 0, 'a marker alone is not proof of ownership');
    assert.deepEqual(copiedOnly.copiedMarkers, [marker]);
});

test('ambiguous full final page, invalid owned marker and invalid Bot ID fail closed', async () => {
    const fillers = Array.from({ length: 100 }, (_, i) =>
        ({ id: i + 1, body: 'Ordinary review', user: { id: 777, type: 'User' } }));
    await assert.rejects(githubFixture(Array.from({ length: 5 }, (_, page) =>
        fillers.map(x => ({ ...x, id: x.id + page * 100 }))))
        .reader.inspect(repository, prNumber), /exceeds five/);
    await assert.rejects(githubFixture([[
        root(110, 'Malformed <!-- atlas-code-reviews-thread:v1:wrong -->'),
    ]]).reader.inspect(repository, prNumber), /unsupported format/);
    await assert.rejects(githubFixture([[root(110)]], 0)
        .reader.inspect(repository, prNumber), /Bot identity/);
});

const run = {
    id: runId, data: { repository, prNumber, headSha: sha, reviewedAt: timestamp,
        verdict: 'non_blocking', coverage: {
            source: 'atlas_structured_submission', submissionId, findingCount: 3,
            lifecycleResolutions: [{
                lineageKey: 'root-a', state: 'resolved',
                evidence: 'Tests now verify this root cause on the newly reviewed commit.',
                assessedHeadSha: sha, assertedAt: timestamp,
                assessmentSource: 'authenticated_structured_submission',
            }],
        },
    },
};
function finding(id: number, localKey: string, state: 'new' | 'persisting',
    lineageKey?: string) {
    return {
        id: 'c827a293-24fa-48bb-8f54-' + String(id).padStart(12, '0'),
        data: { reviewRunId: runId,
            findingKey: 'structured:' + submissionId + ':' + localKey,
            title: 'Code review finding', severity: 'sev3',
            description: 'A concrete problem with the reviewed code.',
            state,
            evidence: { source: 'atlas_structured_submission', localKey,
                ...(lineageKey && { lineageKey }),
                ...(state === 'persisting' && { lifecycleAssessment: {
                    state, evidence: 'The previous issue still reproduces on this SHA.',
                    assessedHeadSha: sha, assertedAt: timestamp,
                    assessmentSource: 'authenticated_structured_submission',
                } }),
            },
        },
    };
}
function catalogFixture(overrides: { runs?: any[]; findings?: any[] } = {}) {
    const runs = overrides.runs ?? [run];
    const findings = overrides.findings ?? [
        finding(1, 'a', 'new', 'root-a'),
        finding(2, 'b', 'persisting', 'root-b'),
        finding(3, 'c', 'new'),
    ];
    const calls: any[] = [];
    return {
        calls,
        listStores: async (id: string) => {
            assert.equal(id, CODE_REVIEWS_PROJECT_ID);
            return [{ id: 'runs', name: 'Review Runs' },
                { id: 'findings', name: 'Review Findings' }];
        },
        queryRecords: async (args: any) => {
            calls.push(args);
            assert.equal(args.projectId, CODE_REVIEWS_PROJECT_ID);
            if (args.storeId === 'runs') {
                assert.deepEqual(args.filters, [{ field: 'prNumber', operator: 'eq', value: prNumber }]);
                assert.equal(args.limit, 100);
                return { items: runs, total: runs.length };
            }
            assert.equal(args.storeId, 'findings');
            assert.deepEqual(args.filters, [{ field: 'reviewRunId', operator: 'eq', value: runId }]);
            return { items: findings, total: findings.length };
        },
    };
}

test('MCP inventory matches explicit roots and resolutions but never infers GitHub resolution', async () => {
    const catalog = catalogFixture();
    const github = {
        inspect: async (repo: string, pr: number) => {
            assert.equal(repo, repository); assert.equal(pr, prNumber);
            return { roots: [
                { id: 110, marker, path: 'src/a.ts', originalCommitSha: sha,
                    originalLine: 12, currentLine: null,
                    url: 'https://github.com/affank1020/atlas/pull/125#discussion_r110' },
                { id: 120, marker: inlineThreadMarker(repository, prNumber, 'older-root'),
                    path: 'src/old.ts', originalCommitSha: sha, originalLine: 4, currentLine: 4,
                    url: 'https://github.com/affank1020/atlas/pull/125#discussion_r120' },
            ], copiedMarkers: [markerB], replies: new Map([[110, 2]]) };
        },
    };
    const service = new InlineThreadInventoryService(catalog as any, github as any);
    const app = new ApplicationRegistry([codeReviewsApplication(new CodeReviewsService(
        catalog as any, undefined, new Map(), undefined, undefined, undefined, undefined, service))]);
    const result = await app.invoke('code_reviews_inline_thread_inventory',
        { repository: 'Affank1020/Atlas', prNumber }) as any;
    assert.equal(result.dryRun, true);
    assert.equal(result.publicationSupported, false);
    assert.equal(result.recordedRounds, 1);
    assert.equal(result.ownedRootCount, 2);
    assert.equal(result.unlinkedOwnedRootCount, 1, 'older threads are preserved, not considered resolved');
    assert.equal(result.findings[0].state, 'owned_thread_found');
    assert.equal(result.findings[0].rootCommentId, 110);
    assert.equal(result.findings[0].findingState, 'new');
    assert.equal(result.findings[0].resolutionState, 'unknown');
    assert.equal(result.findings[0].observedReplyCount, 2);
    assert.equal(result.findings[1].state, 'no_owned_thread');
    assert.equal(result.findings[1].copiedMarkerFromOtherAuthor, true);
    assert.equal(result.findings[2].state, 'missing_stable_lineage');
    assert.equal(result.resolutions[0].assessment, 'reviewer_asserted_resolved');
    assert.equal(result.resolutions[0].state, 'owned_thread_found');
    assert.equal(result.resolutions[0].resolutionState, 'unknown');
    assert.equal(catalog.calls.length, 2);
});

test('imported historical observations cannot claim structured lineage or owned threads', async () => {
    const historical = { ...run, data: {
        ...run.data, coverage: { source: 'github_pull_request_review' },
    } };
    const imported = [{ ...finding(1, 'a', 'new'), data: {
        ...finding(1, 'a', 'new').data,
        state: 'unverified', findingKey: 'github-review-comment:54',
        evidence: { source: 'github_inline_review_comment' },
    } }];
    const catalog = catalogFixture({ runs: [historical], findings: imported });
    const preview = new InlineThreadInventoryService(catalog as any, {
        inspect: async () => ({ roots: [], copiedMarkers: [], replies: new Map() }),
    } as any);
    const result = await preview.preview(repository, prNumber) as any;
    assert.equal(result.source, 'historical');
    assert.equal(result.completeStructuredEvidence, false);
    assert.equal(result.findings[0].state, 'historical_or_partial_evidence');
});

test('missing Atlas history is explicitly unknown and performs no GitHub lookup', async () => {
    const catalog = catalogFixture({ runs: [] });
    const preview = new InlineThreadInventoryService(catalog as any, {
        inspect: async () => { throw Error('No GitHub read permitted when there is no saved round'); },
    } as any);
    const result = await preview.preview(repository, prNumber) as any;
    assert.equal(result.status, 'no_saved_review');
    assert.equal(result.publicationSupported, false);
});
