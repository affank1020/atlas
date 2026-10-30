import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import { ManagedSummaryPublicationService } from '../apps/server/src/apps/managed-summary-publication.js';
import { GitHubManagedSummaryWriter } from '../apps/server/src/apps/managed-summary-github.js';
import { ManagedSummaryPreviewService } from '../apps/server/src/apps/managed-summary.js';
import { CodeReviewsService, codeReviewsApplication } from '../apps/server/src/apps/code-reviews.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';
import { loadManagedSummaryRepositories } from '../apps/server/src/server/config.js';
import { databaseFixture, cleanupDatabases } from './database.js';

after(cleanupDatabases);
const repository = 'affank1020/atlas';
const prNumber = 84;
const head = 'a'.repeat(40);
const subject = { kind: 'mcp-oauth' as const, issuer: 'https://issuer.example/', subject: 'auth0|reviewer' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
    const { catalog, store } = await databaseFixture();
    await store.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Code Reviews',now(),now())",
        [CODE_REVIEWS_PROJECT_ID]);
    const runs = await catalog.createStore({
        projectId: CODE_REVIEWS_PROJECT_ID, name: 'Review Runs', fields: [
            { name: 'repository', type: 'string', required: true },
            { name: 'prNumber', type: 'number', required: true },
            { name: 'headSha', type: 'string', required: true },
            { name: 'reviewer', type: 'string', required: true },
            { name: 'verdict', type: 'enum', required: true,
                enumValues: ['changes_requested', 'concerns_to_verify', 'non_blocking', 'no_findings', 'inconclusive'] },
            { name: 'reviewedAt', type: 'datetime', required: true },
            { name: 'coverage', type: 'object' },
            { name: 'schemaVersion', type: 'number', required: true, default: 1 },
        ],
    });
    await catalog.createStore({
        projectId: CODE_REVIEWS_PROJECT_ID, name: 'Review Findings', fields: [
            { name: 'reviewRunId', type: 'string', required: true },
            { name: 'findingKey', type: 'string', required: true },
            { name: 'severity', type: 'enum', required: true,
                enumValues: ['sev1','sev2','sev3','sev4'] },
            { name: 'title', type: 'string', required: true },
            { name: 'description', type: 'string', required: true },
            { name: 'state', type: 'enum', required: true,
                enumValues: ['new','persisting','resolved','unverified'] },
            { name: 'evidence', type: 'object' },
        ],
    });
    async function addRound(timestamp: string, identity = repository, reviewedHead = head) {
        return catalog.createRecord({ projectId: CODE_REVIEWS_PROJECT_ID,
            storeId: runs.id, data: {
                repository: identity, prNumber, headSha: reviewedHead,
                reviewer: 'Code Reviewer', verdict: 'no_findings',
                reviewedAt: timestamp,
                coverage: {
                    source: 'atlas_structured_submission',
                    submissionId: '76894d70-4b4d-481b-9d68-e05b1e536b01',
                    payloadSha256: 'd'.repeat(64),
                    findingCount: 0, authenticatedCaller: subject,
                },
            } });
    }
    const first = await addRound('2026-10-30T10:00:00.000Z');
    let remote: null | { id: number; body: string } = null;
    const events = { head: 0, token: 0, post: 0, patch: 0, inspect: 0 };
    let postMode: 'normal' | 'throw_before' | 'throw_after' = 'normal';
    let patchMode: 'normal' | 'throw_before' | 'throw_after' = 'normal';
    let staleHead = false;
    let currentHead = head;
    let failCheckAt: number | null = null;
    const preview = new ManagedSummaryPreviewService(catalog, {
        inspect: async (repo: string, number: number, body: string) => {
            events.inspect++;
            assert.equal(repo, repository);
            assert.equal(number, prNumber);
            if (!remote) return { status: 'no_owned_comment' };
            return {
                status: remote.body === body ? 'current' : 'needs_update',
                commentId: remote.id,
                commentUrl: 'https://github.com/affank1020/atlas/pull/84#issuecomment-' + remote.id,
                bodySha256: hash(remote.body),
            };
        },
    } as any);
    const writer = {
        checkHead: async (_repo: string, _pr: number, reviewedHead: string) => {
            events.head++;
            if (failCheckAt === events.head) {
                currentHead = 'b'.repeat(40);
                throw Error('PR head advanced between preflight and publication');
            }
            if (staleHead || reviewedHead !== currentHead)
                throw Error('PR head advanced');
        },
        prepareWrite: async () => { events.token++; return 'scoped-write-token'; },
        post: async (_repo: string, number: number, body: string, token: string) => {
            assert.equal(number, prNumber); assert.equal(token, 'scoped-write-token');
            events.post++;
            if (postMode === 'throw_before') throw Error('POST timed out before write');
            remote = { id: 73, body };
            if (postMode === 'throw_after') throw Error('POST timed out after write');
            return remote.id;
        },
        patch: async (_repo: string, commentId: number, body: string, token: string) => {
            assert.equal(commentId, 73); assert.equal(token, 'scoped-write-token');
            events.patch++;
            if (patchMode === 'throw_before') throw Error('PATCH timed out before write');
            remote = { id: 73, body };
            if (patchMode === 'throw_after') throw Error('PATCH timed out after write');
            return commentId;
        },
    };
    const publish = new ManagedSummaryPublicationService(catalog, preview,
        writer, new Set([repository]));
    const service = new CodeReviewsService(catalog, undefined, new Map(),
        undefined, preview, publish);
    const app = new ApplicationRegistry([codeReviewsApplication(service)]);
    const invoke = (apply: boolean, actor: typeof subject | undefined = subject) =>
        app.invoke('code_reviews_managed_summary_publish',
            { repository: 'Affank1020/Atlas', prNumber, apply }, actor) as Promise<any>;
    return { catalog, runs, first, addRound, events, invoke, preview, writer,
        publish, getRemote: () => remote, setRemote: (value: null | {id: number; body: string}) => { remote = value; },
        setPostMode: (mode: typeof postMode) => { postMode = mode; },
        setPatchMode: (mode: typeof patchMode) => { patchMode = mode; },
        setStaleHead: (value: boolean) => { staleHead = value; },
        setHeadFailureAt: (number: number | null) => { failCheckAt = number; },
        setCurrentHead: (sha: string) => { currentHead = sha; } };
}

