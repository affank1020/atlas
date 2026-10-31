import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubInlineDiffReader, InlineThreadPreflightService, verifiedAddedRightLines }
    from '../apps/server/src/apps/inline-thread-preflight.js';
import { CodeReviewsService, codeReviewsApplication } from '../apps/server/src/apps/code-reviews.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';

const repository = 'affank1020/atlas';
const prNumber = 124;
const head = 'a'.repeat(40);
const submissionId = '76894d70-4b4d-481b-9d68-e05b1e536b01';
const runId = 'c827a293-24fa-48bb-8f54-7c998c482101';
const reviewedAt = '2026-10-30T18:00:00Z';
const patch = '@@ -1,2 +1,4 @@\n original\n+added A\n+added B\n unchanged';
const file = { filename: 'src/a.ts', status: 'modified',
    additions: 2, deletions: 0, changes: 2, patch };
const run = {
    id: runId, data: { repository, prNumber, headSha: head, reviewedAt,
        verdict: 'changes_requested', coverage: {
            source: 'atlas_structured_submission', submissionId,
            findingCount: 5,
            lifecycleResolutions: [{
                lineageKey: 'old-root', state: 'resolved',
                evidence: 'The new verification suite confirms the root cause is addressed.',
                assessedHeadSha: head, assertedAt: reviewedAt,
                assessmentSource: 'authenticated_structured_submission',
            }],
        } },
};
const observation = (id: number, localKey: string, state: 'new' | 'persisting' = 'new',
    path?: string, line?: number, lineage?: string) => ({
    id: `c827a293-24fa-48bb-8f54-${String(id).padStart(12, '0')}`,
    data: {
        reviewRunId: runId, findingKey: `structured:${submissionId}:${localKey}`,
        title: 'Verified observation ' + localKey, severity: 'sev3',
        description: 'A concrete code-level issue',
        state,
        ...(path && { filePath: path }), ...(line && { line }),
        evidence: { source: 'atlas_structured_submission', localKey,
            ...(lineage && { lineageKey: lineage }),
            ...(state === 'persisting' && {
                lifecycleAssessment: {
                    state, evidence: 'The prior issue still reproduces at the reviewed SHA.',
                    assessedHeadSha: head, assertedAt: reviewedAt,
                    assessmentSource: 'authenticated_structured_submission',
                },
            }),
        },
    },
});
const observations = [
    observation(1, 'fresh', 'new', 'src/a.ts', 2, 'new-root'),
    observation(2, 'duplicate-a', 'new', 'src/a.ts', 3),
    observation(3, 'duplicate-b', 'new', 'src/a.ts', 3),
    observation(4, 'persisting', 'persisting', 'src/a.ts', 4, 'older-root'),
    observation(5, 'missing-position'),
];

function mockCatalog(options: { runs?: any[]; findings?: any[] } = {}) {
    const calls: any[] = [];
    const rows = options.runs ?? [run], issues = options.findings ?? observations;
    return {
        calls,
        listStores: async (projectId: string) => {
            assert.equal(projectId, CODE_REVIEWS_PROJECT_ID);
            return [{ id: 'runs', name: 'Review Runs' }, { id: 'findings', name: 'Review Findings' }];
        },
        queryRecords: async (input: any) => {
            calls.push(input);
            assert.equal(input.projectId, CODE_REVIEWS_PROJECT_ID);
            if (input.storeId === 'runs') {
                assert.deepEqual(input.filters, [{ field: 'prNumber', operator: 'eq', value: prNumber }]);
                assert.equal(input.limit, 100);
                return { items: rows, total: rows.length };
            }
            assert.equal(input.storeId, 'findings');
            assert.deepEqual(input.filters, [{ field: 'reviewRunId', operator: 'eq', value: runId }]);
            return { items: issues, total: issues.length };
        },
    };
}

test('diff parser verifies each complete hunk and only added RIGHT-side lines', () => {
    assert.deepEqual([...verifiedAddedRightLines(patch, 2, 0)!], [2, 3]);
    assert.deepEqual([...verifiedAddedRightLines(
        '@@ -4,1 +4,1 @@\n-old\n+new\n@@ -9,1 +9,2 @@\n context\n+newer', 2, 1)!], [4, 10]);
    assert.equal(verifiedAddedRightLines(patch, 1, 0), null, 'truncated/incorrect total');
    assert.equal(verifiedAddedRightLines('@@ -1,1 +1,2 @@\n context', 1, 0), null,
        'incomplete hunk cannot give a candidate');
    assert.equal(verifiedAddedRightLines('not a patch', 1, 0), null);
    assert.equal(verifiedAddedRightLines('@@ -1,0 +1,1 @@\n+new', 1, 0)?.has(1), true);
});

function githubFixture(options: {
    remoteHead?: string; changedHead?: string; files?: unknown[];
    state?: 'open' | 'closed';
} = {}) {
    const requests: { url: string; method: string }[] = [];
    let prReads = 0;
    const reader = new GitHubInlineDiffReader({
        pullRequestReadToken: async (repo: string) => {
            assert.equal(repo, repository);
            return 'github-read-token';
        },
    }, (async (url: string, request: RequestInit) => {
        requests.push({ url, method: request.method! });
        assert.equal(request.method, 'GET');
        assert.equal((request.headers as any).Authorization, 'Bearer github-read-token');
        assert.equal(request.body, undefined, 'no post, patch or body is allowed');
        if (url.endsWith('/pulls/124')) {
            prReads++;
            return new Response(JSON.stringify({
                number: prNumber, state: options.state ?? 'open',
                base: { repo: { full_name: repository } },
                head: { sha: prReads === 2 ? options.changedHead ?? options.remoteHead ?? head :
                    options.remoteHead ?? head },
            }), { status: 200 });
        }
        if (!url.endsWith('/pulls/124/files?per_page=100&page=1'))
            throw Error('Unexpected GitHub URL ' + url);
        return new Response(JSON.stringify(options.files ?? [file]), { status: 200 });
    }) as typeof fetch);
    return { reader, requests };
}

