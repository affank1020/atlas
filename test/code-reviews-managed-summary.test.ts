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
    assert.match(output.body, /Unvalidated &lt;!-- user input/);
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
    assert.throws(() => managedSummaryMarker('../repo', 118));
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
                assert.deepEqual(query.filters, [
                    { field: 'repository', operator: 'eq', value: repository },
                    { field: 'prNumber', operator: 'eq', value: prNumber },
                ]);
                assert.equal(query.limit, 1);
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
    assert.equal(calls.length, 2);
    assert.equal(lookups, 1);
    await assert.rejects(app.invoke('code_reviews_managed_summary_preview', {
        repository, prNumber: -1,
    }));
});