test('managed publication is separately disabled, requires OAuth and preflights without GitHub writes', async () => {
    assert.equal(loadManagedSummaryRepositories({}).size, 0);
    const configured = loadManagedSummaryRepositories({
        ATLAS_CODE_REVIEW_MANAGED_SUMMARY_REPOSITORIES: 'Affank1020/Atlas',
    });
    assert.deepEqual([...configured], [repository]);
    for (const invalid of ['../repo','a/.','a/..','a/repo,a/repo','a/repo,']) {
        assert.throws(() => loadManagedSummaryRepositories({
            ATLAS_CODE_REVIEW_MANAGED_SUMMARY_REPOSITORIES: invalid,
        }));
    }
    const f = await fixture();
    const denied = new ManagedSummaryPublicationService(f.catalog, f.preview, f.writer);
    await assert.rejects(denied.publish(repository,prNumber,false,subject), /disabled/);
    await assert.rejects(
        new ApplicationRegistry([codeReviewsApplication(
            new CodeReviewsService(f.catalog, undefined, new Map(), undefined, f.preview,
                new ManagedSummaryPublicationService(f.catalog, f.preview, f.writer,
                    new Set([repository]))))])
            .invoke('code_reviews_managed_summary_publish', { repository, prNumber, apply: true }),
        /authenticated MCP OAuth/);
    await assert.rejects(f.invoke(true, { ...subject, subject: 'other' }), /another|Only complete native reviews/);
    const plan = await f.invoke(false);
    assert.equal(plan.status, 'ready');
    assert.equal(plan.mode, 'create');
    assert.equal(plan.dryRun, true);
    assert.deepEqual([f.events.head, f.events.token, f.events.post, f.events.patch], [0,0,0,0]);
    const row = await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID, f.runs.id, f.first.id);
    assert.equal((row.data.coverage as any).githubManagedSummary, undefined);
});

