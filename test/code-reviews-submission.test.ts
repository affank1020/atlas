import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { CodeReviewsService, codeReviewsApplication } from '../apps/server/src/apps/code-reviews.js';
import { GitHubReviewHistoryReader } from '../apps/server/src/apps/github-review-history.js';
import { structuredReviewSchema, existingStructuredReview } from '../apps/server/src/apps/review-submission.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { createDispatcher } from '../apps/server/src/server/dispatch.js';
import { databaseFixture, cleanupDatabases } from './database.js';

after(cleanupDatabases);

const reviewer = { kind: 'mcp-oauth' as const, subject: 'auth0|independent-test', issuer: 'https://oauth.example.com/' };
const differentReviewer = { ...reviewer, subject: 'auth0|another-test' };
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
    return { catalog, store, runs, findings };
}

const openHead = (headSha = sha, open = true) => ({
    read: async () => ({ reviews: [], comments: [] }),
    currentHead: async (name: string, prNumber: number) => {
        assert.equal(name, repository);
        assert.equal(prNumber, 84);
        return { repository: name, prNumber, headSha, open };
    },
});

test('only authenticated MCP transport identity authorizes structured submissions', async () => {
    const { catalog, runs } = await fixture();
    let gitHubReads = 0;
    const app = new ApplicationRegistry([codeReviewsApplication(new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => {
            gitHubReads++;
            return { repository, prNumber: 84, headSha: sha, open: true };
        },
    }))]);
    const dispatch = createDispatcher({ applications: app } as any);
    const input = { submission: request, caller: reviewer,
        authenticatedCaller: reviewer, client: 'atlas-mcp' };
    await assert.rejects(app.invoke('code_reviews_submit_structured', input), /authenticated MCP OAuth caller/);
    await assert.rejects(dispatch('code_reviews_submit_structured', input, 'atlas-http'), /authenticated MCP OAuth caller/);
    await assert.rejects(dispatch('code_reviews_submit_structured', input, 'atlas-mcp'), /authenticated MCP OAuth caller/);
    assert.equal(gitHubReads, 0, 'unauthenticated calls must fail before external I/O');
    assert.equal((await catalog.queryRecords({projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id})).total, 0);
    const accepted = await dispatch('code_reviews_submit_structured', { submission: request }, 'atlas-mcp', reviewer) as any;
    assert.equal(accepted.created, true);
    assert.equal(gitHubReads, 1);
    const saved = await catalog.queryRecords({projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id});
    assert.deepEqual((saved.items[0]!.data.coverage as any).authenticatedCaller, reviewer);
    await assert.rejects(dispatch('code_reviews_submit_structured', input, 'atlas-mcp', differentReviewer),
        /different authenticated caller/);
    assert.equal(gitHubReads, 1, 'cross-subject replay must fail before external I/O');
});

test('structured review submits one immutable run and linked findings with server-assigned provenance', async () => {
    const { catalog, runs, findings } = await fixture();
    const app = new ApplicationRegistry([codeReviewsApplication(new CodeReviewsService(catalog, openHead()))]);
    const first = await app.invoke('code_reviews_submit_structured', { submission: request }, reviewer) as any;
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

test('explicit lineage key links observations across commits without rewriting per-run identity or lifecycle state', async () => {
    const { catalog, findings } = await fixture();
    let remoteHead = sha;
    const service = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => ({ repository, prNumber: 84, headSha: remoteHead, open: true }),
    });
    const withLineage = {
        ...request,
        findings: [{ ...request.findings[0], lineageKey: 'validate-pr-head-root-cause' }],
    };
    const first = await service.submitStructuredReview(withLineage, reviewer);
    remoteHead = 'b'.repeat(40);
    const replay = await service.submitStructuredReview(withLineage, reviewer);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.findingReceipts, first.findingReceipts);

    const second = await service.submitStructuredReview({
        ...withLineage, headSha: remoteHead,
        submissionId: '5fd1e8c6-0792-4e9c-a809-df389d840d90',
        findings: [{ ...withLineage.findings[0], key: 'new-local-observation' }],
    }, reviewer);
    const withoutLineage = await service.submitStructuredReview({
        ...request, headSha: remoteHead, submissionId: 'c52d18bb-e0e6-493e-8ccc-b4357a0dff7d',
    }, reviewer);
    const records = (await catalog.queryRecords({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id, limit: 100,
    })).items;
    const firstFinding = records.find(item => item.data.reviewRunId === first.runId)!;
    const secondFinding = records.find(item => item.data.reviewRunId === second.runId)!;
    const unlinkedFinding = records.find(item => item.data.reviewRunId === withoutLineage.runId)!;
    assert.notEqual(firstFinding.data.findingKey, secondFinding.data.findingKey,
        'each observation retains its own immutable submission-scoped key');
    assert.equal((firstFinding.data.evidence as any).lineageKey, 'validate-pr-head-root-cause');
    assert.equal((secondFinding.data.evidence as any).lineageKey, 'validate-pr-head-root-cause');
    assert.equal((unlinkedFinding.data.evidence as any).lineageKey, undefined,
        'legacy and unlinked findings must not be joined by guessing');
    assert.deepEqual(records.map(record => record.data.state), ['new', 'new', 'new'],
        'a matching key alone is not evidence of a fix or persistence verdict');
    await assert.rejects(service.submitStructuredReview({
        ...withLineage, findings: [{ ...withLineage.findings[0], lineageKey: 'different-root' }],
    }, reviewer), /already belongs to another payload/);
});

