import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';
import { inlineThreadMarker } from '../apps/server/src/apps/inline-thread-inventory.js';
import { inlineFixMarker } from '../apps/server/src/apps/inline-fix-publication.js';
import { GitHubThreadResolutionGateway, ReviewThreadResolutionService } from '../apps/server/src/apps/review-thread-resolution.js';
import { loadThreadResolutionRepositories } from '../apps/server/src/server/config.js';

after(cleanupDatabases);
const repository='affank1020/atlas',prNumber=130,lineage='root-a';
const initialSha='a'.repeat(40),fixedSha='b'.repeat(40);
const actor={kind:'mcp-oauth' as const,subject:'reviewer-123',issuer:'https://issuer.example/'};
const marker=inlineThreadMarker(repository,prNumber,lineage);
const fixEvidence='The regression suite now confirms that request validation is safe.';
const fixReviewAt='2026-10-30T20:00:00.000Z';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');

async function fixture(){
    const {catalog,store}=await databaseFixture();
    await store.pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Code Reviews',now(),now())",
        [CODE_REVIEWS_PROJECT_ID]);
    const runs=await catalog.createStore({projectId:CODE_REVIEWS_PROJECT_ID,
        name:'Review Runs',fields:[
            {name:'repository',type:'string',required:true},{name:'prNumber',type:'number',required:true},
            {name:'headSha',type:'string',required:true},{name:'reviewer',type:'string',required:true},
            {name:'verdict',type:'enum',required:true,enumValues:[
                'changes_requested','concerns_to_verify','non_blocking','no_findings','inconclusive']},
            {name:'reviewedAt',type:'datetime',required:true},{name:'coverage',type:'object'},
            {name:'schemaVersion',type:'number',required:true,default:1},
        ]});
    const findings=await catalog.createStore({projectId:CODE_REVIEWS_PROJECT_ID,
        name:'Review Findings',fields:[
            {name:'reviewRunId',type:'string',required:true},{name:'findingKey',type:'string',required:true},
            {name:'severity',type:'enum',required:true,enumValues:['sev1','sev2','sev3','sev4']},
            {name:'title',type:'string',required:true},{name:'description',type:'string',required:true},
            {name:'filePath',type:'string'},{name:'line',type:'number'},
            {name:'state',type:'enum',required:true,enumValues:['new','persisting','resolved','unverified']},
            {name:'evidence',type:'object'},
        ]});
    const old=await catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id,
        data:{repository,prNumber,headSha:initialSha,reviewer:'Code Reviewer',
            verdict:'changes_requested',reviewedAt:'2026-10-30T18:00:00.000Z',
            coverage:{source:'atlas_structured_submission',submissionId:'ac13d31d-643c-43da-882d-d8b8f92c478c',
                payloadSha256:'a'.repeat(64),findingCount:1,authenticatedCaller:actor}}});
    const original=await catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id,
        data:{reviewRunId:old.id,findingKey:'structured:ac13d31d-643c-43da-882d-d8b8f92c478c:old',
            title:'Unsafe input',severity:'sev3',description:'Old finding',state:'new',
            filePath:'src/a.ts',line:10,
            evidence:{source:'atlas_structured_submission',localKey:'old',lineageKey:lineage}}});
    const rootBody='Earlier issue.\n'+marker;
    await catalog.store.transaction(state=>catalog.updateRecordInState(state,{
        projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id,
        recordId:original.id,client:'test-root',
        data:{evidence:{...original.data.evidence,githubInlineThread:{
            state:'published',claimId:'0fed045b-b049-4d27-b8bf-72f0dd099471',findingId:original.id,
            rootCommentId:73,marker,bodySha256:hash(rootBody),headSha:initialSha,
            path:'src/a.ts',line:10,claimedAt:'2026-10-30T18:00:00.000Z'}}},
    }));
    const run=await catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id,
        data:{repository,prNumber,headSha:fixedSha,reviewer:'Code Reviewer',
            verdict:'no_findings',reviewedAt:fixReviewAt,
            coverage:{source:'atlas_structured_submission',
                submissionId:'2e3b2d76-28f6-41c3-a2c0-0dac277bd434',
                payloadSha256:'b'.repeat(64),findingCount:0,authenticatedCaller:actor,
                lifecycleResolutions:[{lineageKey:lineage,state:'resolved',evidence:fixEvidence,
                    assessmentSource:'authenticated_structured_submission',
                    assessedHeadSha:fixedSha,assertedAt:fixReviewAt}]}}});
    const fixMarker=inlineFixMarker(repository,prNumber,73,run.id,lineage);
    const fixBody='Published fix acknowledgement.\n'+fixMarker;
    await catalog.store.transaction(state=>catalog.updateRecordInState(state,{
        projectId:CODE_REVIEWS_PROJECT_ID,storeId:runs.id,recordId:run.id,client:'test-fix',
        data:{coverage:{...(run.data.coverage as Record<string,unknown>),githubFixReplies:{
            [lineage]:{state:'published',claimId:'ff1fbbd3-31ae-4681-9f5d-253c3defb19b',
                runId:run.id,lineageKey:lineage,rootCommentId:73,rootMarker:marker,
                rootBodySha256:hash(rootBody),marker:fixMarker,bodySha256:hash(fixBody),
                headSha:fixedSha,claimedAt:'2026-10-30T20:05:00.000Z',replyCommentId:501}}}},
    }));
    let resolved=false,viewerCanResolve=true,outdated=false,failedHead=false,
        uncertain=false,throwRead=false,missingFix=false,headFailureAt=0;
    const events={head:0,tokens:0,reads:0,writes:0,rest:0};
    const rest={inspect:async()=>{
        events.rest++;
        return {roots:[{id:73,marker,bodySha256:hash(rootBody),
            originalCommitSha:initialSha,path:'src/a.ts',originalLine:10,currentLine:null}],
            managedFixReplies:missingFix?[]:[{id:501,parentId:73,marker:fixMarker,bodySha256:hash(fixBody)}],
            copiedFixMarkers:[],managedReplies:[],copiedReplyMarkers:[],
            copiedMarkers:[],replies:new Map()};
    }};
    const graph=async()=>({
        repository,prNumber,complete:true,readOnly:true,resolutionSupported:false,
        checkedPages:1,threads:[{id:'PRRT_123456789',rootCommentId:73,
            path:'src/a.ts',originalLine:10,isResolved:resolved,
            isOutdated:outdated,viewerCanResolve}],
    });
    const read={inspect:async()=>{events.reads++;if(throwRead)throw Error('GraphQL read failed');return graph()}};
    const gateway={
        token:async()=>{events.tokens++;return 'write-token'},
        inspect:async(_repo:string,_pr:number,token:string)=>{
            assert.equal(token,'write-token');events.reads++;
            if(throwRead)throw Error('GraphQL read failed');
            return graph();
        },
        resolve:async(threadId:string,token:string)=>{
            events.writes++;assert.equal(threadId,'PRRT_123456789');assert.equal(token,'write-token');
            resolved=true;
            if(uncertain)throw Error('Timeout after GraphQL already resolved');
        },
    };
    const head={checkHead:async()=>{
        events.head++;
        if(failedHead||events.head===headFailureAt)throw Error('PR head moved');
    }};
    const service=new ReviewThreadResolutionService(catalog,rest as any,read as any,
        gateway as any,head as any,new Set([repository]));
    return {catalog,runs,findings,run,original,events,service,gateway,rest,
        publish:(apply:boolean,user:typeof actor|undefined=actor)=>
            service.publish(repository,prNumber,run.id,lineage,apply,user),
        resolveManually:()=>{resolved=true},reopen:()=>{resolved=false},
        writable:(v:boolean)=>{viewerCanResolve=v},
        stale:(v:boolean)=>{outdated=v},
        badHead:(v:boolean)=>{failedHead=v},
        headFailsOn:(n:number)=>{headFailureAt=n},
        uncertain:(v:boolean)=>{uncertain=v},
        failRead:(v:boolean)=>{throwRead=v},
        dropFix:(v:boolean)=>{missingFix=v},
    };
}

