import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { InlineRootPublicationService } from '../apps/server/src/apps/inline-root-publication.js';
import { GitHubInlineRootWriter } from '../apps/server/src/apps/inline-thread-writer.js';
import { inlineThreadMarker } from '../apps/server/src/apps/inline-thread-inventory.js';
import { loadInlineRootRepositories } from '../apps/server/src/server/config.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';

after(cleanupDatabases);
const repository = 'affank1020/atlas';
const prNumber = 126, head = 'a'.repeat(40);
const actor = { kind: 'mcp-oauth' as const, subject: 'auth0|author',
    issuer: 'https://issuer.example/' };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

async function fixture() {
    const { catalog, store } = await databaseFixture();
    await store.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Code Reviews',now(),now())",
        [CODE_REVIEWS_PROJECT_ID]);
    const runs = await catalog.createStore({
        projectId: CODE_REVIEWS_PROJECT_ID, name: 'Review Runs', fields: [
            { name:'repository',type:'string',required:true },
            { name:'prNumber',type:'number',required:true },
            { name:'headSha',type:'string',required:true },
            { name:'reviewer',type:'string',required:true },
            { name:'verdict',type:'enum',required:true,
                enumValues:['changes_requested','concerns_to_verify','non_blocking','no_findings','inconclusive'] },
            { name:'reviewedAt',type:'datetime',required:true },{ name:'coverage',type:'object' },
            { name:'schemaVersion',type:'number',required:true,default:1 },
        ] });
    const findings = await catalog.createStore({
        projectId: CODE_REVIEWS_PROJECT_ID, name: 'Review Findings', fields: [
            { name:'reviewRunId',type:'string',required:true },
            { name:'findingKey',type:'string',required:true },
            { name:'severity',type:'enum',required:true,
                enumValues:['sev1','sev2','sev3','sev4'] },
            { name:'title',type:'string',required:true },
            { name:'description',type:'string',required:true },
            { name:'filePath',type:'string' },{ name:'line',type:'number' },
            { name:'state',type:'enum',required:true,
                enumValues:['new','persisting','resolved','unverified'] },
            { name:'evidence',type:'object' },
        ] });
    const run = await catalog.createRecord({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: runs.id,
        data: { repository, prNumber, headSha: head, reviewer: 'Code Reviewer',
            verdict: 'changes_requested', reviewedAt: '2026-10-30T20:00:00.000Z',
            coverage: { source: 'atlas_structured_submission',
                submissionId: '76894d70-4b4d-481b-9d68-e05b1e536b01',
                payloadSha256: 'a'.repeat(64), findingCount: 1,
                authenticatedCaller: actor } },
    });
    const finding = await catalog.createRecord({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: findings.id,
        data: { reviewRunId: run.id, findingKey:
                'structured:76894d70-4b4d-481b-9d68-e05b1e536b01:target',
            title: 'Unexpected <user> `token`', severity: 'sev3',
            description: 'This path needs a guard.\nCannot trust user-provided paths.',
            filePath: 'src/new.ts', line: 14, state: 'new',
            evidence: { source: 'atlas_structured_submission',
                localKey: 'target', lineageKey: 'root-1' } },
    });
    const marker = inlineThreadMarker(repository, prNumber, 'root-1');
    const events = { head: 0, token: 0, post: 0, remote: 0 };
    let remoteBody: string | null = null;
    let headFailureAt = 0;
    let uncertainPost = false;
    const preflight = {
        preview: async () => ({
            repository, prNumber, status: 'review_head_current',
            runId: run.id, recordedRounds: 1, reviewedHeadSha: head,
            completeStructuredEvidence: true,
            findings: [{ findingId: finding.id, runId: run.id, lineageKey: 'root-1',
                path: 'src/new.ts', line: 14, classification: 'candidate', reason:'verified_new_line_candidate' }],
        }),
    };
    const inventory = {
        preview: async () => {
            events.remote++;
            return { repository, prNumber, runId: run.id, recordedRounds: 1,
                reviewedHeadSha: head, completeStructuredEvidence: true,
                findings: [{
                    findingId: finding.id, lineageKey: 'root-1',
                    ...(remoteBody ? { state: 'owned_thread_found' as const,
                        rootCommentId: 73, path: 'src/new.ts', originalLine: 14,
                        originalCommitSha: head, bodySha256: hash(remoteBody) } :
                        { state: 'no_owned_thread' as const }),
                }] };
        },
    };
    const writer = {
        checkHead: async () => {
            events.head++;
            if (headFailureAt === events.head)
                throw Error('PR head advanced before write');
        },
        prepareWrite: async () => {
            events.token++;
            return 'write-token';
        },
        post: async (_repo: string, _pr: number, target: any, body: string, token: string) => {
            assert.equal(token, 'write-token');
            assert.equal(target.headSha, head);
            assert.equal(target.path, 'src/new.ts');
            assert.equal(target.line, 14);
            assert.equal(body.endsWith(marker), true);
            assert.ok(!body.includes('<user>'), 'Markdown title must be escaped');
            events.post++;
            remoteBody = body;
            if (uncertainPost) throw Error('POST timed out after GitHub accepted it');
            return 73;
        },
    };
    const owned = {
        inspect: async () => ({ roots: remoteBody ? [{
            id: 73, marker, bodySha256: hash(remoteBody),
            path: 'src/new.ts', originalCommitSha: head,
            originalLine: 14, currentLine: 14,
            url: 'https://github.com/affank1020/atlas/pull/126#discussion_r73',
        }] : [], copiedMarkers: [], replies: new Map() }),
    };
    const service = new InlineRootPublicationService(catalog, preflight as any,
        inventory as any, writer as any, new Set([repository]), owned as any);
    return {
        catalog, runs, findings, finding, run, events, service, writer,
        publish: (apply: boolean, caller: typeof actor | undefined = actor) =>
            service.publish(repository, prNumber, finding.id, apply, caller),
        setHeadFailureAt: (n: number) => { headFailureAt = n; },
        setUncertainPost: (yes: boolean) => { uncertainPost = yes; },
        getRemote: () => remoteBody,
        clearRemote: () => { remoteBody = null; },
        setRemote: (body: string) => { remoteBody = body; },
    };
}

