import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { CodeReviewsService, codeReviewsApplication } from '../apps/server/src/apps/code-reviews.js';
import { GitHubReviewHistoryReader } from '../apps/server/src/apps/github-review-history.js';
import { structuredReviewSchema } from '../apps/server/src/apps/review-submission.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { databaseFixture, cleanupDatabases } from './database.js';

after(cleanupDatabases);

const repository = 'affank1020/atlas';
const sha = 'a'.repeat(40);
const request = {
    submissionId: '3c7435fa-956e-4ba1-b759-e9805570a33c',
    repository, prNumber: 84, headSha: sha,
    verdict: 'non_blocking' as const,
    summary: 'Independent review found one issue.',
    findings: [{
        key: 'validate-pr-head', severity: 'sev3' as const,
        title: 'Verify PR head', description: 'Mismatched GitHub SHA should not be saved.',
        filePath: 'apps/server/src/apps/code-reviews.ts', line: 42,
    }],
};

async function fixture() {
    const { catalog, store } = await databaseFixture();
    await store.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Code Reviews',now(),now())",
        [CODE_REVIEWS_PROJECT_ID]);
    const runs = await catalog.createStore({ projectId: CODE_REVIEWS_PROJECT_ID, name: 'Review Runs', fields: [
        { name: 'repository', type: 'string', required: true },
        { name: 'prNumber', type: 'number', required: true }, { name: 'headSha', type: 'string', required: true },
        { name: 'reviewer', type: 'string', required: true },
        { name: 'verdict', type: 'enum', required: true,
            enumValues: ['changes_requested','concerns_to_verify','non_blocking','no_findings','inconclusive'] },
        { name: 'reviewedAt', type: 'datetime', required: true }, { name: 'githubReviewId', type: 'string' },
        { name: 'coverage', type: 'object' }, { name: 'counts', type: 'object' },
        { name: 'schemaVersion', type: 'number', required: true, default: 1 },
    ] });
    const findings = await catalog.createStore({ projectId: CODE_REVIEWS_PROJECT_ID, name: 'Review Findings', fields: [
        { name: 'reviewRunId', type: 'string', required: true }, { name: 'findingKey', type: 'string', required: true },
        { name: 'severity', type: 'enum', required: true, enumValues: ['sev1','sev2','sev3','sev4'] },
        { name: 'title', type: 'string', required: true }, { name: 'description', type: 'string', required: true },
        { name: 'filePath', type: 'string' }, { name: 'line', type: 'number' },
        { name: 'state', type: 'enum', required: true, enumValues: ['new','persisting','resolved','unverified'] },
        { name: 'evidence', type: 'object' }, { name: 'schemaVersion', type: 'number', required: true, default: 1 },
    ] });
    return { catalog, runs, findings };
}

const openHead = (headSha = sha, open = true) => ({
    read: async () => ({ reviews: [], comments: [] }),
    currentHead: async (name: string, prNumber: number) => {
        assert.equal(name, repository);
        assert.equal(prNumber, 84);
        return { repository: name, prNumber, headSha, open };
    },
});

test('structured review submits one immutable run and linked findings with server-assigned provenance', async () => {
    const { catalog, runs, findings } = await fixture();
    const app = new ApplicationRegistry([codeReviewsApplication(new CodeReviewsService(catalog, openHead()))]);
    const first = await app.invoke('code_reviews_submit_structured', { submission: request }) as any;
    assert.equal(first.created, true);
    assert.equal(first.publishedToGitHub, false);
    assert.equal(first.headSha, sha);
    assert.equal(first.findingIds.length, 1);
    const savedRuns = await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id });
    const savedFindings = await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id });
    assert.equal(savedRuns.total, 1);
    assert.equal(savedFindings.total, 1);
    const run = savedRuns.items[0]!;
    const finding = savedFindings.items[0]!;
    assert.equal(run.data.reviewer, 'atlas-structured-review');
    assert.equal(run.data.verdict, 'non_blocking');
    assert.equal(run.data.githubReviewId, undefined);
    assert.deepEqual(run.data.counts, {sev1:0,sev2:0,sev3:1,sev4:0});
    assert.equal((run.data.coverage as any).submissionId, request.submissionId);
    assert.equal((run.data.coverage as any).publisherIdentityVerified, false);
    assert.equal((run.data.coverage as any).publication, 'not_published');
    assert.equal((run.data.coverage as any).summary, request.summary);
    assert.equal(finding.data.reviewRunId, run.id);
    assert.equal(finding.data.findingKey, `structured:${request.submissionId}:validate-pr-head`);
    assert.equal(finding.data.state, 'new');
    assert.equal(first.runId, run.id);
    assert.equal(first.reviewedAt, run.data.reviewedAt);
});

