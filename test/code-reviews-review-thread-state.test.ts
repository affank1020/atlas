import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubReviewThreadStateReader, ReviewThreadStateService } from '../apps/server/src/apps/review-thread-state.js';
import { inlineThreadMarker } from '../apps/server/src/apps/inline-thread-inventory.js';

const repository='affank1020/atlas', prNumber=132;
const marker=inlineThreadMarker(repository,prNumber,'finding-key');
const graphThread=(root:string|number=73, id='PRRT_123456789')=>({
    id,isResolved:false,isOutdated:false,viewerCanResolve:true,
    path:'src/a.ts',originalLine:10,
    comments:{nodes:[{fullDatabaseId:root,replyTo:null}]},
});
const page=(nodes:unknown[],hasNextPage=false,endCursor:string|null=null)=>
    ({data:{repository:{pullRequest:{reviewThreads:{
        nodes,pageInfo:{hasNextPage,endCursor},
    }}}}});

function mockGraph(pages: unknown[]){
    const requests: Array<{url:string;options:RequestInit;body:any}>=[];
    let index=0;
    const http=async (url:string|URL|Request,options?:RequestInit)=>{
        const body=JSON.parse(String(options?.body));
        requests.push({url:String(url),options:options!,body});
        return new Response(JSON.stringify(pages[Math.min(index++,pages.length-1)]),{status:200});
    };
    const broker={pullRequestReadToken:async()=> 'read-only-token'};
    return {reader:new GitHubReviewThreadStateReader(broker as any,http as typeof fetch),
        requests};
}

test('GraphQL review-thread mapper reads a complete page and binds the REST numeric root ID',async()=>{
    const {reader,requests}=mockGraph([page([graphThread('73')])]);
    const got=await reader.inspect(repository,prNumber);
    assert.equal(got.complete,true);
    assert.equal(got.readOnly,true);
    assert.equal(got.resolutionSupported,false);
    assert.equal(got.threads[0]!.rootCommentId,73);
    assert.equal(got.threads[0]!.viewerCanResolve,true);
    assert.equal(got.checkedPages,1);
    assert.equal(requests.length,1);
    assert.equal(requests[0]!.url,'https://api.github.com/graphql');
    assert.equal(requests[0]!.body.variables.owner,'affank1020');
    assert.equal(requests[0]!.body.variables.name,'atlas');
    assert.equal(requests[0]!.body.variables.number,prNumber);
    assert.equal(requests[0]!.body.variables.after,null);
    assert.equal(requests[0]!.options.method,'POST');
    assert.ok(JSON.stringify(requests[0]!.options.headers).includes('read-only-token'));
    assert.match(requests[0]!.body.query,/fullDatabaseId/);
});

test('GraphQL pagination must be complete and uses exact opaque cursors',async()=>{
    const {reader,requests}=mockGraph([
        page([graphThread(73)],true,'opaque-end-1'),
        page([graphThread(74,'PRRT_987654321')]),
    ]);
    const result=await reader.inspect(repository,prNumber);
    assert.deepEqual(result.threads.map(x=>x.rootCommentId),[73,74]);
    assert.equal(result.checkedPages,2);
    assert.equal(requests[1]!.body.variables.after,'opaque-end-1');
});

test('fail closed on duplicate roots, node IDs and missing initial comment',async()=>{
    const samples=[
        [graphThread(73),graphThread(73,'PRRT_987654321')],
        [graphThread(73),graphThread(74,'PRRT_123456789')],
        [{...graphThread(73),comments:{nodes:[]}}],
        [{...graphThread(73),comments:{nodes:[{fullDatabaseId:'9007199254740999',replyTo:null}]}}],
        [{...graphThread(73),comments:{nodes:[{fullDatabaseId:'74',replyTo:{id:'PRRC_123456'}}]}}],
        [{...graphThread(73),viewerCanResolve:null}],
        [{...graphThread(73),originalLine:'10'}],
    ];
    for(const items of samples)
        await assert.rejects(mockGraph([page(items)]).reader.inspect(repository,prNumber),
            /ambiguous|malformed/);
});

