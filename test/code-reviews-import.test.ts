import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { GitHubReviewHistoryReader } from '../apps/server/src/apps/github-review-history.js';
import { CodeReviewsService, codeReviewsApplication } from '../apps/server/src/apps/code-reviews.js';
import { prepareGitHubReviews, CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { databaseFixture, cleanupDatabases } from './database.js';

after(cleanupDatabases);

const repository = 'affank1020/atlas';
const head = 'a'.repeat(40);
const sampleReview = {
    id: 5613675655, body: '## 🔎 Code Reviewer · PR #69\n\n> [!NOTE]\n> **Non-blocking findings** — 1 Sev3',
    commit_id: head, submitted_at: '2026-10-22T12:20:00Z',
    state: 'COMMENTED', html_url: 'https://github.com/affank1020/atlas/pull/69#pullrequestreview-1',
    user: { login: 'affank1020' },
};
const sampleComment = {
    id: 4347948887, pull_request_review_id: sampleReview.id,
    body: '🟠 **Sev3 · Handle untrusted input**\n\nScenario: a malformed request can fail.',
    html_url: 'https://github.com/affank1020/atlas/pull/69#discussion_r4347948887',
    path: 'apps/server/src/demo.ts', line: 24, original_line: 24,
};
const source = { reviews: [sampleReview], comments: [sampleComment] };

async function fixture() {
    const { catalog, store } = await databaseFixture();
    await store.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Code Reviews',now(),now())",
        [CODE_REVIEWS_PROJECT_ID],
    );
    const runs = await catalog.createStore({ projectId: CODE_REVIEWS_PROJECT_ID, name: 'Review Runs', fields: [
        { name: 'repository', type: 'string', required: true }, { name: 'prNumber', type: 'number', required: true },
        { name: 'headSha', type: 'string', required: true }, { name: 'reviewer', type: 'string', required: true },
        { name: 'verdict', type: 'enum', required: true, enumValues: ['changes_requested','concerns_to_verify','non_blocking','no_findings','inconclusive'] },
        { name: 'reviewedAt', type: 'datetime', required: true }, { name: 'githubReviewId', type: 'string' },
        { name: 'githubReviewUrl', type: 'string' }, { name: 'coverage', type: 'object' },
        { name: 'counts', type: 'object' }, { name: 'schemaVersion', type: 'number', required: true, default: 1 },
    ]});
    const findings = await catalog.createStore({ projectId: CODE_REVIEWS_PROJECT_ID, name: 'Review Findings', fields: [
        { name: 'reviewRunId', type: 'string', required: true }, { name: 'findingKey', type: 'string', required: true },
        { name: 'severity', type: 'enum', required: true, enumValues: ['sev1','sev2','sev3','sev4'] },
        { name: 'title', type: 'string', required: true }, { name: 'description', type: 'string', required: true },
        { name: 'filePath', type: 'string' }, { name: 'line', type: 'number' },
        { name: 'state', type: 'enum', required: true, enumValues: ['new','persisting','resolved','unverified'] },
        { name: 'evidence', type: 'object' }, { name: 'githubCommentId', type: 'string' },
        { name: 'schemaVersion', type: 'number', required: true, default: 1 },
    ]});
    return { catalog, runs, findings };
}

test('historical markdown imports only recognizable Code Reviewer submissions and explicit inline severities', () => {
    const prepared = prepareGitHubReviews(repository, 69, { reviews: [
        { ...sampleReview, id: 1, body: 'Looks good\n\n## 🔎 Code Reviewer · PR #69' },
        { ...sampleReview, id: 2, body: null, submitted_at: null },
        sampleReview,
    ], comments: [sampleComment, { ...sampleComment, id: 5,
        body: 'Unlabelled suggestion', line: null, original_line: null }] });
    assert.equal(prepared.skippedUnrecognized, 2);
    assert.equal(prepared.candidates.length, 1);
    assert.equal(prepared.commentsWithoutSeverity, 1);
    const first = prepared.candidates[0]!;
    assert.equal(first.run.verdict, 'non_blocking');
    assert.equal(first.comments[0]?.finding.severity, 'sev3');
    assert.equal(first.comments[0]?.finding.state, 'unverified');
    assert.equal((first.run.coverage as any).summaryFindingsNotParsed, true);
});

test('summary banner verdict avoids interpreting old findings as the latest verdict', () => {
    const prepared = prepareGitHubReviews(repository, 69, {
        reviews: [{ ...sampleReview, id: 100, body: '## 🔎 Code Reviewer · PR #69\n\n> [!NOTE]\n> **Clean review** — no actionable issues.\n\n### Previous changes requested now resolved' }],
        comments: [],
    });
    assert.equal(prepared.candidates[0]?.run.verdict, 'no_findings');
});

