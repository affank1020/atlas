import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import { databaseFixture, cleanupDatabases } from './database.js';
import { InlineReplyPublicationService, inlineReplyMarker } from '../apps/server/src/apps/inline-reply-publication.js';
import { GitHubInlineReplyRejectedError, GitHubInlineRootWriter } from '../apps/server/src/apps/inline-thread-writer.js';
import { inlineThreadMarker } from '../apps/server/src/apps/inline-thread-inventory.js';
import { loadInlineReplyRepositories } from '../apps/server/src/server/config.js';
import { CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/review-import.js';

after(cleanupDatabases);
const repository = 'affank1020/atlas', prNumber = 128;
const oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40);
const actor = { kind: 'mcp-oauth' as const, subject: 'reviewer-user',
    issuer: 'https://auth.example/' };
const sha256 = (body: string) => createHash('sha256').update(body).digest('hex');
const originalSubmission = '76894d70-4b4d-481b-9d68-e05b1e536b01';
const secondSubmission = 'ed18bec8-59b2-47a9-824c-0ae7153a4573';

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
    const createRun = async (headSha:string, reviewedAt:string, submissionId:string, findingCount:number) =>
        catalog.createRecord({ projectId: CODE_REVIEWS_PROJECT_ID, storeId:runs.id,
            data:{repository,prNumber,headSha,reviewer:'Code Reviewer',verdict:'concerns_to_verify',
                reviewedAt,coverage:{ source:'atlas_structured_submission', submissionId,
                    payloadSha256:'d'.repeat(64),findingCount,authenticatedCaller:actor } } });
    const oldRun=await createRun(oldHead,'2026-10-30T18:00:00.000Z',originalSubmission,1);
    const rootMarker=inlineThreadMarker(repository,prNumber,'root-1');
    const rootBody='Previously reported root issue.\n'+rootMarker;
    const oldFinding=await catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id,
        data:{reviewRunId:oldRun.id,
            findingKey:'structured:'+originalSubmission+':old',
            title:'Unvalidated path',severity:'sev3',description:'A guard is absent.',
            filePath:'src/a.ts',line:10,state:'new',
            evidence:{source:'atlas_structured_submission',localKey:'old',lineageKey:'root-1',
                githubInlineThread:{state:'published',
                    claimId:'e089844a-724e-4964-b4c0-0f662cd27860',
                    findingId:'placeholder',marker:rootMarker,bodySha256:sha256(rootBody),
                    headSha:oldHead,path:'src/a.ts',line:10,
                    claimedAt:'2026-10-30T18:00:00.000Z',rootCommentId:73 } } },
    });
    await catalog.store.transaction(state => catalog.updateRecordInState(state,{
        projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id,recordId:oldFinding.id,
        client:'test-inline-root-fixture',
        data:{evidence:{...(oldFinding.data.evidence as any),
            githubInlineThread:{...(oldFinding.data.evidence as any).githubInlineThread,
                findingId:oldFinding.id}}},
    }));
    const latestRun=await createRun(newHead,'2026-10-30T20:00:00.000Z',secondSubmission,1);
    const finding=await catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:findings.id,
        data:{reviewRunId:latestRun.id,
            findingKey:'structured:'+secondSubmission+':again',
            title:'Still missing guard',severity:'sev3',
            description:'The bad path is still accepted.',filePath:'src/b.ts',line:21,
            state:'persisting',evidence:{source:'atlas_structured_submission',
                localKey:'again',lineageKey:'root-1',
                lifecycleAssessment:{state:'persisting',
                    evidence:'The vulnerable request still bypasses the validation check.',
                    assessmentSource:'authenticated_structured_submission',
                    assessedHeadSha:newHead,assertedAt:'2026-10-30T20:00:00.000Z'} } },
    });
    const marker=inlineReplyMarker(repository,prNumber,73,finding.id);
    const events={checks:0,tokens:0,posts:0,reads:0};
    let remoteBody:string|null=null;
    let reject:403|422|null=null;
    let timeout=false;
    let headFailure=0;
    let failRead=false;
    let contradictoryCopy=false;
    const roots={
        inspect:async () => {
            events.reads++;
            if(failRead)throw Error('GitHub paginated inventory unavailable');
            return {roots:[{id:73,marker:rootMarker,bodySha256:sha256(rootBody),
                originalCommitSha:oldHead,path:'src/a.ts',originalLine:10,
                currentLine:null,url:'https://github.com/affank1020/atlas/pull/128#discussion_r73'}],
                copiedMarkers:[],replies:new Map(),
                managedReplies:remoteBody?[{id:501,parentId:73,marker,
                    bodySha256:sha256(remoteBody)}]:[],
                copiedReplyMarkers:contradictoryCopy?[marker]:[]};
        },
    };
    const writer={
        checkHead:async () => {
            events.checks++;
            if(events.checks===headFailure)throw Error('PR head has changed');
        },
        prepareWrite:async()=>{events.tokens++;return 'write-token';},
        postReply:async (_repo:string,_pr:number,rootId:number,body:string,token:string)=>{
            events.posts++;
            assert.equal(rootId,73);
            assert.equal(token,'write-token');
            assert.equal(body.endsWith(marker),true);
            assert.match(body,/Reviewed commit/);
            if(reject!==null)throw new GitHubInlineReplyRejectedError(reject);
            remoteBody=body;
            if(timeout)throw Error('Network timed out after GitHub accepted reply');
            return 501;
        },
    };
    const service=new InlineReplyPublicationService(catalog,roots as any,writer as any,
        new Set([repository]));
    return {catalog,runs,findings,oldRun,latestRun,finding,service,events,roots,
        publish:(apply:boolean,user:typeof actor|undefined=actor)=>
            service.publish(repository,prNumber,finding.id,apply,user),
        setReject:(v:403|422|null)=>{reject=v;},
        setTimeout:(v:boolean)=>{timeout=v;},
        setHeadFailure:(v:number)=>{headFailure=v;},
        setRemote:(v:string|null)=>{remoteBody=v;},
        setReadFailure:(v:boolean)=>{failRead=v;},
        setCopy:(v:boolean)=>{contradictoryCopy=v;},
    };
}

