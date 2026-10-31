import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { GitHubReviewHistoryReader } from '../apps/server/src/apps/github-review-history.js';
import { ManagedSummaryPreviewService } from '../apps/server/src/apps/managed-summary.js';
import { CodeReviewsService, codeReviewsApplication } from '../apps/server/src/apps/code-reviews.js';
import { prepareGitHubReviews, CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { loadReviewPublisherTrust } from '../apps/server/src/server/config.js';
import { databaseFixture, cleanupDatabases } from './database.js';

after(cleanupDatabases);

const repository = 'affank1020/atlas';
const publisherId = 58519561;
const trusted = new Map([[repository, new Set([publisherId])]]);
const head = 'a'.repeat(40);
const sampleReview = {
    id: 5613675655, body: '## 🔎 Code Reviewer · PR #69\n\n> [!NOTE]\n> **Non-blocking findings** — 1 Sev3',
    commit_id: head, submitted_at: '2026-10-22T12:20:00Z',
    state: 'COMMENTED', html_url: 'https://github.com/affank1020/atlas/pull/69#pullrequestreview-1',
    user: { login: 'affank1020', id: publisherId },
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
        body: 'Unlabelled suggestion', line: null, original_line: null }] }, trusted.get(repository)!);
    assert.equal(prepared.skippedUnrecognized, 2);
    assert.equal(prepared.candidates.length, 1);
    assert.equal(prepared.commentsWithoutSeverity, 1);
    const first = prepared.candidates[0]!;
    assert.equal(first.run.verdict, 'non_blocking');
    assert.equal(first.comments[0]?.finding.severity, 'sev3');
    assert.equal(first.comments[0]?.finding.state, 'unverified');
    assert.equal((first.run.coverage as any).summaryFindingsNotParsed, true);
});

test('spoofed Code Reviewer heading from an unrelated GitHub actor is not imported', () => {
    const impostor = { ...sampleReview, id: sampleReview.id + 1,
        user: { login: 'unrelated-user', id: publisherId + 99 } };
    const noActor = { ...sampleReview, id: sampleReview.id + 2,
        user: { login: 'renamed-person' } };
    const parsed = prepareGitHubReviews(repository, 69, {
        reviews: [sampleReview, impostor, noActor],
        comments: [sampleComment, { ...sampleComment, id: sampleComment.id + 10,
            pull_request_review_id: impostor.id }],
    }, trusted.get(repository)!);
    assert.equal(parsed.candidates.length, 1);
    assert.equal(parsed.skippedUntrusted, 2);
    assert.equal(parsed.candidates[0]!.sourceId, String(sampleReview.id));
    assert.equal(parsed.candidates[0]!.comments.length, 1);
    assert.equal((parsed.candidates[0]!.run.coverage as any).sourceActorId, publisherId);
});

test('repository-scoped trust configuration is opt-in, numeric-ID-only and denies invalid inputs', () => {
    assert.equal(loadReviewPublisherTrust({}).size, 0);
    const mapping = loadReviewPublisherTrust({
        ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON: '{"Affank1020/Atlas":[58519561],"other/target":[77]}',
    });
    assert.deepEqual([...mapping.get(repository)!], [publisherId]);
    assert.equal(mapping.get('other/repository'), undefined);
    for (const invalid of [
        'not-json', '{"affank1020/atlas":["affank1020"]}', '{"affank1020/atlas":[]}',
        '{"affank1020/atlas":[0]}', '{"affank1020/atlas":[1.5]}',
        '{"Affank1020/Atlas":[1],"affank1020/atlas":[2]}',
        '{"*":[58519561]}', '{"bad/repository/extra":[58519561]}',
    ]) assert.throws(() => loadReviewPublisherTrust({
        ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON: invalid,
    }), /ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON/);
});

test('unconfigured repository refuses preview and apply before reading GitHub', async () => {
    const { catalog } = await fixture();
    let called = false;
    const disabled = new CodeReviewsService(catalog, {
        read: async () => { called = true; return source; },
    });
    await assert.rejects(disabled.importPullRequest(repository, 69, false), /No trusted Code Reviewer publisher IDs/);
    await assert.rejects(disabled.importPullRequest(repository, 69, true), /No trusted Code Reviewer publisher IDs/);
    await assert.rejects(disabled.importPullRequest('other/repository', 69, true), /No trusted Code Reviewer publisher IDs/);
    assert.equal(called, false);
});

