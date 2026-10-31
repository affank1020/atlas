import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpTransport, RELAY_READ_TOOLS } from '../apps/server/src/api/mcp/index.js';
import type { TransportServices } from '../apps/server/src/server/dispatch.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { CodeReviewsService, codeReviewsApplication, CODE_REVIEWS_PROJECT_ID } from '../apps/server/src/apps/code-reviews.js';


test('Relay service sees only Atlas read tools and cannot dispatch mutations', async () => {
  const names=['football_generalist_evaluate','football_generalist_baseline',
    'football_generalist_status','football_generalist_evaluation_detail',
    'football_generalist_policies','football_generalist_assessments'];
  const dispatched:string[]=[];
  const services={applications:{tools:()=>names.map(name=>({name,description:name,inputSchema:{}}))},
    dispatch:async (name:string)=>{dispatched.push(name);return {ok:true};}} as unknown as TransportServices;
  const server=createMcpTransport(services,undefined,undefined,RELAY_READ_TOOLS);
  const client=new Client({name:'relay-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);await client.connect(clientTransport);
    const tools=(await client.listTools()).tools.map(t=>t.name);
    assert.deepEqual(new Set(tools),new Set([...RELAY_READ_TOOLS].filter(name=>
      !['code_reviews_overview','code_reviews_pr_summary','code_reviews_list_findings'].includes(name))),
      'Only installed application reads should be advertised');
    for(const denied of ['create_project','update_record','workspace_run_dev_task',
      'revoke_node','football_generalist_evaluate','code_reviews_submit_structured'])
      assert.ok(!tools.includes(denied),denied);
    const r=await client.callTool({name:'get_atlas_status',arguments:{}});
    assert.equal(r.isError,undefined);
    assert.deepEqual(dispatched,['get_atlas_status']);
    const denied=await client.callTool({name:'create_project',arguments:{name:'forbidden'}});
    assert.equal(denied.isError,true,'Unregistered mutation must fail at MCP dispatch');
    assert.deepEqual(dispatched,['get_atlas_status']);
  } finally {await client.close();await server.close();}
});

test('Relay service can read Code Reviews and worktrees without acquiring any write operations',async()=>{
  const priority=['football_generalist_evaluate','football_generalist_baseline',
    'football_generalist_status','football_generalist_evaluation_detail',
    'football_generalist_policies','football_generalist_assessments'];
  const runStore='0140b619-4f75-454e-92a3-c8b595c9dee5';
  const findingStore='17fb7f1e-fd26-415b-a70a-f1ae786b19c6';
  const reviewId='00000000-0000-4000-8000-000000000023';
  const checkoutId='59c7c5ad-a3c0-4667-913d-66285303ea51';
  const queries:Record<string,unknown>[]=[];
  const service=new CodeReviewsService({
    listStores:async(projectId:string)=>{
      assert.equal(projectId,CODE_REVIEWS_PROJECT_ID);
      return [{id:runStore,name:'Review Runs'},{id:findingStore,name:'Review Findings'}];
    },
    queryRecords:async(input:Record<string,unknown>)=>{
      queries.push(input);
      const isPrSummary=Array.isArray(input.filters)&&
        input.filters.some(value=>(value as {field?:string}).field==='prNumber');
      return {items:[],total:isPrSummary?0:input.storeId===runStore?3:5,
        limit:input.limit,offset:input.offset};
    }
  } as any);
  const applications=new ApplicationRegistry([codeReviewsApplication(service)]);
  const dispatched:string[]=[];
  const servers={
    applications:{tools:()=>[...priority.map(name=>({name,description:name,inputSchema:{}})),...applications.tools()]},
    dispatch:async(name:string,input:Record<string,unknown>)=>{
      dispatched.push(name);
      if(applications.hasTool(name))return applications.invoke(name,input);
      if(name==='workspace_git_list_worktrees')return {worktrees:[]};
      return {ok:true};
    }
  } as unknown as TransportServices;
  const server=createMcpTransport(servers,undefined,undefined,RELAY_READ_TOOLS);
  const client=new Client({name:'relay-test-real-app',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(serverTransport);await client.connect(clientTransport);
    const listed=(await client.listTools()).tools.map(tool=>tool.name);
    assert.deepEqual(new Set(listed),RELAY_READ_TOOLS);
    assert.equal(listed.length,RELAY_READ_TOOLS.size);
    for(const name of ['code_reviews_overview','code_reviews_pr_summary',
      'code_reviews_list_findings','workspace_git_list_worktrees'])
      assert.ok(listed.includes(name),'Allowed scoped read: '+name);
    for(const name of ['code_reviews_submit_structured','code_reviews_import_pull_request',
      'code_reviews_managed_summary_publish','code_reviews_publish_github',
      'code_reviews_publish_inline_reply','code_reviews_resolve_verified_thread',
      'workspace_run_dev_task','workspace_git_create_worktree','workspace_git_push_branch'])
      assert.ok(!listed.includes(name),'Forbidden mutation: '+name);
    const overview=await client.callTool({name:'code_reviews_overview',arguments:{}});
    assert.deepEqual(overview.structuredContent?.result,{
      projectId:CODE_REVIEWS_PROJECT_ID,reviewRuns:3,findingObservations:5});
    const summary=await client.callTool({name:'code_reviews_pr_summary',
      arguments:{repository:'affank1020/atlas',prNumber:114}});
    assert.equal(summary.isError,undefined);
    const result=summary.structuredContent?.result as {currentHead:{state:string};latest:unknown};
    assert.equal(result.currentHead.state,'unavailable',
      'No verified remote state must not be described as a clean review');
    assert.equal(result.latest,null);
    const findings=await client.callTool({name:'code_reviews_list_findings',
      arguments:{reviewRunId:reviewId,limit:2,offset:0}});
    assert.equal((findings.structuredContent?.result as {total:number}).total,5);
    assert.ok(queries.length>=4);
    assert.ok(queries.every(query=>query.projectId===CODE_REVIEWS_PROJECT_ID));
    assert.deepEqual(queries.at(-1)?.filters,[{field:'reviewRunId',operator:'eq',value:reviewId}]);
    const worktrees=await client.callTool({name:'workspace_git_list_worktrees',
      arguments:{checkoutId}});
    assert.deepEqual(worktrees.structuredContent?.result,{worktrees:[]});
    const dispatchedBefore=dispatched.length;
    for(const name of ['code_reviews_submit_structured',
      'code_reviews_managed_summary_publish','workspace_git_create_worktree']){
      const denied=await client.callTool({name,arguments:{}});
      assert.equal(denied.isError,true);
    }
    const bad=await client.callTool({name:'code_reviews_list_findings',
      arguments:{reviewRunId:'not-a-uuid'}});
    assert.equal(bad.isError,true);
    assert.equal(dispatched.length,dispatchedBefore,'Invalid or forbidden tools never dispatch');
    // No global change: the normal catalogue still contains OAuth-gated writes.
    const humanServer=createMcpTransport(servers);
    const human=new Client({name:'normal-oauth-catalogue',version:'1'});
    const [ht,st]=InMemoryTransport.createLinkedPair();
    try{
      await humanServer.connect(st);await human.connect(ht);
      const humanTools=(await human.listTools()).tools.map(tool=>tool.name);
      assert.ok(humanTools.includes('code_reviews_submit_structured'));
      assert.ok(humanTools.includes('workspace_git_create_worktree'));
    }finally{await human.close();await humanServer.close();}
  }finally{await client.close();await server.close();}
});
