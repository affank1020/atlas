import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { CodeReviewsService, codeReviewsApplication } from '../apps/server/src/apps/code-reviews.js';
import { ReviewPublicationService } from '../apps/server/src/apps/review-publication.js';
import { GitHubReviewPublisher, renderReview } from '../apps/server/src/apps/github-review-publisher.js';
import { loadCodeReviewPublishRepositories } from '../apps/server/src/server/config.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { databaseFixture, cleanupDatabases } from './database.js';

after(cleanupDatabases);
const repository = 'affank1020/atlas';
const sha = 'a'.repeat(40);
const actor = { kind: 'mcp-oauth' as const, subject: 'auth0|owner', issuer: 'https://oauth.example.com/' };
const submission = {
    submissionId: '3c7435fa-956e-4ba1-b759-e9805570a33c', repository, prNumber: 84,
    headSha: sha, verdict: 'non_blocking' as const, summary: 'An independently recorded finding.',
    findings: [{ key: 'f1', severity: 'sev3' as const, title: 'Check this branch',
        description: 'The new line needs a guard.', filePath: 'src/new.ts', line: 15 }],
};

async function fixture() {
    const { catalog, store } = await databaseFixture();
    await store.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Code Reviews',now(),now())",
        [CODE_REVIEWS_PROJECT_ID],
    );
    const runs = await catalog.createStore({ projectId: CODE_REVIEWS_PROJECT_ID, name: 'Review Runs', fields: [
        { name:'repository',type:'string',required:true },{ name:'prNumber',type:'number',required:true },
        { name:'headSha',type:'string',required:true },{ name:'reviewer',type:'string',required:true },
        { name:'verdict',type:'enum',required:true,
          enumValues:['changes_requested','concerns_to_verify','non_blocking','no_findings','inconclusive'] },
        { name:'reviewedAt',type:'datetime',required:true },{ name:'githubReviewId',type:'string' },
        { name:'coverage',type:'object' },{ name:'counts',type:'object' },
        { name:'schemaVersion',type:'number',required:true,default:1 },
    ] });
    await catalog.createStore({ projectId: CODE_REVIEWS_PROJECT_ID, name: 'Review Findings', fields: [
        { name:'reviewRunId',type:'string',required:true },{ name:'findingKey',type:'string',required:true },
        { name:'severity',type:'enum',required:true,enumValues:['sev1','sev2','sev3','sev4'] },
        { name:'title',type:'string',required:true },{ name:'description',type:'string',required:true },
        { name:'filePath',type:'string' },{ name:'line',type:'number' },
        { name:'state',type:'enum',required:true,enumValues:['new','persisting','resolved','unverified'] },
        { name:'evidence',type:'object' },{ name:'schemaVersion',type:'number',required:true,default:1 },
    ] });
    const service = new CodeReviewsService(catalog, {
        read: async () => ({ reviews: [], comments: [] }),
        currentHead: async () => ({ repository, prNumber:84, headSha: sha, open: true }),
    });
    const first = await service.submitStructuredReview(submission, actor);
    return { catalog, store, runs, runId: first.runId as string };
}
const result = { id: 1234, url: 'https://github.com/affank1020/atlas/pull/84#pullrequestreview-1234' };
function mock(overrides: Record<string, any> = {}) {
    const events = { checked:0, diff:0, searched:0, published:0 };
    const github = {
        checkHead: async () => { events.checked++; return 'scoped-read-token'; },
        inlineComments: async () => { events.diff++; return []; },
        findPublished: async () => { events.searched++; return undefined; },
        prepareWrite: async () => 'scoped-write-token',
        publish: async () => { events.published++; return result; },
        ...overrides,
    };
    return { github, events };
}

test('publication defaults disabled, rejects caller spoofing, and never writes on preview', async () => {
    const { catalog, runs, runId } = await fixture();
    const { github, events } = mock();
    const disabled = new ReviewPublicationService(catalog, github);
    await assert.rejects(disabled.publishRun(runId, false, true, actor), /not enabled/);
    assert.equal(events.checked,0);
    const publish = new ReviewPublicationService(catalog, github, new Set([repository]));
    await assert.rejects(publish.publishRun(runId,false,true), /authenticated MCP OAuth/);
    await assert.rejects(publish.publishRun(runId,false,true,{...actor,subject:'auth0|other'}), /another authenticated caller/);
    const preview = await publish.publishRun(runId,false,false,actor);
    assert.equal(preview.status,'ready');
    assert.equal(preview.dryRun,true);
    assert.equal(preview.event,'COMMENT');
    assert.equal(preview.inlineCount,0);
    assert.equal(events.published,0);
    const saved = await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id});
    assert.equal((saved.items[0]!.data.coverage as any).githubPublication,undefined);
});

test('apply posts exactly once and returns the committed GitHub review on retry', async () => {
    const { catalog, runs, runId } = await fixture();
    const { github, events } = mock();
    const pub = new ReviewPublicationService(catalog, github, new Set([repository]));
    const reply = await pub.publishRun(runId,false,true,actor);
    assert.equal(reply.status,'published');
    assert.equal(reply.githubReviewId,String(result.id));
    assert.equal(events.published,1);
    const replay = await pub.publishRun(runId,false,true,actor);
    assert.equal(replay.status,'published');
    assert.equal(replay.alreadyPublished,true);
    assert.equal(events.published,1);
    const stored=await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id});
    const status = (stored.items[0]!.data.coverage as any).githubPublication;
    assert.equal(status.state,'published');
    assert.equal(status.githubReviewId,String(result.id));
    await assert.rejects(pub.publishRun(runId,true,true,actor), /differs from this content or mode/);
});