test('resolution allowlist is independent and owner identity is mandatory',async()=>{
    assert.equal(loadThreadResolutionRepositories({}).size,0);
    assert.deepEqual([...loadThreadResolutionRepositories({
        ATLAS_CODE_REVIEW_RESOLVE_THREAD_REPOSITORIES:'Affank1020/Atlas',
    })],[repository]);
    assert.throws(()=>loadThreadResolutionRepositories({
        ATLAS_CODE_REVIEW_RESOLVE_THREAD_REPOSITORIES:'x/y,x/y',
    }));
    const f=await fixture();
    await assert.rejects(new ReviewThreadResolutionService(f.catalog,{} as any,{} as any,
        {} as any,{} as any).publish(repository,prNumber,f.run.id,lineage,true,actor),/disabled/);
    await assert.rejects(f.publish(true,{...actor,subject:'stranger'}),/authenticated submitting reviewer/);
    await assert.rejects(f.publish(true,undefined),/authenticated MCP OAuth/);
    assert.equal(f.events.writes,0);
});

test('dry-run verifies published fix but never asks for a write token',async()=>{
    const f=await fixture();
    const ready=await f.publish(false);
    assert.equal(ready.status,'ready');
    assert.equal(ready.dryRun,true);
    assert.equal(f.events.head,0);
    assert.equal(f.events.tokens,0);
    assert.equal(f.events.writes,0);
    f.dropFix(true);
    await assert.rejects(f.publish(false),/independently verified/);
});

