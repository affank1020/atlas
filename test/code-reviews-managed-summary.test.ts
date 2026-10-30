import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubManagedSummaryReader, ManagedSummaryPreviewService,
    managedSummaryMarker, renderManagedSummary } from '../apps/server/src/apps/managed-summary.js';
import { CodeReviewsService, codeReviewsApplication } from '../apps/server/src/apps/code-reviews.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';

const repository = 'affank1020/atlas';
const prNumber = 118;
const head = 'a'.repeat(40);
const runId = 'c827a293-24fa-48bb-8f54-7c998c482101';
const submission = '76894d70-4b4d-481b-9d68-e05b1e536b01';
const run = { id: runId, data: { repository, prNumber, headSha: head,
    reviewedAt: '2026-10-30T16:00:00Z', verdict: 'changes_requested',
    coverage: { source: 'atlas_structured_submission', submissionId: submission, findingCount: 1 } } };
const finding = { id: 'c827a293-24fa-48bb-8f54-7c998c482102', data: {
    reviewRunId: runId, findingKey: `structured:${submission}:bad-input`,
    severity: 'sev3', title: 'Unvalidated <!-- user input',
    description: 'Missing validation', state: 'new',
    evidence: { source: 'atlas_structured_submission', localKey: 'bad-input', lineageKey: 'input-root' },
} };
function round(overrides: Record<string, unknown> = {}) {
    return { runId, headSha: head, reviewedAt: '2026-10-30T16:00:00Z',
        verdict: 'changes_requested', source: 'structured',
        findingCoverage: 'structured', findingsTruncated: false, totalFindingObservations: 1,
        findings: [{ id: finding.id, runId, findingKey: finding.data.findingKey,
            lineageKey: 'input-root', severity: 'sev3', title: finding.data.title,
            description: finding.data.description, state: 'new' }],
        resolutions: [], ...overrides };
}

test('managed summary renders bounded latest saved structured evidence, without inventing fixes', () => {
    const output = renderManagedSummary(repository, prNumber, round() as any, 4);
    assert.equal(output.marker, managedSummaryMarker(repository, prNumber));
    assert.ok(output.body.endsWith(output.marker));
    assert.match(output.body, /Sev3 1/);
    assert.match(output.body, /new 1/);
    assert.match(output.body, /4 rounds recorded in Atlas/);
    assert.doesNotMatch(output.body, /Unvalidated <!--/);
    assert.match(output.body, /Unvalidated &lt;/);
    assert.doesNotMatch(output.body, /Unvalidated <!--/);
    assert.ok(output.body.includes('user input'));
    assert.match(output.body, /absence is not evidence|does not become fixed/);
    assert.equal(output.fullEvidence, true);

    const resolution = renderManagedSummary(repository, prNumber, round({
        findings: [], totalFindingObservations: 0,
        resolutions: [{ lineageKey: 'input-root', state: 'resolved',
            evidence: 'Verified with the new regression at the reviewed head.' }],
    }) as any, 5);
    assert.match(resolution.body, /reviewer-asserted resolved 1/);
    assert.match(resolution.body, /Verified with the new regression/);
    const imported = renderManagedSummary(repository, prNumber, round({
        source: 'historical', findingCoverage: 'historical_partial',
    }) as any, 1);
    assert.equal(imported.fullEvidence, false);
    assert.match(imported.body, /Complete severity and lifecycle totals unavailable/);
    assert.doesNotMatch(imported.body, /Severity observations:/);
    for (const invalid of ['../repo', './repo', 'owner/..', 'owner/.', 'owner/repo/path',
        'owner//repo', 'owner/repo?x=1']) {
        assert.throws(() => managedSummaryMarker(invalid, 118), /Invalid managed summary/);
    }
    assert.equal(managedSummaryMarker('Affank1020/Atlas', 118),
        managedSummaryMarker(repository, 118));
});

test('Markdown payloads remain inside one finding and code spans retain literal backticks', () => {
    const newline = String.fromCharCode(10);
    const slash = String.fromCharCode(92);
    const result = renderManagedSummary(repository, prNumber, round({
        findings: [{ ...round().findings[0],
            title: ['Incomplete **', '## Forged approval', '> [!TIP] <!-- injected'].join(newline),
            filePath: ['src/review`part``other.ts', '## Unsafe'].join(newline),
            lineageKey: 'issue`with``ticks' }],
        resolutions: [{ lineageKey: 'issue`with``ticks', state: 'resolved',
            evidence: ['Source evidence', '## New fake summary',
                '[admin](https://example.com) **'].join(newline) }],
    }) as any, 2);
    assert.ok(!result.body.includes(newline + '## Forged approval'));
    assert.ok(!result.body.includes(newline + '## New fake summary'));
    assert.ok(!result.body.includes(newline + '> [!TIP]'));
    assert.ok(result.body.includes('Incomplete ' + slash + '*' + slash + '*'));
    assert.ok(result.body.includes(slash + '#' + slash + '# Forged approval'));
    assert.ok(result.body.includes('&gt; ' + slash + '[' + slash + '!TIP' + slash + ']'));
    assert.ok(result.body.includes('``` src/review`part``other.ts ## Unsafe ```'));
    assert.ok(result.body.includes('``` issue`with``ticks ```'));
    assert.ok(!result.body.includes(newline + '[admin]('));
    assert.ok(result.body.endsWith(managedSummaryMarker(repository, prNumber)));
});