test('separate inline reply allowlist defaults disabled and rejects duplicate repos',async()=>{
    assert.equal(loadInlineReplyRepositories({}).size,0);
    assert.deepEqual([...loadInlineReplyRepositories({
        ATLAS_CODE_REVIEW_INLINE_REPLY_REPOSITORIES:'Affank1020/Atlas',
    })],[repository]);
    assert.throws(()=>loadInlineReplyRepositories({
        ATLAS_CODE_REVIEW_INLINE_REPLY_REPOSITORIES:'a/b,a/b',
    }));
    const f=await fixture();
    await assert.rejects(new InlineReplyPublicationService(f.catalog,{} as any,{} as any)
        .publish(repository,prNumber,f.finding.id,false,actor),/disabled/);
    await assert.rejects(f.publish(false,{...actor,subject:'someone-else'}),/authenticated reviewer/);
    // Call the service directly: the fixture helper defaults an undefined
    // caller to actor, which would silently authenticate this negative test.
    await assert.rejects(
        f.service.publish(repository,prNumber,f.finding.id,true,undefined),
        /authenticated MCP OAuth/);
    assert.equal(f.events.posts,0);
});

test('dry run is read-only; first persisting reply is posted and idempotently reconciled',async()=>{
    const f=await fixture();
    const ready=await f.publish(false);
    assert.equal(ready.status,'ready');
    assert.equal(f.events.posts,0);
    assert.equal(f.events.tokens,0);
    const first=await f.publish(true);
    assert.equal(first.status,'published');
    assert.equal(first.replyCommentId,501);
    assert.equal(f.events.posts,1);
    const saved=await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.findings.id,f.finding.id);
    assert.equal((saved.data.evidence as any).githubInlineReply.state,'published');
    assert.equal((await f.publish(true)).replyCommentId,501);
    assert.equal(f.events.posts,1);
});

test('network timeout after GitHub accepts: retry only verifies existing reply',async()=>{
    const f=await fixture();
    f.setTimeout(true);
    assert.equal((await f.publish(true)).status,'uncertain');
    assert.equal(f.events.posts,1);
    assert.equal((await f.publish(true)).status,'published');
    assert.equal(f.events.posts,1);
});

test('ambiguous lost POST with no remote matching reply retains claim',async()=>{
    const f=await fixture();
    f.setTimeout(true);
    assert.equal((await f.publish(true)).status,'uncertain');
    f.setRemote(null);
    assert.equal((await f.publish(true)).status,'uncertain');
    assert.equal(f.events.posts,1);
});

test('explicitly rejected reply releases claim only when verified absent',async()=>{
    for(const status of [403,422] as const){
        const f=await fixture();
        f.setReject(status);
        const rejected=await f.publish(true) as any;
        assert.equal(rejected.status,'rejected_not_published');
        assert.equal(rejected.httpStatus,status);
        assert.equal(rejected.claimReleased,true);
        const saved=await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.findings.id,f.finding.id);
        assert.equal((saved.data.evidence as any).githubInlineReply,undefined);
        f.setReject(null);
        assert.equal((await f.publish(true)).status,'published');
        assert.equal(f.events.posts,2);
    }
});

test('rejection with unreadable inventory or spoofed reply marker never unlocks claim',async()=>{
    for(const kind of ['unreadable','copied'] as const){
        const f=await fixture();
        f.setReject(422);
        if(kind==='unreadable')f.setReadFailure(true);
        else f.setCopy(true);
        // Preflight itself fails if inventory cannot be read, so here simulate
        // the second read failing by monkey-patching the Reader after first call.
        if(kind==='unreadable'){
            f.setReadFailure(false);
            const original=f.roots.inspect;
            let calls=0;
            f.roots.inspect=async()=>{calls++;if(calls===3)throw Error('Pagination failed');return original();};
        } else {
            // A copied marker makes the initial preview fail closed.
            await assert.rejects(f.publish(true),/uniqueness/);
            assert.equal(f.events.posts,0);
            continue;
        }
        assert.equal((await f.publish(true)).status,'uncertain');
        assert.equal(f.events.posts,1);
        assert.equal((await f.publish(true)).status,'uncertain');
        assert.equal(f.events.posts,1);
    }
});