test('one explicit mutation and read-back, retries are read-only',async()=>{
    const f=await fixture();
    const result=await f.publish(true);
    assert.equal(result.status,'resolved');
    assert.equal(f.events.writes,1);
    assert.ok(f.events.head>=2);
    assert.equal(f.events.tokens,1);
    const saved=await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.runs.id,f.run.id);
    assert.equal((saved.data.coverage as any).githubThreadResolutions[lineage].state,'published');
    assert.equal((await f.publish(true)).status,'resolved');
    assert.equal(f.events.writes,1);
    f.reopen();
    assert.equal((await f.publish(true)).status,'reopened_after_publication');
    assert.equal(f.events.writes,1);
});

test('ambiguous GraphQL mutation retains durable one-shot claim with no repeat',async()=>{
    const f=await fixture();
    f.uncertain(true);
    assert.equal((await f.publish(true)).status,'mutation_outcome_uncertain');
    assert.equal(f.events.writes,1);
    assert.equal((await f.publish(true)).status,'resolved_on_github_attribution_unknown');
    assert.equal(f.events.writes,1);
    f.reopen();
    assert.equal((await f.publish(true)).status,'mutation_outcome_uncertain');
    assert.equal(f.events.writes,1);
});

test('write token permission, outdated thread and moved head block mutation',async()=>{
    for(const mode of ['permission','outdated','head'] as const){
        const f=await fixture();
        if(mode==='permission')f.writable(false);
        if(mode==='outdated')f.stale(true);
        if(mode==='head')f.badHead(true);
        await assert.rejects(f.publish(true),/permission|Outdated|head moved/);
        assert.equal(f.events.writes,0);
    }
});

test('already manually resolved thread is not adopted or mutated',async()=>{
    const f=await fixture();
    f.resolveManually();
    const result=await f.publish(true);
    assert.equal(result.status,'already_resolved_on_github');
    assert.equal(f.events.writes,0);
    assert.equal(f.events.tokens,0);
});

test('concurrent calls on identical fix evidence can mutate at most once',async()=>{
    const f=await fixture();
    const results=await Promise.allSettled([f.publish(true),f.publish(true)]);
    assert.equal(f.events.writes,1);
    assert.ok(results.some(x=>x.status==='fulfilled'));
});

test('GraphQL resolution gateway checks mutation response and uses write token',async()=>{
    const seen:any[]=[];
    const gateway=new GitHubThreadResolutionGateway({
        pullRequestResolutionToken:async()=> 'write-token',
    },(async(url:string|URL|Request,init?:RequestInit)=>{
        seen.push({url:String(url),init});
        return new Response(JSON.stringify({data:{resolveReviewThread:{
            thread:{id:'PRRT_123456789',isResolved:true}}}}),{status:200});
    }) as typeof fetch);
    assert.equal(await gateway.token(repository),'write-token');
    await gateway.resolve('PRRT_123456789','write-token');
    assert.equal(seen.length,1);
    assert.equal(seen[0].url,'https://api.github.com/graphql');
    assert.equal(JSON.parse(String(seen[0].init.body)).variables.threadId,'PRRT_123456789');
    const rejected=new GitHubThreadResolutionGateway({
        pullRequestResolutionToken:async()=> 'write-token',
    },(async()=>new Response(JSON.stringify({errors:[{message:'not allowed'}]}),{status:200})) as typeof fetch);
    await assert.rejects(rejected.resolve('PRRT_123456789','write-token'),/unverified/);
});

test('a prewrite failure retains the claim but never sends GraphQL mutation',async()=>{
    const f=await fixture();
    f.headFailsOn(2);
    assert.equal((await f.publish(true)).status,'prewrite_recovery_required');
    assert.equal(f.events.writes,0);
    assert.equal((await f.publish(true)).status,'mutation_outcome_uncertain');
    assert.equal(f.events.writes,0);
});

test('a pending resolution claim remains read-only even after a newer review',async()=>{
    const f=await fixture();
    f.uncertain(true);
    assert.equal((await f.publish(true)).status,'mutation_outcome_uncertain');
    const newer=await f.catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:f.runs.id,
        data:{repository,prNumber,headSha:'c'.repeat(40),reviewer:'Code Reviewer',
            verdict:'no_findings',reviewedAt:'2026-10-30T23:00:00.000Z',
            coverage:{source:'atlas_structured_submission',
                submissionId:'b248a65f-844d-4020-8844-3ead10e11d54',
                payloadSha256:'c'.repeat(64),findingCount:0,authenticatedCaller:actor}}},
    );
    assert.ok(newer.id);
    assert.equal((await f.publish(true)).status,'resolved_on_github_attribution_unknown');
    assert.equal(f.events.writes,1);
});
