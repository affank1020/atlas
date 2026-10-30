import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { InlineFixPublicationService, inlineFixMarker } from '../apps/server/src/apps/inline-fix-publication.js';
import { inlineThreadMarker } from '../apps/server/src/apps/inline-thread-inventory.js';
import { GitHubInlineReplyRejectedError } from '../apps/server/src/apps/inline-thread-writer.js';
import { loadInlineFixRepositories } from '../apps/server/src/server/config.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';

after(cleanupDatabases);
const repository='affank1020/atlas', prNumber=130;
const head0='a'.repeat(40), head1='b'.repeat(40);
const actor={kind:'mcp-oauth' as const,subject:'test-reviewer',issuer:'https://issuer.example/'};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const priorSubmission='76894d70-4b4d-481b-9d68-e05b1e536b01';
const fixSubmission='ed18bec8-59b2-47a9-824c-0ae7153a4573';
const reviewedAt='2026-10-30T20:00:00.000Z';
const rootMarker=inlineThreadMarker(repository,prNumber,'root-a');
const rootBody='Old source issue.\n'+rootMarker;
const evidence='The regression suite now shows the unsafe request is rejected.';

async function fixture(){
    const {catalog,store}=await databaseFixture();
    await store.pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Code Reviews',now(),now())",
        [CODE_REVIEWS_PROJECT_ID]);
    const runs=await catalog.createStore({
        projectId:CODE_REVIEWS_PROJECT_ID,name:'Review Runs',fields:[
            {name:'repository',type:'string',required:true},
            {name:'prNumber',type:'number',required:true},
            {name:'headSha',type:'string',required:true},
            {name:'reviewer',type:'string',required:true},
            {name:'verdict',type:'enum',required:true,
                enumValues:['changes_requested','concerns_to_verify','non_blocking','no_findings','inconclusive']},
            {name:'reviewedAt',type:'datetime',required:true},
            {name:'coverage',type:'object'},
            {name:'schemaVersion',type:'number',required:true,default:1},
        ],
    });
    const findings=await catalog.createStore({
        projectId:CODE_REVIEWS_PROJECT_ID,name:'Review Findings',fields:[
            {name:'reviewRunId',type:'string',required:true},
            {name:'findingKey',type:'string',required:true},
            {name:'severity',type:'enum',required:true,enumValues:['sev1','sev2','sev3','sev4']},
            {name:'title',type:'string',required:true},
            {name:'description',type:'string',required:true},
            {name:'filePath',type:'string'},{name:'line',type:'number'},
            {name:'state',type:'enum',required:true,
                enumValues:['new','persisting','resolved','unverified']},
            {name:'evidence',type:'object'},
        ],
    });
    const original=await catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id,
        data:{repository,prNumber,headSha:head0,reviewer:'Code Reviewer',
            verdict:'changes_requested',reviewedAt:'2026-10-30T18:00:00.000Z',
            coverage:{source:'atlas_structured_submission',submissionId:priorSubmission,
                payloadSha256:'a'.repeat(64),findingCount:1,authenticatedCaller:actor}},
    });
    const rootFinding=await catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,
        storeId:findings.id,data:{reviewRunId:original.id,
            findingKey:'structured:'+priorSubmission+':old',
            title:'Unvalidated input',severity:'sev3',description:'An unsafe path exists.',
            filePath:'src/a.ts',line:10,state:'new',
            evidence:{source:'atlas_structured_submission',localKey:'old',lineageKey:'root-a'}},
    });
    await catalog.store.transaction(state=>catalog.updateRecordInState(state,{
        projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id,
        recordId:rootFinding.id,client:'test-original-root',
        data:{evidence:{...rootFinding.data.evidence,
            githubInlineThread:{state:'published',claimId:'e089844a-724e-4964-b4c0-0f662cd27860',
                findingId:rootFinding.id,rootCommentId:73,marker:rootMarker,
                bodySha256:sha(rootBody),headSha:head0,path:'src/a.ts',line:10,
                claimedAt:'2026-10-30T18:00:00.000Z'}}},
    }));
    const resolution={lineageKey:'root-a',state:'resolved',evidence,
        assessmentSource:'authenticated_structured_submission',
        assessedHeadSha:head1,assertedAt:reviewedAt};
    const run=await catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id,
        data:{repository,prNumber,headSha:head1,reviewer:'Code Reviewer',
            verdict:'no_findings',reviewedAt,coverage:{
                source:'atlas_structured_submission',submissionId:fixSubmission,
                payloadSha256:'b'.repeat(64),findingCount:0,authenticatedCaller:actor,
                lifecycleResolutions:[resolution]}},
    });
    const fixMarker=inlineFixMarker(repository,prNumber,73,run.id,'root-a');
    const events={heads:0,tokens:0,posts:0,reads:0};
    let remoteBody:string|null=null,timeout=false,failedStatus:403|422|null=null,
        readFailureAt=0,headFailureAt=0,copied=false;
    const githubRoots={inspect:async()=>{
        events.reads++;
        if(events.reads===readFailureAt)throw Error('Inventory temporarily unavailable');
        return {roots:[{id:73,marker:rootMarker,bodySha256:sha(rootBody),
            originalCommitSha:head0,path:'src/a.ts',originalLine:10,currentLine:null,
            url:'https://github.com/affank1020/atlas/pull/130#discussion_r73'}],
            copiedMarkers:[],replies:new Map(),
            managedReplies:[],copiedReplyMarkers:[],
            managedFixReplies:remoteBody?[{id:501,parentId:73,marker:fixMarker,
                bodySha256:sha(remoteBody)}]:[],
            copiedFixMarkers:copied?[fixMarker]:[]};
    }};
    const writer={
        checkHead:async()=>{
            events.heads++;if(events.heads===headFailureAt)throw Error('Head advanced');
        },
        prepareWrite:async()=>{events.tokens++;return 'write-token';},
        postReply:async (_repo:string,_pr:number,parent:number,body:string,token:string)=>{
            events.posts++;
            assert.equal(parent,73);assert.equal(token,'write-token');
            assert.ok(body.endsWith(fixMarker));
            assert.match(body,/does not resolve the GitHub discussion/);
            assert.match(body,/reviewer assessment: addressed/);
            if(failedStatus!==null)throw new GitHubInlineReplyRejectedError(failedStatus);
            remoteBody=body;
            if(timeout)throw Error('Timeout after successful GitHub reply creation');
            return 501;
        },
    };
    const service=new InlineFixPublicationService(catalog,githubRoots as any,writer as any,new Set([repository]));
    return {catalog,runs,findings,run,rootFinding,events,service,
        inspect:githubRoots,post:writer,
        publish:(apply:boolean,user:typeof actor|undefined=actor)=>
            service.publish(repository,prNumber,run.id,'root-a',apply,user),
        status:(v:403|422|null)=>{failedStatus=v;},
        timeout:(v:boolean)=>{timeout=v;},
        remote:(v:string|null)=>{remoteBody=v;},
        headFails:(n:number)=>{headFailureAt=n;},
        readFails:(n:number)=>{readFailureAt=n;},
        copied:(v:boolean)=>{copied=v;},
    };
}