test('fail closed on GraphQL errors, incomplete data, cursor stalls, and bounded overflow',async()=>{
    for(const payload of [
        {errors:[{message:'Insufficient privileges'}],data:null},
        {data:{repository:{pullRequest:null}}},
        page([],true,'unchanged'),
        page([graphThread(73)],true,null),
    ])await assert.rejects(mockGraph([payload]).reader.inspect(repository,prNumber),
        /incomplete|stalled/);
    const repeat=mockGraph([page([graphThread(73)],true,'same-cursor')]);
    await assert.rejects(repeat.reader.inspect(repository,prNumber),/ambiguous|stalled/);
    const pages=Array.from({length:5},(_,i)=>
        page([graphThread(73+i,'PRRT_'+String(i+1).repeat(9))],true,'page-'+i));
    await assert.rejects(mockGraph(pages).reader.inspect(repository,prNumber),
        /exceeds five complete pages/);
});

test('read-only state joins verified REST Bot-owned root to exact GitHub GraphQL thread',async()=>{
    const restRoot={id:73,marker,bodySha256:'a'.repeat(64),
        path:'src/a.ts',originalLine:10,originalCommitSha:'b'.repeat(40),
        currentLine:null,url:'https://github.com/affank1020/atlas/pull/132#discussion_r73'};
    let restReads=0,graphReads=0,savedReads=0;
    const svc=new ReviewThreadStateService({
        preview:async()=>{savedReads++;return {
            repository,prNumber,status:'inventory_complete',
            runId:'run-1',reviewedHeadSha:'c'.repeat(40),
            resolutions:[{lineageKey:'finding-key',assessment:'reviewer_asserted_resolved',
                state:'owned_thread_found',rootCommentId:73}],findings:[],
        };},
    } as any,{
        inspect:async()=>{restReads++;return {roots:[restRoot]};},
    } as any,{
        inspect:async()=>{graphReads++;return {repository,prNumber,complete:true,
            threads:[{...graphThread(73),rootCommentId:73}],readOnly:true,
            resolutionSupported:false,checkedPages:1};},
    } as any);
    const result=await svc.preview(repository,prNumber);
    assert.equal(result.mappingComplete,true);
    assert.equal(result.ownedRootCount,1);
    assert.equal(result.mappedOwnedRoots,1);
    assert.equal(result.ownedThreads[0]!.mappingState,'verified');
    assert.equal(result.ownedThreads[0]!.resolutionState,'open_on_github');
    assert.equal(result.resolutions[0]!.thread.mappingState,'verified');
    assert.equal(result.reviewerStateDoesNotFollowGitHubResolution,true);
    assert.equal(result.readOnly,true);
    assert.deepEqual([restReads,graphReads,savedReads],[1,1,1]);
});

test('missing GraphQL roots remain unknown and original path/line disagreement is rejected',async()=>{
    const rest={roots:[{id:73,marker,path:'src/a.ts',originalLine:10}]};
    const saved={preview:async()=>({status:'inventory_complete',resolutions:[],findings:[]})};
    const noGraph={inspect:async()=>({repository,prNumber,complete:true,threads:[]})};
    const unknown=await new ReviewThreadStateService(saved as any,{inspect:async()=>rest} as any,
        noGraph as any).preview(repository,prNumber);
    assert.equal(unknown.mappingComplete,false);
    assert.equal(unknown.ownedThreads[0]!.resolutionState,'unknown');
    for(const [path,line] of [['src/b.ts',10],['src/a.ts',11]] as const){
        const graph={inspect:async()=>({repository,prNumber,complete:true,
            threads:[{id:'PRRT_123456789',rootCommentId:73,path,originalLine:line,
                isResolved:true,isOutdated:false,viewerCanResolve:true}]})};
        await assert.rejects(new ReviewThreadStateService(saved as any,
            {inspect:async()=>rest} as any,graph as any).preview(repository,prNumber),
            /locations disagree/);
    }
});