test('post-claim head change releases only the unsent reply claim',async()=>{
    const f=await fixture();
    f.setHeadFailure(2);
    await assert.rejects(f.publish(true),/PR head has changed/);
    assert.equal(f.events.posts,0);
    const saved=await f.catalog.getRecord(CODE_REVIEWS_PROJECT_ID,f.findings.id,f.finding.id);
    assert.equal((saved.data.evidence as any).githubInlineReply,undefined);
    f.setHeadFailure(0);
    assert.equal((await f.publish(true)).status,'published');
});

test('concurrent callers are fenced by PostgreSQL and only one sends POST',async()=>{
    const f=await fixture();
    const a=await Promise.allSettled([f.publish(true),f.publish(true)]);
    assert.equal(f.events.posts,1);
    assert.ok(a.some(r=>r.status==='fulfilled'));
});

test('second saved re-review on the SAME commit cannot generate repetitive reply spam',async()=>{
    const f=await fixture();
    assert.equal((await f.publish(true)).status,'published');
    const reviewedAt='2026-10-30T22:00:00.000Z';
    const submission='65a74961-e840-4277-a60f-b3b3b48d1bd7';
    const newRun=await f.catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:f.runs.id,
        data:{repository,prNumber,headSha:newHead,reviewer:'Code Reviewer',
            verdict:'concerns_to_verify',reviewedAt,
            coverage:{source:'atlas_structured_submission',submissionId:submission,
                payloadSha256:'e'.repeat(64),findingCount:1,authenticatedCaller:actor}},
    });
    const later=await f.catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:f.findings.id,
        data:{reviewRunId:newRun.id,findingKey:'structured:'+submission+':persisting-again',
            title:'Missing guard still present',severity:'sev3',
            description:'Observed same root at the same SHA',state:'persisting',
            evidence:{source:'atlas_structured_submission',localKey:'persisting-again',
                lineageKey:'root-1',lifecycleAssessment:{state:'persisting',
                    evidence:'The original root still reproduces on this identical commit.',
                    assessmentSource:'authenticated_structured_submission',
                    assessedHeadSha:newHead,assertedAt:reviewedAt}}},
    });
    await assert.rejects(f.service.publish(repository,prNumber,later.id,true,actor),
        /already has an inline reply claim for the reviewed commit/);
    assert.equal(f.events.posts,1);
});

test('older claimed reply can reconcile after later review round',async()=>{
    const f=await fixture();
    f.setTimeout(true);
    assert.equal((await f.publish(true)).status,'uncertain');
    await f.catalog.createRecord({projectId:CODE_REVIEWS_PROJECT_ID,storeId:f.runs.id,
        data:{repository,prNumber,headSha:'c'.repeat(40),reviewer:'Code Reviewer',
            verdict:'no_findings',reviewedAt:'2026-10-30T23:00:00.000Z',
            coverage:{source:'atlas_structured_submission',submissionId:'f23e2f50-b72e-4d4d-9050-c57f927bd341',
                payloadSha256:'c'.repeat(64),findingCount:0,authenticatedCaller:actor}},
    });
    const result=await f.publish(true);
    assert.equal(result.status,'published');
    assert.equal(result.replyCommentId,501);
    assert.equal(f.events.posts,1);
});

test('HTTP writer scopes reply parent, POST payload, and rejects 403/422 only',async()=>{
    const calls:{url:string;method:string;body?:string}[]=[];
    const writer=new GitHubInlineRootWriter({
        pullRequestReadToken:async()=> 'read',pullRequestPublishToken:async()=> 'write',
    } as any,(async (url:string,options:RequestInit)=>{
        calls.push({url,method:options.method!,body:options.body as string|undefined});
        return new Response(JSON.stringify({id:501,in_reply_to_id:73}),{status:201});
    }) as typeof fetch);
    assert.equal(await writer.postReply(repository,prNumber,73,'test body','write'),501);
    assert.equal(calls.length,1);
    assert.equal(calls[0]!.method,'POST');
    assert.ok(calls[0]!.url.endsWith('/pulls/128/comments/73/replies'));
    assert.deepEqual(JSON.parse(calls[0]!.body!),{body:'test body'});
    for(const status of [403,422,500]){
        const bad=new GitHubInlineRootWriter({
            pullRequestReadToken:async()=>'read',pullRequestPublishToken:async()=>'write',
        } as any,(async()=>new Response('error',{status})) as typeof fetch);
        await assert.rejects(bad.postReply(repository,prNumber,73,'test body','write'),
            (error:unknown)=>status===500
                ? !(error instanceof GitHubInlineReplyRejectedError)
                : error instanceof GitHubInlineReplyRejectedError && error.httpStatus===status);
    }
});