test('managed summary POST is exactly once, then updates same owned comment for next review', async () => {
    const f = await fixture();
    const first = await f.invoke(true);
    assert.equal(first.status, 'published');
    assert.equal(first.commentId, 73);
    assert.equal(f.events.post, 1);
    const claim = (await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.runs.id,f.first.id)).data.coverage as any;
    assert.equal(claim.githubManagedSummary.state, 'published');
    assert.equal(claim.githubManagedSummary.mode, 'create');
    assert.equal(claim.githubManagedSummary.bodySha256, hash(f.getRemote()!.body));
    const again = await f.invoke(true);
    assert.equal(again.alreadyPublished, true);
    assert.equal(f.events.post, 1);

    await f.addRound('2026-10-30T11:00:00.000Z');
    const plan = await f.invoke(false);
    assert.equal(plan.mode, 'update');
    assert.equal(plan.commentId, 73);
    assert.equal(f.events.patch, 0);
    const updated = await f.invoke(true);
    assert.equal(updated.status, 'published');
    assert.equal(updated.commentId, 73);
    assert.equal(f.events.post, 1);
    assert.equal(f.events.patch, 1);
    const replay = await f.invoke(true);
    assert.equal(replay.alreadyPublished, true);
    assert.equal(f.events.patch, 1);
});

test('POST timeout cannot repeat: an absent remote stays uncertain; matching remote reconciles read-only', async () => {
    const f = await fixture();
    f.setPostMode('throw_before');
    assert.equal((await f.invoke(true)).status, 'uncertain');
    assert.equal((await f.invoke(true)).status, 'uncertain');
    assert.equal(f.events.post, 1);
    const run = await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.runs.id,f.first.id);
    const claim = (run.data.coverage as any).githubManagedSummary;
    assert.equal(claim.state, 'claimed');
    assert.equal(claim.mode, 'create');
    // A POST that succeeded before timing out must reconcile without POSTing twice.
    const g = await fixture();
    g.setPostMode('throw_after');
    assert.equal((await g.invoke(true)).status, 'uncertain');
    assert.equal((await g.invoke(false)).status, 'found_on_github');
    assert.equal((await g.invoke(true)).status, 'published');
    assert.equal(g.events.post, 1);
});

test('PATCH timeout remains claimed and never overwrites previous or another writer', async () => {
    const f = await fixture();
    await f.invoke(true);
    await f.addRound('2026-10-30T11:00:00.000Z');
    f.setPatchMode('throw_before');
    assert.equal((await f.invoke(true)).status, 'uncertain');
    assert.equal((await f.invoke(true)).status, 'uncertain');
    assert.equal(f.events.patch, 1);
    const g = await fixture();
    await g.invoke(true);
    await g.addRound('2026-10-30T11:00:00.000Z');
    g.setPatchMode('throw_after');
    assert.equal((await g.invoke(true)).status, 'uncertain');
    assert.equal((await g.invoke(true)).status, 'published');
    assert.equal(g.events.patch, 1);
    g.setRemote({ id: 73, body: 'external edit by bot' });
    assert.equal((await g.invoke(true)).status, 'published_remote_drift');
    assert.equal(g.events.patch, 1);
});

test('new review after ambiguous older create reconciles the older claim first', async () => {
    const f = await fixture();
    f.setPostMode('throw_after');
    assert.equal((await f.invoke(true)).status, 'uncertain');
    await f.addRound('2026-10-30T12:00:00.000Z');
    assert.equal((await f.invoke(true)).status, 'reconciled_previous_round');
    assert.equal(f.events.post, 1);
    assert.equal(f.events.patch, 0);
    assert.equal((await f.invoke(true)).status, 'published');
    assert.equal(f.events.patch, 1);
});