test('replay returns original receipt after PR SHA advances, without querying GitHub again', async () => {
    const { catalog, runs, findings } = await fixture();
    let calls = 0;
    const service = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => { calls++; return { repository, prNumber: 84, headSha: sha, open: true }; },
    });
    const first = await service.submitStructuredReview(request);
    const again = await service.submitStructuredReview(request);
    assert.deepEqual({ ...again, created: true }, first);
    assert.equal(again.created, false);
    assert.equal(calls, 1);
    await assert.rejects(
        service.submitStructuredReview({ ...request, summary: 'Different content' }),
        /already belongs to another payload/);
    assert.equal(calls, 1);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id})).total, 1);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id})).total, 1);
});

test('changed/closed PR heads are rejected with zero writes', async () => {
    const { catalog, runs } = await fixture();
    for (const source of [openHead('b'.repeat(40)), openHead(sha, false)]) {
        const service = new CodeReviewsService(catalog, source);
        await assert.rejects(service.submitStructuredReview(request), /head has changed|closed/i);
    }
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id})).total, 0);
});

test('concurrent identical submissions coalesce; different IDs on the same SHA stay distinct', async () => {
    const { catalog, runs, findings } = await fixture();
    const service = new CodeReviewsService(catalog, openHead());
    const receipts = await Promise.all(Array.from({length:4}, () => service.submitStructuredReview(request)));
    assert.equal(receipts.filter(result => result.created).length, 1);
    assert.equal(new Set(receipts.map(result => result.runId)).size, 1);
    await service.submitStructuredReview({
        ...request, submissionId: 'df56ae1c-81b6-4334-aa53-205861494d84',
    });
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id})).total, 2);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id})).total, 2);
});

test('finding schema failure aborts run and findings atomically', async () => {
    const { catalog, runs, findings } = await fixture();
    await catalog.updateSchema({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id, fields: [
        ...findings.schema.fields, { name: 'mandatorySource', type: 'string', required: true },
    ] });
    const service = new CodeReviewsService(catalog, openHead());
    await assert.rejects(service.submitStructuredReview(request), /Required field.*mandatorySource/);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id})).total, 0);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id})).total, 0);
});

test('strict payload validation rejects duplicate keys, false clean verdicts, oversized and unknown fields', async () => {
    const { catalog } = await fixture();
    let checked = false;
    const service = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => { checked = true; throw new Error('should not fetch'); },
    });
    const invalid = [
        { ...request, findings: [...request.findings, request.findings[0]] },
        { ...request, verdict: 'no_findings' as const },
        { ...request, findings: [...request.findings, ...Array(30).fill(request.findings[0])] },
        { ...request, arbitrary: 'not supported' },
        { ...request, headSha: 'short' },
    ];
    for (const payload of invalid)
        await assert.rejects(service.submitStructuredReview(payload as any));
    assert.equal(checked, false);
    assert.equal(structuredReviewSchema.safeParse({
        ...request, verdict: 'no_findings', findings: [],
    }).success, true);
});

test('GitHub head verifier uses scoped read permission and rejects incorrect PR identities', async () => {
    let requests = 0;
    const makeReader = (body: object, status=200) => new GitHubReviewHistoryReader({
        pullRequestReadToken: async (name: string) => {
            assert.equal(name, repository); return 'scoped-read-token';
        },
    }, (async (url: string, options: RequestInit) => {
        requests++;
        assert.equal(url, 'https://api.github.com/repos/affank1020/atlas/pulls/84');
        assert.equal(options.method, 'GET');
        assert.equal((options.headers as Record<string,string>).Authorization, 'Bearer scoped-read-token');
        return new Response(JSON.stringify(body), { status });
    }) as typeof fetch);
    const valid = { number: 84, state: 'open', head: {sha}, base: {repo: {full_name: repository}} };
    assert.deepEqual(await makeReader(valid).currentHead(repository,84),
        { repository, prNumber: 84, headSha: sha, open: true });
    for (const payload of [
        {...valid, number: 83}, {...valid, base: {repo: {full_name:'other/repository'}}},
        {...valid, head: { sha: 'bad' }}, {...valid, state: 'other'},
    ]) await assert.rejects(makeReader(payload).currentHead(repository,84), /unexpected pull request identity or head/);
    await assert.rejects(makeReader({}, 403).currentHead(repository,84), /HTTP 403/);
    await assert.rejects(makeReader({}).currentHead(repository,0), /Invalid GitHub pull request identity/);
    assert.equal(requests, 6);
});