test('fix publisher has separate disabled-by-default allowlist and authenticated owner',async()=>{
    assert.equal(loadInlineFixRepositories({}).size,0);
    assert.deepEqual([...loadInlineFixRepositories({
        ATLAS_CODE_REVIEW_INLINE_FIX_REPOSITORIES:'Affank1020/Atlas',
    })],[repository]);
    assert.throws(()=>loadInlineFixRepositories({
        ATLAS_CODE_REVIEW_INLINE_FIX_REPOSITORIES:'a/b,a/b',
    }));
    const f=await fixture();
    await assert.rejects(
        new InlineFixPublicationService(f.catalog,{} as any,{} as any)
            .publish(repository,prNumber,f.run.id,'root-a',true,actor),/disabled/);
    await assert.rejects(f.publish(false,{...actor,subject:'another'}),/authenticated reviewer/);
    await assert.rejects(
        f.service.publish(repository,prNumber,f.run.id,'root-a',true,undefined),
        /authenticated MCP OAuth/);
    assert.equal(f.events.posts,0);
});

test('dry run is nonmutating; initial fix reply is exact and subsequent calls reconcile',async()=>{
    const f=await fixture();
    const preview=await f.publish(false);
    assert.equal(preview.status,'ready');
    assert.equal(f.events.tokens,0);
    assert.equal(f.events.posts,0);
    const unmodified=await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.runs.id,f.run.id);
    assert.equal((unmodified.data.coverage as any).githubFixReplies,undefined);
    const posted=await f.publish(true);
    assert.equal(posted.status,'published');
    assert.equal(posted.replyCommentId,501);
    assert.equal(f.events.posts,1);
    const saved=await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.runs.id,f.run.id);
    assert.equal((saved.data.coverage as any).githubFixReplies['root-a'].state,'published');
    const again=await f.publish(true);
    assert.equal(again.status,'published');
    assert.equal(f.events.posts,1);
});