test('repository opt-in defaults disabled, rejects malformed names and refuses other OAuth authors', async () => {
    assert.equal(loadInlineRootRepositories({}).size, 0);
    assert.deepEqual([...loadInlineRootRepositories({
        ATLAS_CODE_REVIEW_INLINE_ROOT_REPOSITORIES: 'Affank1020/Atlas',
    })], [repository]);
    for (const invalid of ['../atlas','a/.','a/..','a/b,a/b','a/b,'])
        assert.throws(() => loadInlineRootRepositories({
            ATLAS_CODE_REVIEW_INLINE_ROOT_REPOSITORIES: invalid,
        }));
    const f = await fixture();
    await assert.rejects(new InlineRootPublicationService(
        f.catalog, {} as any, {} as any, f.writer as any)
        .publish(repository, prNumber, f.finding.id, false, actor), /disabled/);
    await assert.rejects(f.publish(false, { ...actor, subject: 'another' }), /authenticated submitter/);
    await assert.rejects(f.service.publish(repository, prNumber, f.finding.id, true), /authenticated MCP OAuth/);
    assert.equal(f.events.post, 0);
});

test('first inline root publishes once, repeats reconcile and never creates another comment', async () => {
    const f = await fixture();
    const ready = await f.publish(false);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.dryRun, true);
    assert.deepEqual([f.events.head, f.events.token, f.events.post], [0, 0, 0]);
    const before = await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID, f.findings.id, f.finding.id);
    assert.equal((before.data.evidence as any).githubInlineThread, undefined);

    const result = await f.publish(true);
    assert.equal(result.status, 'published');
    assert.equal(result.rootCommentId, 73);
    assert.equal(f.events.post, 1);
    const record = await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID, f.findings.id, f.finding.id);
    const claim = (record.data.evidence as any).githubInlineThread;
    assert.equal(claim.state, 'published');
    assert.equal(claim.rootCommentId, 73);
    assert.equal(claim.bodySha256, hash(f.getRemote()!));
    const replay = await f.publish(true);
    assert.equal(replay.status, 'published');
    assert.equal(replay.alreadyPublished, true);
    assert.equal(f.events.post, 1);
});