test('summary banner verdict avoids interpreting old findings as the latest verdict', () => {
    const prepared = prepareGitHubReviews(repository, 69, {
        reviews: [{ ...sampleReview, id: 100, body: '## 🔎 Code Reviewer · PR #69\n\n> [!NOTE]\n> **Clean review** — no actionable issues.\n\n### Previous changes requested now resolved' }],
        comments: [],
    }, trusted.get(repository)!);
    assert.equal(prepared.candidates[0]?.run.verdict, 'no_findings');
});

test('explicit preview is read-only; applied imports are atomic and idempotent', async () => {
    const { catalog, runs, findings } = await fixture();
    const service = new CodeReviewsService(catalog, { read: async () => source }, trusted);
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
    const service = new CodeReviewsService(catalog, { read: async () => ({ reviews: [sampleReview], comments }) }, trusted);
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
    const service = new CodeReviewsService(catalog, { read: async () => source }, trusted);
    await service.importPullRequest(repository,69,true);
    const changed = new CodeReviewsService(catalog, { read: async () => ({
        reviews: [{ ...sampleReview, commit_id: 'b'.repeat(40) }],
        comments: [sampleComment,{...sampleComment,id:sampleComment.id+1}],
    }) }, trusted);
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
    }, trusted.get(repository)!);
    assert.equal(prepared.candidates[0]?.comments.length, 0);
    assert.equal(prepared.commentsWithoutSeverity, 1);
});

test('existing archived reviews are never silently resurrected by a rerun', async () => {
    const { catalog, runs } = await fixture();
    const service = new CodeReviewsService(catalog, { read: async () => source }, trusted);
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
    const service = new CodeReviewsService(catalog, { read: async () => source }, trusted);
    await service.importPullRequest(repository, 69, true);
    const first = await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id });
    await catalog.archiveRecord(CODE_REVIEWS_PROJECT_ID, runs.id, first.items[0]!.id);
    const next = new CodeReviewsService(catalog, { read: async () => ({ reviews: [
        { ...sampleReview, id: sampleReview.id + 1, body: '## 🔎 Code Reviewer · PR #70\n\n> **Clean review**' },
    ], comments: [] }) }, trusted);
    const result = await next.importPullRequest(repository, 70, true);
    assert.equal(result.runsCreated, 1);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 1);
});


const historyFor = (numbers: number[]) => ({
    read: async (_repository: string, n: number) => {
        if (!numbers.includes(n)) throw new Error('Unexpected PR request');
        const increment = n - 69;
        return { reviews: [{
            ...sampleReview, id: sampleReview.id + increment,
            body: `## 🔎 Code Reviewer · PR #${n}\n\n> **Clean review**`,
        }], comments: [{
            ...sampleComment, id: sampleComment.id + increment,
            pull_request_review_id: sampleReview.id + increment,
        }] };
    },
});

test('GitHub PR discovery requires the App token and returns bounded newest-first pages', async () => {
    const urls: string[] = [];
    const reader = new GitHubReviewHistoryReader(
        { pullRequestReadToken: async (name: string) => {
            assert.equal(name, repository);
            return 'ephemeral-token';
        } },
        (async (url: string, options: RequestInit) => {
            urls.push(url);
            assert.match(url, /\/pulls\?state=all&sort=created&direction=desc&per_page=50&page=/);
            assert.equal((options.headers as Record<string,string>).Authorization, 'Bearer ephemeral-token');
            const page = Number(url.slice(url.lastIndexOf('=') + 1));
            const count = page === 1 ? 50 : 2;
            return new Response(JSON.stringify(Array.from({ length: count }, (_, index) => ({
                number: 100 - (page - 1) * 50 - index, title: `PR ${index}`,
                state: 'closed', draft: false,
            }))), { status: 200 });
        }) as typeof fetch);
    await assert.rejects(reader.discover(repository, 0), /Invalid GitHub pull request discovery request/);
    await assert.rejects(reader.discover(repository, 101), /Invalid GitHub pull request discovery request/);
    await assert.rejects(reader.discover('invalid/owner/extra', 1), /Invalid GitHub pull request discovery request/);
    assert.equal(urls.length, 0);
    const first = await reader.discover(repository, 1);
    assert.deepEqual(first.items.map(pr => pr.number).slice(0, 3), [100, 99, 98]);
    assert.equal(first.nextPage, 2);
    const last = await reader.discover(repository, 2);
    assert.equal(last.items.length, 2);
    assert.equal(last.nextPage, null);
    assert.equal(urls.length, 2);
});