function githubReader(pages: unknown[][], botId = 77) {
    const calls: string[] = [];
    const mock = async (url: string) => {
        calls.push(url);
        const page = Number(new URL(url).searchParams.get('page'));
        return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
    };
    const reader = new GitHubManagedSummaryReader({
        pullRequestReadToken: async () => 'read-token',
        reviewPublisherBot: async () => ({ id: botId, login: 'atlas[bot]' }),
    }, mock as typeof fetch);
    return { reader, calls };
}
const botComment = (id: number, body: string, userId = 77) => ({
    id, body, user: { id: userId, type: 'Bot' },
    html_url: 'https://evil.example/comment',
});
test('managed summary lookup verifies Bot ID and exact PR marker, ignores human impersonators', async () => {
    const body = renderManagedSummary(repository, prNumber, round() as any, 1).body;
    const { reader, calls } = githubReader([[
        botComment(1, body, 45),
        { id: 2, body, user: { id: 45, type: 'User' } },
        botComment(41, body),
    ]]);
    const found = await reader.inspect(repository, prNumber, body);
    assert.equal(found.status, 'current');
    assert.equal(found.commentId, 41);
    assert.equal(found.commentUrl, 'https://github.com/affank1020/atlas/pull/118#issuecomment-41');
    assert.equal(calls.length, 1);
    const outdated = await githubReader([[botComment(41, 'old content\\n' +
        managedSummaryMarker(repository, prNumber))]]).reader.inspect(repository, prNumber, body);
    assert.equal(outdated.status, 'needs_update');
    const missing = await githubReader([[botComment(12, body, 55)]])
        .reader.inspect(repository, prNumber, body);
    assert.equal(missing.status, 'no_owned_comment');
});

test('duplicate or corrupted owned markers fail closed, even if they appear on later pages', async () => {
    const body = renderManagedSummary(repository, prNumber, round() as any, 1).body;
    const hundred = Array.from({ length: 100 }, (_, i) =>
        botComment(i + 1, 'unrelated comment ' + i, 55));
    const reader = githubReader([[...hundred.slice(0, 99), botComment(3, body)], [
        botComment(4, body),
    ]]).reader;
    await assert.rejects(reader.inspect(repository, prNumber, body), /Multiple App-owned/);
    const tampered = githubReader([[botComment(1, body + '\\nmore')]]).reader;
    await assert.rejects(tampered.inspect(repository, prNumber, body), /invalid identity or content/);
    const fiveFullPages = Array.from({ length: 5 }, () => hundred);
    await assert.rejects(githubReader(fiveFullPages).reader.inspect(repository, prNumber, body),
        /inspection window/);
    await assert.rejects(githubReader([[]]).reader.inspect(repository, prNumber, body + 'spoof'),
        /invalid identity marker/);
});

test('managed summary is read-only and scoped to one PR and its stored findings', async () => {
    const calls: any[] = [];
    let lookups = 0;
    const catalog = {
        listStores: async (projectId: string) => {
            assert.equal(projectId, CODE_REVIEWS_PROJECT_ID);
            return [{ id: 'runs', name: 'Review Runs' }, { id: 'findings', name: 'Review Findings' }];
        },
        queryRecords: async (query: any) => {
            calls.push(query);
            assert.equal(query.projectId, CODE_REVIEWS_PROJECT_ID);
            if (query.storeId === 'runs') {
                // Legacy GitHub imports may have retained uppercase names.
                // The managed preview scans a bounded PR-number window and
                // enforces canonical full repository identity before display.
                assert.deepEqual(query.filters, [
                    { field: 'prNumber', operator: 'eq', value: prNumber },
                ]);
                assert.equal(query.limit, 100, 'bounded historical scan reads one 100-row page');
                assert.equal(query.offset, 0);
                return { items: [run], total: 1 };
            }
            assert.equal(query.storeId, 'findings');
            assert.deepEqual(query.filters, [
                { field: 'reviewRunId', operator: 'eq', value: runId },
            ]);
            return { items: [finding], total: 1 };
        },
    };
    const preview = new ManagedSummaryPreviewService(catalog as any, {
        inspect: async (repo: string, pr: number, body: string) => {
            lookups++;
            assert.equal(repo, repository);
            assert.equal(pr, prNumber);
            assert.match(body, /Sev3 1/);
            return { status: 'no_owned_comment' };
        },
    } as any);
    const service = new CodeReviewsService(catalog as any, undefined, new Map(), undefined, preview);
    const app = new ApplicationRegistry([codeReviewsApplication(service)]);
    const result = await app.invoke('code_reviews_managed_summary_preview', { repository, prNumber }) as any;
    assert.equal(result.dryRun, true);
    assert.equal(result.publishSupported, false);
    assert.equal(result.remote.status, 'no_owned_comment');
    assert.equal(result.recordedRounds, 1);
    assert.equal(result.runId, runId, 'summary still selects only the latest matching round');
    assert.equal(calls.length, 2);
    assert.equal(lookups, 1);
    const normalized = await app.invoke('code_reviews_managed_summary_preview',
        { repository: 'Affank1020/Atlas', prNumber }) as any;
    assert.equal(normalized.repository, repository, 'canonical Store identity is returned');
    assert.equal(normalized.remote.status, 'no_owned_comment');
    assert.equal(calls.length, 4, 'mixed-case request still finds the saved structured run');
    assert.equal(lookups, 2, 'canonical GitHub repository is used for inspection');
    await assert.rejects(app.invoke('code_reviews_managed_summary_preview', {
        repository: '../repo', prNumber,
    }), /Invalid managed summary/);
    await assert.rejects(app.invoke('code_reviews_managed_summary_preview', {
        repository, prNumber: -1,
    }));
});