test('explicit preview is read-only; applied imports are atomic and idempotent', async () => {
    const { catalog, runs, findings } = await fixture();
    const service = new CodeReviewsService(catalog, { read: async () => source });
    const api = new ApplicationRegistry([codeReviewsApplication(service)]);
    const args = { repository, prNumber: 69 };
    const preview = await api.invoke('code_reviews_import_pull_request', args) as any;
    assert.equal(preview.dryRun, true);
    assert.deepEqual([preview.runsCreated, preview.findingsCreated], [1, 1]);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id})).total,0);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id})).total,0);
    const added = await api.invoke('code_reviews_import_pull_request', {...args,apply:true}) as any;
    assert.equal(added.dryRun, false);
    assert.deepEqual([added.runsCreated, added.findingsCreated], [1,1]);
    const again = await api.invoke('code_reviews_import_pull_request', {...args,apply:true}) as any;
    assert.deepEqual([again.runsCreated, again.findingsCreated,again.runsAlreadyPresent,again.findingsAlreadyPresent],[0,0,1,1]);
    const savedRuns = await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id});
    const savedFindings = await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id});
    assert.equal(savedRuns.total, 1); assert.equal(savedFindings.total, 1);
    assert.equal(savedFindings.items[0]?.data.reviewRunId,savedRuns.items[0]?.id);
    assert.equal(savedFindings.items[0]?.data.githubCommentId,String(sampleComment.id));
    assert.equal(savedFindings.items[0]?.data.state,'unverified');
    assert.equal(savedRuns.items[0]?.data.headSha,head);
    assert.equal((savedRuns.items[0]?.data.coverage as any).originalReviewBody,sampleReview.body);
});

test('later inline comments are reconciled without duplicating a review round', async () => {
    const { catalog, runs, findings } = await fixture();
    let comments = [sampleComment];
    const service = new CodeReviewsService(catalog, { read: async () => ({ reviews: [sampleReview], comments }) });
    await service.importPullRequest(repository, 69, true);
    comments = [sampleComment, { ...sampleComment, id: sampleComment.id + 1, body: '🟡 **Sev4 · Add coverage**' }];
    const result = await service.importPullRequest(repository, 69, true);
    assert.equal(result.runsCreated,0);
    assert.equal(result.findingsCreated,1);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id})).total,1);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id})).total,2);
});

test('conflicting immutable GitHub review identity aborts without inserting partial findings', async () => {
    const { catalog, findings } = await fixture();
    const service = new CodeReviewsService(catalog, { read: async () => source });
    await service.importPullRequest(repository,69,true);
    const changed = new CodeReviewsService(catalog, { read: async () => ({
        reviews: [{ ...sampleReview, commit_id: 'b'.repeat(40) }],
        comments: [sampleComment,{...sampleComment,id:sampleComment.id+1}],
    }) });
    await assert.rejects(changed.importPullRequest(repository,69,true),/conflicts with its source/);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id})).total,1);
});

test('GitHub reader validates repository and fetches bounded paginated reviews with least-privilege token', async () => {
    const calls: string[] = [];
    const reader = new GitHubReviewHistoryReader(
        { pullRequestReadToken: async (repo: string) => { assert.equal(repo, repository); return 'temporary-read-token'; } },
        (async (url: string, options: RequestInit) => {
            calls.push(url);
            assert.equal((options.headers as Record<string,string>).Authorization, 'Bearer temporary-read-token');
            assert.equal(options.method, 'GET');
            const isReviews = url.includes('/reviews?');
            return new Response(JSON.stringify(isReviews ? [sampleReview] : [sampleComment]), {status:200});
        }) as typeof fetch,
    );
    await assert.rejects(reader.read('https://evil.example/foo',69),/Invalid GitHub pull request/);
    const result = await reader.read(repository,69);
    assert.equal(result.reviews.length,1);
    assert.equal(result.comments.length,1);
    assert.equal(calls.length,2);
    assert.ok(calls.every(url => url.startsWith('https://api.github.com/repos/affank1020/atlas/pulls/69/')));
});

test('missing severity headings are not promoted into historical findings', () => {
    const prepared = prepareGitHubReviews(repository, 69, {
        reviews: [sampleReview],
        comments: [{ ...sampleComment, id: sampleComment.id + 10,
            body: 'Scenario: another reviewer mentioned Sev3 · Some title in passing.' }],
    });
    assert.equal(prepared.candidates[0]?.comments.length, 0);
    assert.equal(prepared.commentsWithoutSeverity, 1);
});

test('existing archived reviews are never silently resurrected by a rerun', async () => {
    const { catalog, runs } = await fixture();
    const service = new CodeReviewsService(catalog, { read: async () => source });
    await service.importPullRequest(repository, 69, true);
    const records = await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id });
    await catalog.archiveRecord(CODE_REVIEWS_PROJECT_ID, runs.id, records.items[0]!.id);
    await assert.rejects(service.importPullRequest(repository, 69, true), /Archived review history/);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 0);
});

test('reader refuses truncated GitHub pagination without fetching further resources', async () => {
    let requests = 0;
    const reader = new GitHubReviewHistoryReader(
        { pullRequestReadToken: async () => 'read-token' },
        (async () => {
            requests++;
            return new Response(JSON.stringify(Array.from({length:100}, (_, i) =>
                ({ ...sampleReview, id: i + 1 + requests * 100 }))), { status: 200 });
        }) as typeof fetch,
    );
    await assert.rejects(reader.read(repository, 69), /exceeds the supported 500-item limit/);
    assert.equal(requests, 5);
});

test('an archived review for another PR does not block independent imports', async () => {
    const { catalog, runs } = await fixture();
    const service = new CodeReviewsService(catalog, { read: async () => source });
    await service.importPullRequest(repository, 69, true);
    const first = await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id });
    await catalog.archiveRecord(CODE_REVIEWS_PROJECT_ID, runs.id, first.items[0]!.id);
    const next = new CodeReviewsService(catalog, { read: async () => ({ reviews: [
        { ...sampleReview, id: sampleReview.id + 1, body: '## 🔎 Code Reviewer · PR #70\n\n> **Clean review**' },
    ], comments: [] }) });
    const result = await next.importPullRequest(repository, 70, true);
    assert.equal(result.runsCreated, 1);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 1);
});