test('PR discovery rejects unexpected GitHub response shape and errors without returning misleading PRs', async () => {
    const broker = { pullRequestReadToken: async () => 'ephemeral-token' };
    for (const result of [
        new Response(JSON.stringify([{ number: 1, title: 'valid', state: 'open', draft: 'no' }]), { status: 200 }),
        new Response(JSON.stringify({ message: 'wrong shape' }), { status: 200 }),
        new Response(JSON.stringify({ message: 'rate-limited' }), { status: 429 }),
    ]) {
        const reader = new GitHubReviewHistoryReader(broker, (async () => result.clone()) as typeof fetch);
        await assert.rejects(reader.discover(repository, 1), /discovery returned unsupported data|discovery failed/);
    }
});

test('explicit PR-number batches preview without writes and apply idempotently in one transaction', async () => {
    const { catalog, runs, findings } = await fixture();
    const source = historyFor([69, 70, 71]);
    const service = new CodeReviewsService(catalog, source, trusted);
    const api = new ApplicationRegistry([codeReviewsApplication(service)]);
    const args = { repository, prNumbers: [70, 69] };
    const preview = await api.invoke('code_reviews_backfill_pull_requests', args) as any;
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.prNumbers, [70, 69]);
    assert.deepEqual([preview.totals.runsCreated, preview.totals.findingsCreated], [2, 2]);
    assert.ok(preview.results.every((result: any) => result.dryRun === true));
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 0);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id })).total, 0);
    const applied = await api.invoke('code_reviews_backfill_pull_requests', { ...args, apply: true }) as any;
    assert.equal(applied.dryRun, false);
    assert.deepEqual([applied.totals.runsCreated, applied.totals.findingsCreated], [2, 2]);
    const second = await api.invoke('code_reviews_backfill_pull_requests', { ...args, apply: true }) as any;
    assert.deepEqual([second.totals.runsCreated, second.totals.findingsCreated], [0, 0]);
    assert.deepEqual([second.totals.runsAlreadyPresent, second.totals.findingsAlreadyPresent], [2, 2]);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 2);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id })).total, 2);
});

test('batch rejects duplicated or untrusted input before remote I/O', async () => {
    const { catalog } = await fixture();
    let calls = 0;
    const read = async () => { calls++; return { reviews: [], comments: [] }; };
    const service = new CodeReviewsService(catalog, { read }, trusted);
    const invalid = [[], [69, 69], [0], [-1], [1000001], [1,2,3,4,5,6,7,8,9]];
    for (const nums of invalid)
        await assert.rejects(service.backfillPullRequests(repository, nums, true), /Choose between 1 and 8/);
    await assert.rejects(service.backfillPullRequests('another/repository', [69], false), /No trusted Code Reviewer publisher IDs/);
    assert.equal(calls, 0);
});

test('failure while fetching later source prevents all batch writes', async () => {
    const { catalog, runs, findings } = await fixture();
    const service = new CodeReviewsService(catalog, {
        read: async (_repo: string, n: number) => {
            if (n === 70) throw new Error('GitHub unavailable');
            return { reviews: [sampleReview], comments: [sampleComment] };
        },
    }, trusted);
    await assert.rejects(service.backfillPullRequests(repository, [69, 70], true), /GitHub unavailable/);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 0);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id })).total, 0);
});

test('conflict in a later PR aborts the whole batch, including earlier PR writes', async () => {
    const { catalog, runs, findings } = await fixture();
    const initial = new CodeReviewsService(catalog, historyFor([69]), trusted);
    await initial.importPullRequest(repository, 69, true);
    const altered = new CodeReviewsService(catalog, {
        read: async (_repo: string, n: number) => {
            const existing = await historyFor([69, 70]).read(repository, n);
            return n === 69 ?
                { ...existing, reviews: existing.reviews.map(review => ({ ...review, commit_id: 'b'.repeat(40) })) }
                : existing;
        },
    }, trusted);
    await assert.rejects(altered.backfillPullRequests(repository, [70, 69], false), /conflicts with its source/);
    await assert.rejects(altered.backfillPullRequests(repository, [70, 69], true), /conflicts with its source/);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 1);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id })).total, 1);
});

test('batch preview detects duplicate GitHub identities across selected PRs without storing them', async () => {
    const { catalog, runs } = await fixture();
    const service = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [sampleReview], comments: [sampleComment] }),
    }, trusted);
    await assert.rejects(service.backfillPullRequests(repository, [69, 70], false), /conflicts with its source/);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 0);
});