test('timeout after accepted fix reply stays claimed and is reconciled without resending',async()=>{
    const f=await fixture();
    f.timeout(true);
    assert.equal((await f.publish(true)).status,'uncertain');
    const saved=await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.runs.id,f.run.id);
    assert.equal((saved.data.coverage as any).githubFixReplies['root-a'].state,'claimed');
    assert.equal((await f.publish(false)).status,'found_on_github');
    assert.equal((await f.publish(true)).status,'published');
    assert.equal(f.events.posts,1);
});

test('ambiguous POST without remote reply never posts again',async()=>{
    const f=await fixture();
    f.timeout(true);
    assert.equal((await f.publish(true)).status,'uncertain');
    f.remote(null);
    assert.equal((await f.publish(true)).status,'uncertain');
    assert.equal(f.events.posts,1);
});

test('403 and 422 rejection unlocks the exact claim only after verified remote absence',async()=>{
    for(const code of [403,422] as const){
        const f=await fixture();
        f.status(code);
        const rejected=await f.publish(true) as any;
        assert.equal(rejected.status,'rejected_not_published');
        assert.equal(rejected.httpStatus,code);
        assert.equal(rejected.claimReleased,true);
        const saved=await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.runs.id,f.run.id);
        assert.equal((saved.data.coverage as any).githubFixReplies['root-a'],undefined);
        f.status(null);
        assert.equal((await f.publish(true)).status,'published');
        assert.equal(f.events.posts,2);
    }
});

test('incomplete inventory after rejected POST retains claimed fix',async()=>{
    const f=await fixture();f.status(422);f.readFails(3);
    assert.equal((await f.publish(true)).status,'uncertain');
    assert.equal((await f.publish(true)).status,'uncertain');
    assert.equal(f.events.posts,1);
});

test('unsent fix claim released on failed second head check',async()=>{
    const f=await fixture();f.headFails(2);
    await assert.rejects(f.publish(true),/Head advanced/);
    assert.equal(f.events.posts,0);
    const saved=await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.runs.id,f.run.id);
    assert.equal((saved.data.coverage as any).githubFixReplies['root-a'],undefined);
    f.headFails(0);
    assert.equal((await f.publish(true)).status,'published');
});

test('concurrent attempts at one fix claim can POST at most once',async()=>{
    const f=await fixture();
    const results=await Promise.allSettled([f.publish(true),f.publish(true)]);
    assert.equal(f.events.posts,1);
    assert.ok(results.some(r=>r.status==='fulfilled'));
});

test('old claim can reconcile after a newer structured review is saved',async()=>{
    const f=await fixture();f.timeout(true);
    assert.equal((await f.publish(true)).status,'uncertain');
    await f.catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:f.runs.id,
        data:{repository,prNumber,headSha:'c'.repeat(40),reviewer:'Code Reviewer',
            verdict:'no_findings',reviewedAt:'2026-10-30T22:00:00.000Z',
            coverage:{source:'atlas_structured_submission',
                submissionId:'f23e2f50-b72e-4d4d-9050-c57f927bd341',
                payloadSha256:'c'.repeat(64),findingCount:0,authenticatedCaller:actor}}},
    });
    assert.equal((await f.publish(true)).status,'published');
    assert.equal(f.events.posts,1);
});

test('cannot invent fix evidence or adopt a copied human marker',async()=>{
    const f=await fixture();
    await assert.rejects(f.service.publish(repository,prNumber,f.run.id,'another-root',true,actor),
        /current complete structured fix assessment|resolved lineage/);
    f.copied(true);
    await assert.rejects(f.publish(true),/root or fix reply uniqueness/);
    assert.equal(f.events.posts,0);
});

test('duplicate same-SHA fix assertion after published claim cannot post again',async()=>{
    const f=await fixture();
    assert.equal((await f.publish(true)).status,'published');
    const extraId='65a74961-e840-4277-a60f-b3b3b48d1bd7';
    const later=await f.catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:f.runs.id,
        data:{repository,prNumber,headSha:head1,reviewer:'Code Reviewer',
            verdict:'no_findings',reviewedAt:'2026-10-30T22:00:00.000Z',
            coverage:{source:'atlas_structured_submission',submissionId:extraId,
                payloadSha256:'c'.repeat(64),findingCount:0,authenticatedCaller:actor,
                lifecycleResolutions:[{lineageKey:'root-a',state:'resolved',evidence,
                    assessmentSource:'authenticated_structured_submission',
                    assessedHeadSha:head1,assertedAt:'2026-10-30T22:00:00.000Z'}]}}},
    );
    await assert.rejects(
        f.service.publish(repository,prNumber,later.id,'root-a',true,actor),
        /already has a fix reply claim/);
    assert.equal(f.events.posts,1);
});