test('mixed-case historical imports remain visible and count with canonical structured rounds', async () => {
    const oldRunId = '9f012b46-779d-44a4-aea8-4d24b6204528';
    const unrelatedId = '67b448dc-1b56-43ab-87a4-47f05735b0a7';
    const history = { id: oldRunId, data: {
        repository: 'Affank1020/Atlas', prNumber, headSha: 'b'.repeat(40),
        reviewedAt: '2026-10-30T18:00:00Z', verdict: 'non_blocking',
        coverage: { source: 'github_pull_request_review' },
    } };
    const anotherOwner = { id: unrelatedId, data: {
        repository: 'someone-else/atlas', prNumber, headSha: 'c'.repeat(40),
        reviewedAt: '2026-10-30T19:00:00Z', verdict: 'no_findings',
        coverage: { source: 'github_pull_request_review' },
    } };
    // Sorted as PostgreSQL returns it: newest other-owner PR first,
    // followed by an older mixed-case import and then structured review.
    const rows = [anotherOwner, history, run];
    const calls: any[] = [];
    const catalogue = {
        listStores: async () => [
            { id: 'runs', name: 'Review Runs' },
            { id: 'findings', name: 'Review Findings' },
        ],
        queryRecords: async (input: any) => {
            calls.push(input);
            assert.equal(input.projectId, CODE_REVIEWS_PROJECT_ID);
            if (input.storeId === 'runs') {
                assert.deepEqual(input.filters, [
                    { field: 'prNumber', operator: 'eq', value: prNumber },
                ]);
                const page = rows.slice(input.offset, input.offset + input.limit);
                return { items: page, total: rows.length };
            }
            assert.equal(input.storeId, 'findings');
            assert.deepEqual(input.filters, [
                { field: 'reviewRunId', operator: 'eq', value: oldRunId },
            ]);
            return { items: [], total: 0 };
        },
    };
    const preview = new ManagedSummaryPreviewService(catalogue as any, {
        inspect: async (repo: string, pr: number, body: string) => {
            assert.equal(repo, repository);
            assert.equal(pr, prNumber);
            assert.ok(body.includes('Historical import'));
            return { status: 'no_owned_comment' };
        },
    } as any);
    for (const requested of [repository, 'Affank1020/Atlas']) {
        const result = await preview.preview(requested, prNumber) as any;
        assert.equal(result.repository, repository);
        assert.equal(result.recordedRounds, 2, 'same-number PR in another repository must not count');
        assert.equal(result.runId, oldRunId, 'newest matching historical review must be selected');
        assert.equal(result.source, 'historical');
        assert.equal(result.fullEvidence, false);
        assert.equal(result.remote.status, 'no_owned_comment');
    }
    assert.equal(calls.length, 4, 'two runs lookups and two latest-run findings queries');
});

test('canonical history scan rejects oversized PR-number histories rather than silently omitting old imports', async () => {
    const catalogue = {
        listStores: async () => [
            { id: 'runs', name: 'Review Runs' },
            { id: 'findings', name: 'Review Findings' },
        ],
        queryRecords: async (input: any) => {
            assert.equal(input.storeId, 'runs');
            return { total: 1001, items: [] };
        },
    };
    const preview = new ManagedSummaryPreviewService(catalogue as any, {
        inspect: async () => { throw Error('Remote lookup must not happen on incomplete history'); },
    } as any);
    await assert.rejects(preview.preview(repository, prNumber), /bounded canonical lookup/);
});