test('head changes only on second check: unsent claim is released and a new reviewed head can publish', async () => {
    const f = await fixture();
    f.setHeadFailureAt(2);
    await assert.rejects(f.invoke(true), /PR head advanced between preflight and publication/);
    assert.equal(f.events.head, 2, 'pre-claim head check passes and post-claim read fails');
    assert.equal(f.events.token, 1, 'the write token was prepared');
    assert.equal(f.events.post, 0, 'no POST was attempted');
    assert.equal(f.events.patch, 0, 'no PATCH was attempted');

    const old = await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID, f.runs.id, f.first.id);
    assert.equal((old.data.coverage as any).githubManagedSummary, undefined,
        'failed read-only head check transactionally releases its own claim');

    await assert.rejects(f.invoke(true), /PR head advanced/,
        'old reviewed SHA cannot be published after the PR head advances');
    assert.equal(f.events.post, 0);
    const newRun = await f.addRound('2026-10-30T12:00:00.000Z',
        repository, 'b'.repeat(40));
    const fresh = await f.invoke(true);
    assert.equal(fresh.status, 'published');
    assert.equal(fresh.runId, newRun.id);
    assert.equal(f.events.post, 1, 'new reviewed head can create the one managed comment');
    const previous = await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID, f.runs.id, f.first.id);
    assert.equal((previous.data.coverage as any).githubManagedSummary, undefined);
});

test('transient second head-read failure releases unsent claim so the same round can retry', async () => {
    const f = await fixture();
    f.setHeadFailureAt(2);
    await assert.rejects(f.invoke(true), /between preflight and publication/);
    assert.equal(f.events.post, 0);
    f.setCurrentHead(head);
    f.setHeadFailureAt(null);
    const retried = await f.invoke(true);
    assert.equal(retried.status, 'published');
    assert.equal(f.events.post, 1);
});

test('unverified remote owner and stale PR heads fail before durable publication', async () => {
    const f = await fixture();
    f.setRemote({ id: 73, body: 'stray managed summary' });
    await assert.rejects(f.invoke(true), /Unclaimed bot-owned/);
    assert.equal(f.events.post, 0);
    f.setRemote(null);
    f.setStaleHead(true);
    await assert.rejects(f.invoke(true), /PR head advanced/);
    assert.equal(f.events.post, 0);
    const state = await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.runs.id,f.first.id);
    assert.equal((state.data.coverage as any).githubManagedSummary, undefined);
});

test('concurrent summary claims never create two comments', async () => {
    const f = await fixture();
    const settled = await Promise.allSettled([f.invoke(true), f.invoke(true)]);
    assert.equal(f.events.post, 1, 'concurrent requests cannot both POST');
    assert.equal(f.getRemote()?.id, 73);
    const accepted = settled.filter(x => x.status === 'fulfilled');
    assert.ok(accepted.length >= 1, 'one concurrent request must publish');
    assert.ok(accepted.every(x => x.value.status === 'published'),
        'a later observer can return an already-published receipt');
    // Depending on which snapshot wins, the other call either detects the
    // changed claim and conflicts or sees the completed published receipt.
});

test('GitHub issue comment writer verifies base PR, unchanged head, methods and scoped tokens', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const client = new GitHubManagedSummaryWriter({
        pullRequestReadToken: async (repo: string) => { assert.equal(repo,repository); return 'read'; },
        pullRequestPublishToken: async (repo: string) => { assert.equal(repo,repository); return 'write'; },
    }, (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method!, body: init.body as string });
        assert.equal((init.headers as any).Authorization, 'Bearer ' +
            (init.method === 'GET' ? 'read' : 'write'));
        if (url.endsWith('/pulls/84'))
            return new Response(JSON.stringify({
                number: prNumber, state: 'open', base: { repo: { full_name: repository } },
                head: { sha: head },
            }), { status: 200 });
        return new Response(JSON.stringify({ id: 73 }), { status: 200 });
    }) as typeof fetch);
    await client.checkHead('Affank1020/Atlas',prNumber,head);
    const token = await client.prepareWrite(repository);
    assert.equal(token, 'write');
    await client.post(repository,prNumber,'first',token);
    await client.patch(repository,73,'second',token);
    assert.equal(calls.length, 3);
    assert.ok(calls[1]!.url.endsWith('/issues/84/comments'));
    assert.ok(calls[2]!.url.endsWith('/issues/comments/73'));
    assert.equal(calls[1]!.method, 'POST');
    assert.equal(calls[2]!.method, 'PATCH');
});