test('ambiguous remote outcome is never auto-reposted; explicit call can reconcile existing marker', async () => {
    const { catalog, runs, runId } = await fixture();
    let remoteFound = false, posts = 0;
    const { github } = mock({
        findPublished: async () => remoteFound ? {
            id: result.id, html_url: result.url, body: 'record', commit_id: sha, state: 'COMMENTED' } : undefined,
        publish: async () => { posts++; throw new Error('timeout after sending'); },
    });
    const pub = new ReviewPublicationService(catalog, github, new Set([repository]));
    await assert.rejects(pub.publishRun(runId,false,true,actor), /timeout after sending/);
    assert.equal(posts,1);
    const stored=await catalog.queryRecords({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id});
    assert.equal((stored.items[0]!.data.coverage as any).githubPublication.state,'claimed');
    const uncertain = await pub.publishRun(runId,false,true,actor);
    assert.equal(uncertain.status,'uncertain');
    assert.equal(uncertain.postedAgain,false);
    assert.equal(posts,1);
    remoteFound=true;
    const confirmed = await pub.publishRun(runId,false,true,actor);
    assert.equal(confirmed.status,'published');
    assert.equal(posts,1);
});

test('a concurrent caller cannot claim or send a duplicate review', async () => {
    const { catalog, runId } = await fixture();
    let unblock!: (value: typeof result) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => {started=resolve;});
    let posts=0;
    const { github }=mock({
        publish: async () => {
            posts++;
            started();
            return new Promise<typeof result>(resolve=>{unblock=resolve;});
        },
    });
    const pub = new ReviewPublicationService(catalog,github,new Set([repository]));
    const first = pub.publishRun(runId,false,true,actor);
    await entered;
    const another = await pub.publishRun(runId,false,true,actor);
    assert.equal(another.status,'uncertain');
    assert.equal(posts,1);
    unblock(result);
    assert.equal((await first).status,'published');
});

test('remote publisher sends COMMENT only and refuses non-added or duplicated inline positions', async () => {
    const requests: { url: string; method: string; body?: any }[]=[];
    const broker = {
        pullRequestReadToken: async () => 'read-token',
        pullRequestPublishToken: async () => 'write-token',
    };
    const publisher = new GitHubReviewPublisher(broker, (async (url:string,options:RequestInit) => {
        requests.push({url,method:options.method || 'GET',body:options.body ? JSON.parse(String(options.body)) : undefined});
        if (url.endsWith('/pulls/84')) return new Response(JSON.stringify({
            number:84,state:'open',base:{repo:{full_name:repository}},head:{sha},
        }),{status:200});
        if (url.includes('/files?'))return new Response(JSON.stringify([
            {filename:'src/new.ts',status:'modified',
                patch:'@@ -10,2 +10,6 @@\n context\n+plus\n+plus2\n context\n-old\n+plus3\n+plus4'},
        ]),{status:200});
        if (url.includes('/reviews?')) return new Response(JSON.stringify([]),{status:200});
        if (url.endsWith('/reviews'))return new Response(JSON.stringify({
            id:1234,html_url:result.url,commit_id:sha,
        }),{status:201});
        throw Error('unexpected URL');
    }) as typeof fetch);
    const payload = {runId:'3c7435fa-956e-4ba1-b759-e9805570a33c',
        repository,prNumber:84,headSha:sha,verdict:'non_blocking',
        findings:[{key:'f1',severity:'sev3',title:'Line',description:'Explain',path:'src/new.ts',line:11}]};
    const token=await publisher.checkHead(payload);
    const comments=await publisher.inlineComments(payload,token,true);
    assert.equal(comments.length,1);
    assert.deepEqual(comments[0]?.path,'src/new.ts');
    const body=renderReview(payload).body;
    await publisher.publish(payload,body,comments);
    const write=requests.find(x=>x.method==='POST');
    assert.equal(write?.body.event,'COMMENT');
    assert.equal(write?.body.commit_id,sha);
    assert.equal(write?.body.comments[0].side,'RIGHT');
    assert.equal(write?.body.comments[0].line,11);
    await assert.rejects(publisher.inlineComments({...payload,findings:[{...payload.findings[0]!,line:10}]},token,true),
        /not on an added/);
    await assert.rejects(publisher.inlineComments({...payload,findings:[payload.findings[0]!,payload.findings[0]!]},token,true),
        /Duplicate inline/);
});

test('render marker is tied to Atlas run and publish config is strict and opt-in', () => {
    assert.equal(loadCodeReviewPublishRepositories({}).size,0);
    assert.deepEqual([...loadCodeReviewPublishRepositories({ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES:'Affank1020/Atlas'})],
        [repository]);
    for (const raw of ['*','invalid','a/b,a/b','a/b,','a/b,not/a/repo'])
        assert.throws(()=>loadCodeReviewPublishRepositories({ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES:raw}));
    const body=renderReview({runId:'3c7435fa-956e-4ba1-b759-e9805570a33c',
        repository,prNumber:84,headSha:sha,verdict:'no_findings',findings:[]});
    assert.match(body.marker,/^<!-- atlas-code-review-run:[a-f0-9-]{36} -->$/);
    assert.ok(body.body.endsWith(body.marker));
});