test('lineage keys must be valid and unique within a structured review', () => {
    const linked = { ...request.findings[0], lineageKey: 'root-1' };
    for (const invalid of [
        [linked, { ...linked, key: 'other-observation' }],
        [{ ...linked, lineageKey: 'has spaces' }],
        [{ ...linked, lineageKey: 'x'.repeat(129) }],
        [{ ...linked, lineageKey: '' }],
    ]) assert.equal(structuredReviewSchema.safeParse({
        ...request, findings: invalid,
    }).success, false);
    assert.equal(structuredReviewSchema.safeParse({
        ...request, findings: [linked, { ...linked, key: 'other-observation', lineageKey: 'root-2' }],
    }).success, true);
});

test('replay returns original receipt after PR SHA advances, without querying GitHub again', async () => {
    const { catalog, runs, findings } = await fixture();
    let calls = 0;
    const service = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => { calls++; return { repository, prNumber: 84, headSha: sha, open: true }; },
    });
    const first = await service.submitStructuredReview(request, reviewer);
    const again = await service.submitStructuredReview(request, reviewer);
    assert.deepEqual({ ...again, created: true }, first);
    assert.equal(again.created, false);
    assert.equal(calls, 1);
    await assert.rejects(
        service.submitStructuredReview({ ...request, summary: 'Different content' }, reviewer),
        /already belongs to another payload/);
    assert.equal(calls, 1);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id})).total, 1);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id})).total, 1);
});

test('changed/closed PR heads are rejected with zero writes', async () => {
    const { catalog, runs } = await fixture();
    for (const source of [openHead('b'.repeat(40)), openHead(sha, false)]) {
        const service = new CodeReviewsService(catalog, source);
        await assert.rejects(service.submitStructuredReview(request, reviewer), /head has changed|closed/i);
    }
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id})).total, 0);
});

test('concurrent identical submissions coalesce; different IDs on the same SHA stay distinct', async () => {
    const { catalog, runs, findings } = await fixture();
    const service = new CodeReviewsService(catalog, openHead());
    const receipts = await Promise.all(Array.from({length:4}, () => service.submitStructuredReview(request, reviewer)));
    assert.equal(receipts.filter(result => result.created).length, 1);
    assert.equal(new Set(receipts.map(result => result.runId)).size, 1);
    await service.submitStructuredReview({
        ...request, submissionId: 'df56ae1c-81b6-4334-aa53-205861494d84',
    }, reviewer);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id})).total, 2);
    assert.equal((await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id})).total, 2);
});

test('finding schema failure aborts run and findings atomically', async () => {
    const { catalog, runs, findings } = await fixture();
    await catalog.updateSchema({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id, fields: [
        ...findings.schema.fields, { name: 'mandatorySource', type: 'string', required: true },
    ] });
    const service = new CodeReviewsService(catalog, openHead());
    await assert.rejects(service.submitStructuredReview(request, reviewer), /Required field.*mandatorySource/);
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
        await assert.rejects(service.submitStructuredReview(payload as any, reviewer));
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


test('multi-finding receipts preserve key-to-ID order across tied PostgreSQL timestamps and replay', async () => {
    const { catalog, store, runs, findings } = await fixture();
    const payload = {
        ...request,
        findings: [
            { key: 'first', severity: 'sev3' as const, title: 'First', description: 'First issue' },
            { key: 'second', severity: 'sev4' as const, title: 'Second', description: 'Second issue' },
            { key: 'third', severity: 'sev2' as const, title: 'Third', description: 'Third issue' },
        ],
    };
    const service = new CodeReviewsService(catalog, openHead());
    const first = await service.submitStructuredReview(payload, reviewer);
    assert.equal(first.created, true);
    assert.deepEqual(first.findingReceipts.map((item: any) => item.key), ['first', 'second', 'third']);
    assert.deepEqual(first.findingIds, first.findingReceipts.map((item: any) => item.id));

    // Simulate a database reload where all creation timestamps tie and the
    // Postgres ordering by UUID differs from the insertion/submission order.
    await store.pool.query('UPDATE records SET created_at = $1 WHERE store_id = $2 AND data->>\'reviewRunId\' = $3',
        ['2026-10-22T12:00:00.000Z', findings.id, first.runId]);
    const snapshot = await catalog.store.snapshot();
    const ids = { runs: runs.id, findings: findings.id };
    const normalized = structuredReviewSchema.parse(payload);
    const reversed = { ...snapshot, records: [...snapshot.records].reverse() };
    const reorderedReceipt = existingStructuredReview(reversed, ids, normalized, reviewer);
    assert.deepEqual(reorderedReceipt?.findingReceipts, first.findingReceipts);
    assert.deepEqual(reorderedReceipt?.findingIds, first.findingIds);

    const replay = await service.submitStructuredReview(payload, reviewer);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.findingReceipts, first.findingReceipts);
    assert.deepEqual(replay.findingIds, first.findingIds);
    const stored = await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id });
    assert.equal(stored.total, 3);
    for (const mapping of first.findingReceipts)
        assert.equal(stored.items.find(record => record.id === mapping.id)?.data.findingKey,
            `structured:${payload.submissionId}:${mapping.key}`);
});