test('ambiguous POST is never retried; matching Bot root reconciles the exact content on next apply', async () => {
    const f = await fixture();
    f.setUncertainPost(true);
    assert.equal((await f.publish(true)).status, 'uncertain');
    assert.equal(f.events.post, 1);
    const saved = await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID, f.findings.id, f.finding.id);
    assert.equal((saved.data.evidence as any).githubInlineThread.state, 'claimed');
    assert.equal((await f.publish(true)).status, 'published');
    assert.equal(f.events.post, 1);
});

test('prior-round claimed inline root reconciles without checking a newer diff or resending', async () => {
    const f = await fixture();
    f.setUncertainPost(true);
    assert.equal((await f.publish(true)).status, 'uncertain');
    // A later saved run may become latest, but the old claim still has an
    // independently verified Bot root, identified by its original finding ID.
    await f.catalog.createRecord({ projectId: CODE_REVIEWS_PROJECT_ID, storeId: f.runs.id,
        data: { repository, prNumber, headSha: 'b'.repeat(40),
            reviewer: 'Code Reviewer', verdict: 'no_findings',
            reviewedAt: '2026-10-30T21:00:00.000Z',
            coverage: { source: 'atlas_structured_submission',
                submissionId: 'ed18bec8-59b2-47a9-824c-0ae7153a4573',
                payloadSha256: 'b'.repeat(64), findingCount: 0,
                authenticatedCaller: actor } },
    });
    const recovered = await f.publish(true);
    assert.equal(recovered.status, 'published');
    assert.equal(recovered.rootCommentId, 73);
    assert.equal(f.events.post, 1);
});

test('POST fails before GitHub accepts: existing claim stays uncertain and cannot automatically resend', async () => {
    const f = await fixture();
    f.setUncertainPost(true);
    assert.equal((await f.publish(true)).status, 'uncertain');
    f.clearRemote();
    assert.equal((await f.publish(true)).status, 'uncertain');
    assert.equal(f.events.post, 1);
});

test('post-claim but pre-write head rejection releases the exact unsent claim', async () => {
    const f = await fixture();
    f.setHeadFailureAt(2);
    await assert.rejects(f.publish(true), /PR head advanced before write/);
    assert.equal(f.events.post, 0);
    const record = await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID, f.findings.id, f.finding.id);
    assert.equal((record.data.evidence as any).githubInlineThread, undefined);
    f.setHeadFailureAt(0);
    assert.equal((await f.publish(true)).status, 'published');
    assert.equal(f.events.post, 1);
});

test('concurrent publications are transactionally fenced to at most one POST', async () => {
    const f = await fixture();
    const runs = await Promise.allSettled([f.publish(true), f.publish(true)]);
    assert.equal(f.events.post, 1);
    assert.equal(runs.some(x => x.status === 'fulfilled'), true);
});

test('GitHub writer sends only one anchored RIGHT-side inline root with scoped auth', async () => {
    const calls: { path: string; method: string; body: string | undefined }[] = [];
    const github = new GitHubInlineRootWriter({
        pullRequestReadToken: async () => 'read-token',
        pullRequestPublishToken: async () => 'write-token',
    } as any, (async (url: string, init: RequestInit) => {
        calls.push({ path: url, method: init.method!, body: init.body as string });
        assert.equal((init.headers as any).Authorization,
            'Bearer ' + (init.method === 'GET' ? 'read-token' : 'write-token'));
        return new Response(JSON.stringify(init.method === 'GET'
            ? { number: prNumber, state: 'open', base: { repo: { full_name: repository } },
                head: { sha: head } } : { id: 73 }), { status: 200 });
    }) as typeof fetch);
    await github.checkHead('Affank1020/Atlas', prNumber, head);
    const token = await github.prepareWrite(repository);
    assert.equal(token, 'write-token');
    assert.equal(await github.post(repository, prNumber,
        { headSha: head, path: 'src/new.ts', line: 14 }, 'body\n' +
        inlineThreadMarker(repository, prNumber, 'root-1'), token), 73);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[1]!.method, 'POST');
    const parsed = JSON.parse(calls[1]!.body!);
    assert.deepEqual({
        commit_id: parsed.commit_id, path: parsed.path, line: parsed.line, side: parsed.side,
    }, { commit_id: head, path: 'src/new.ts', line: 14, side: 'RIGHT' });
    assert.ok(calls[1]!.path.endsWith('/pulls/126/comments'));
});