test('discover Application tool supplies defaults, caps pages and returns read-only selection metadata', async () => {
    const { catalog } = await fixture();
    const calls: number[] = [];
    const service = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
        discover: async (_repo: string, page: number) => {
            calls.push(page);
            return { repository, page, items: [
                { number: 69, title: 'Test PR', state: 'closed' as const, draft: false },
            ], nextPage: null, truncatedAtLimit: false };
        },
    }, trusted);
    const api = new ApplicationRegistry([codeReviewsApplication(service)]);
    const discovered = await api.invoke('code_reviews_discover_pull_requests', { repository }) as any;
    assert.equal(discovered.items[0].number, 69);
    assert.deepEqual(calls, [1]);
    await assert.rejects(api.invoke('code_reviews_discover_pull_requests', { repository, page: 101 }));
    assert.deepEqual(calls, [1]);
});

test('an empty matching review timeline yields zero counts rather than a completeness claim', async () => {
    const { catalog, runs } = await fixture();
    const service = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
    }, trusted);
    const result = await service.backfillPullRequests(repository, [68], false);
    assert.equal(result.results[0]?.sourceReviews, 0);
    assert.equal(result.totals.runsCreated, 0);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 0);
});

test('new mixed-case GitHub history imports use canonical repository identity without duplicating prior review IDs', async () => {
    const { catalog, runs } = await fixture();
    const service = new CodeReviewsService(catalog, { read: async () => source }, trusted);
    const first = await service.importPullRequest('Affank1020/Atlas', 69, true);
    assert.equal(first.repository, repository);
    assert.equal(first.runsCreated, 1);
    const saved = await catalog.queryRecords({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id,
    });
    assert.equal(saved.total, 1);
    assert.equal(saved.items[0]!.data.repository, repository);
    const second = await service.importPullRequest(repository, 69, true);
    assert.equal(second.runsCreated, 0);
    assert.equal(second.runsAlreadyPresent, 1);
});

test('PostgreSQL managed summary includes legacy mixed-case historical runs with exact PR identity', async () => {
    const { catalog, runs } = await fixture();
    const prNumber = 69;
    const historical = await catalog.createRecord({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id,
        data: {
            repository: 'Affank1020/Atlas', prNumber, headSha: 'b'.repeat(40),
            reviewer: 'code-reviewer-history', reviewedAt: '2026-10-30T18:00:00.000Z',
            verdict: 'non_blocking',
            coverage: { source: 'github_pull_request_review', findingCapture: 'partial' },
        },
    });
    await catalog.createRecord({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id,
        data: {
            repository, prNumber, headSha: 'a'.repeat(40),
            reviewer: 'atlas-structured-review', reviewedAt: '2026-10-30T16:00:00.000Z',
            verdict: 'no_findings', coverage: {
                source: 'atlas_structured_submission', findingCount: 0,
            },
        },
    });
    await catalog.createRecord({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id,
        data: {
            repository: 'unrelated/atlas', prNumber, headSha: 'c'.repeat(40),
            reviewer: 'other-history', reviewedAt: '2026-10-30T19:00:00.000Z',
            verdict: 'no_findings', coverage: { source: 'github_pull_request_review' },
        },
    });
    // The app UI uses these read APIs. Both must treat historical spelling
    // as the same repository without including identical PR numbers in other repos.
    const history = new CodeReviewsService(catalog);
    const summary = await history.prSummary(repository, prNumber);
    assert.equal(summary.recordedRounds, 2);
    assert.equal(summary.latest?.runId, historical.id);
    assert.equal(summary.latest?.source, 'historical');
    assert.equal(summary.latestReviewHead, 'unknown');
    const timeline = await history.prTimeline(repository, prNumber, 10, 0);
    assert.equal(timeline.recordedRounds, 2);
    assert.deepEqual(timeline.rounds.map(round => round.runId), [historical.id,
        (await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id,
            filters: [{ field: 'repository', operator: 'eq', value: repository }] })).items[0]!.id]);
    const mixedSpelling = await history.prSummary('Affank1020/Atlas', prNumber);
    assert.equal(mixedSpelling.recordedRounds, 2);

    const managed = new ManagedSummaryPreviewService(catalog, {
        inspect: async (name: string, actualNumber: number, body: string) => {
            assert.equal(name, repository);
            assert.equal(actualNumber, prNumber);
            assert.match(body, /Historical import/);
            return { status: 'no_owned_comment' };
        },
    } as any);
    for (const name of ['Affank1020/Atlas', repository]) {
        const result = await managed.preview(name, prNumber) as any;
        assert.equal(result.repository, repository);
        assert.equal(result.recordedRounds, 2);
        assert.equal(result.runId, historical.id, 'newest matching historical round must be selected');
        assert.equal(result.source, 'historical');
        assert.equal(result.fullEvidence, false);
    }
});