test('a concurrent retry returns a committed receipt after the PR head closes or advances', async () => {
    const { catalog, runs, findings } = await fixture();
    type Head = { repository: string; prNumber: number; headSha: string; open: boolean };
    let firstHead!: (result: Head) => void;
    let secondHead!: (result: Head) => void;
    let firstEntered!: () => void;
    let secondEntered!: () => void;
    const firstAtGitHub = new Promise<void>(resolve => { firstEntered = resolve; });
    const secondAtGitHub = new Promise<void>(resolve => { secondEntered = resolve; });
    let checks = 0;
    const service = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => {
            checks++;
            if (checks === 1) {
                firstEntered();
                return new Promise<Head>(resolve => { firstHead = resolve; });
            }
            if (checks === 2) {
                secondEntered();
                return new Promise<Head>(resolve => { secondHead = resolve; });
            }
            return { repository, prNumber: 84, headSha: 'b'.repeat(40), open: false };
        },
    });
    // Both calls reach GitHub while neither has written a run.
    const firstPending = service.submitStructuredReview(request, reviewer);
    await firstAtGitHub;
    const retryPending = service.submitStructuredReview(request, reviewer);
    await secondAtGitHub;
    firstHead({ repository, prNumber: 84, headSha: sha, open: true });
    const first = await firstPending;
    secondHead({ repository, prNumber: 84, headSha: 'b'.repeat(40), open: false });
    const retry = await retryPending;
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.deepEqual({ ...retry, created: true }, first);
    assert.equal(checks, 2);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 1);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id })).total, 1);
    // This fallback only permits an identical *persisted* receipt, never
    // an unmatched new submission on an outdated/closed PR.
    await assert.rejects(service.submitStructuredReview({
        ...request, submissionId: 'df56ae1c-81b6-4334-aa53-205861494d84',
    }, reviewer), /head has changed|closed/i);
});

test('explicit lifecycle assessments and resolutions survive re-reviews without mutating earlier findings', async () => {
    const { catalog, runs, findings } = await fixture();
    let currentHead = sha;
    const service = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => ({ repository, prNumber: 84, headSha: currentHead, open: true }),
    });
    const first = await service.submitStructuredReview({
        ...request, findings: [{ ...request.findings[0], lineageKey: 'pr-head-root' }],
    }, reviewer);
    currentHead = 'b'.repeat(40);
    const secondPayload = {
        ...request, submissionId: 'ae6a5e3a-cf91-4b4c-9a93-a1b94a33a902', headSha: currentHead,
        findings: [{ ...request.findings[0], key: 'recheck', lineageKey: 'pr-head-root',
            assessment: { state: 'persisting' as const,
                evidence: 'Reproduced the original stale-commit issue against this reviewed head.' } }],
    };
    const second = await service.submitStructuredReview(secondPayload, reviewer);
    const repeated = await service.submitStructuredReview(secondPayload, reviewer);
    assert.equal(repeated.created, false);
    assert.deepEqual(repeated.findingReceipts, second.findingReceipts);
    currentHead = 'c'.repeat(40);
    const resolvedPayload = {
        ...request, submissionId: 'd2fe73a7-7070-445f-8aa1-bdb6ac73d801', headSha: currentHead,
        verdict: 'no_findings' as const, findings: [],
        resolutions: [{ lineageKey: 'pr-head-root',
            evidence: 'Confirmed the head check rejects changed revisions in a focused regression test.' }],
    };
    const resolved = await service.submitStructuredReview(resolvedPayload, reviewer);
    assert.deepEqual(resolved.findingIds, []);
    const saved = await catalog.queryRecords({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id, limit: 20,
    });
    const original = saved.items.find(record => record.id === first.runId)!;
    const resolution = saved.items.find(record => record.id === resolved.runId)!;
    assert.equal((original.data.coverage as any).lifecycleResolutions, undefined);
    assert.equal((resolution.data.coverage as any).lifecycleResolutions[0].state, 'resolved');
    assert.equal((resolution.data.coverage as any).lifecycleResolutions[0].assessedHeadSha, currentHead);
    const savedFindings = await catalog.queryRecords({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id, limit: 20,
    });
    assert.equal(savedFindings.items.find(item => item.data.reviewRunId === first.runId)?.data.state, 'new');
    const persisting = savedFindings.items.find(item => item.data.reviewRunId === second.runId)!;
    assert.equal(persisting.data.state, 'persisting');
    assert.equal((persisting.data.evidence as any).lifecycleAssessment.assessedHeadSha, secondPayload.headSha);
    const history = await service.prTimeline(repository, 84, 5, 0) as any;
    assert.equal(history.recordedRounds, 3);
    assert.equal(history.lineages.length, 1);
    assert.equal(history.lineages[0].latestAssessmentInPage.state, 'resolved');
    assert.equal(history.lineages[0].observationsInPage, 2);
    assert.equal(history.rounds[0].resolutions[0].lineageKey, 'pr-head-root');
    assert.equal(history.resolutionInferred, false);
});