test('GitHub diff reader uses only scoped GET, checks full file metadata and verifies PR head twice', async () => {
    const { reader, requests } = githubFixture();
    const result = await reader.inspect('Affank1020/Atlas', prNumber);
    assert.equal(result.headSha, head);
    assert.equal(result.open, true);
    assert.equal(result.files[0]!.path, 'src/a.ts');
    assert.deepEqual([...result.files[0]!.lines!], [2, 3]);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(x => x.method === 'GET'));
    await assert.rejects(githubFixture({ changedHead: 'b'.repeat(40) })
        .reader.inspect(repository, prNumber), /changed during/);
    await assert.rejects(githubFixture({ files: Array.from({ length: 100 }, () => file) })
        .reader.inspect(repository, prNumber), /may be incomplete/);
    await assert.rejects(githubFixture({ files: [{ ...file, changes: 3 }] })
        .reader.inspect(repository, prNumber), /metadata is invalid/);
    const omittedPatch = await githubFixture({ files: [{ ...file, patch: undefined }] })
        .reader.inspect(repository, prNumber);
    assert.equal(omittedPatch.files[0]!.lines, null, 'missing patch never verifies a line');
});

test('preflight classifies new line candidates but never authorizes thread publication', async () => {
    const catalog = mockCatalog();
    const preflight = new InlineThreadPreflightService(catalog as any, githubFixture().reader);
    const app = new ApplicationRegistry([codeReviewsApplication(new CodeReviewsService(
        catalog as any, undefined, new Map(), undefined, undefined, undefined, preflight))]);
    const result = await app.invoke('code_reviews_inline_thread_preflight', {
        repository: 'Affank1020/Atlas', prNumber,
    }) as any;
    assert.equal(result.dryRun, true);
    assert.equal(result.publicationSupported, false);
    assert.equal(result.status, 'review_head_current');
    assert.equal(result.runId, runId);
    assert.equal(result.recordedRounds, 1);
    assert.deepEqual(result.findings.map((f: any) => f.reason), [
        'verified_new_line_candidate',
        'multiple_findings_share_anchor',
        'multiple_findings_share_anchor',
        'existing_thread_identity_required',
        'no_exact_diff_location',
    ]);
    assert.deepEqual(result.findings.map((f: any) => f.classification), [
        'candidate', 'summary_only', 'summary_only', 'summary_only', 'summary_only',
    ]);
    assert.equal(result.findings[0].requiresPublisherIdentityAndDeduplication, true);
    assert.equal(result.resolutions[0].classification, 'existing_thread_identity_required');
    assert.equal(result.resolutions[0].reviewerAssertionOnly, true);
    assert.equal(catalog.calls.length, 2);
});

test('outdated or closed PRs never yield new inline anchors', async () => {
    const a = new InlineThreadPreflightService(mockCatalog() as any,
        githubFixture({ remoteHead: 'b'.repeat(40) }).reader);
    const outdated = await a.preview(repository, prNumber) as any;
    assert.equal(outdated.status, 'review_head_outdated');
    assert.ok(outdated.findings.every((f: any) => f.reason === 'review_head_outdated'));
    const closed = new InlineThreadPreflightService(mockCatalog() as any,
        githubFixture({ state: 'closed' }).reader);
    const result = await closed.preview(repository, prNumber) as any;
    assert.equal(result.status, 'pr_closed');
    assert.ok(result.findings.every((f: any) => f.reason === 'pr_closed'));
});

test('historical review snapshots are summary-only, never trusted current new threads', async () => {
    const historical = { ...run, data: {
        ...run.data, coverage: { source: 'github_pull_request_review' },
    } };
    const imported = [observation(1, 'fresh')].map(x => ({ ...x, data: {
        ...x.data, state: 'unverified', findingKey: 'github-review-comment:42',
        evidence: { source: 'github_inline_review_comment' },
    } }));
    const catalog = mockCatalog({ runs: [historical], findings: imported });
    const preview = new InlineThreadPreflightService(catalog as any, githubFixture().reader);
    const result = await preview.preview(repository, prNumber) as any;
    assert.equal(result.source, 'historical');
    assert.equal(result.completeStructuredEvidence, false);
    assert.equal(result.findings[0].reason, 'historical_or_partial_evidence');
});

test('no saved review returns an explicit unknown result without calling GitHub', async () => {
    const catalog = mockCatalog({ runs: [] });
    const preview = new InlineThreadPreflightService(catalog as any, {
        inspect: async () => { throw Error('GitHub must not be called for missing review'); },
    } as any);
    const result = await preview.preview(repository, prNumber) as any;
    assert.equal(result.status, 'no_saved_review');
    assert.equal(result.recordedRounds, 0);
    assert.deepEqual(result.findings, []);
    assert.equal(result.publicationSupported, false);
});