test('lifecycle assertions reject missing roots, cross-PR identities, contradictions and weak evidence', async () => {
    const { catalog, runs } = await fixture();
    const service = new CodeReviewsService(catalog, openHead());
    const base = {
        ...request, submissionId: '57653ba8-93fa-4a49-9729-bb7f2cfc0802',
        findings: [] as typeof request.findings,
        resolutions: [{ lineageKey: 'missing-root',
            evidence: 'Verified the source case with a complete unit test at this commit.' }],
    };
    await assert.rejects(service.submitStructuredReview(base, reviewer), /no prior structured finding/i);
    await assert.rejects(service.submitStructuredReview({
        ...base, findings: [{ ...request.findings[0], key: 'one', lineageKey: 'missing-root' }],
    }, reviewer), /both observed and resolved/i);
    await assert.rejects(service.submitStructuredReview({
        ...base, resolutions: [base.resolutions[0], base.resolutions[0]],
    }, reviewer), /resolved only once/i);
    await assert.rejects(service.submitStructuredReview({
        ...base, resolutions: [{ lineageKey: 'missing-root', evidence: 'looks fixed' }],
    }, reviewer));
    await assert.rejects(service.submitStructuredReview({
        ...request, findings: [{ ...request.findings[0],
            assessment: { state: 'persisting', evidence: 'Confirmed again in new tests on this head.' } }],
    }, reviewer), /requires an explicit lineage key/i);
    const first = await service.submitStructuredReview({
        ...request, findings: [{ ...request.findings[0], lineageKey: 'owned-pr84-root' }],
    }, reviewer);
    assert.ok(first.created);
    await assert.rejects(service.submitStructuredReview({
        ...base, resolutions: [{ lineageKey: 'other-pr-root',
            evidence: 'Sufficient evidence describing a completely different issue.' }],
    }, reviewer), /no prior structured finding/i);
    const differentPr = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => ({ repository, prNumber: 85, headSha: sha, open: true }),
    });
    await assert.rejects(differentPr.submitStructuredReview({
        ...base, prNumber: 85,
        resolutions: [{ lineageKey: 'owned-pr84-root',
            evidence: 'Attempted to reuse a root cause from a different pull request.' }],
    }, reviewer), /no prior structured finding/i);
    assert.equal((await catalog.queryRecords({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id,
    })).total, 1, 'rejected assessments cannot create an additional review');
});

test('archived prior observation cannot support a new lifecycle assertion', async () => {
    const { catalog, store, findings, runs } = await fixture();
    const service = new CodeReviewsService(catalog, openHead());
    const first = await service.submitStructuredReview({
        ...request, findings: [{ ...request.findings[0], lineageKey: 'archive-root' }],
    }, reviewer);
    await store.pool.query('UPDATE records SET archived_at = now() WHERE id = $1 AND store_id = $2',
        [first.findingIds[0], findings.id]);
    await assert.rejects(service.submitStructuredReview({
        ...request, submissionId: '5c9f740a-e913-44f9-99ac-905b0aa1681f', findings: [],
        verdict: 'no_findings', resolutions: [{
            lineageKey: 'archive-root',
            evidence: 'This is sufficient descriptive evidence but its source is archived.' }],
    }, reviewer), /history is incomplete/i);
    assert.equal((await catalog.queryRecords({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id })).total, 1);
});
