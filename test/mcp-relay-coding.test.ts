import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpTransport,RELAY_READ_TOOLS,RELAY_CODING_TOOLS} from '../apps/server/src/api/mcp/index.js';
import {admitRelayCodingMutation} from '../apps/server/src/api/mcp/relay-coding.js';
import {loadServerConfig} from '../apps/server/src/server/config.js';
import type {TransportServices} from '../apps/server/src/server/dispatch.js';

test('Relay coding credential is independent and disabled unless both hash and exact bases exist',()=>{
 const env={DATABASE_URL:'postgresql://localhost/db',ATLAS_TRUSTED_INGRESS:'true'};
 const id=randomUUID(),token='c'.repeat(64),hash=createHash('sha256').update(token).digest('hex');
 assert.throws(()=>loadServerConfig({...env,ATLAS_MCP_RELAY_CODING_TOKEN_SHA256:hash}),/requires a separate token/i);
 assert.throws(()=>loadServerConfig({...env,ATLAS_MCP_RELAY_CODING_CHECKOUTS:id}),/requires a separate token/i);
 assert.throws(()=>loadServerConfig({...env,ATLAS_MCP_RELAY_CODING_TOKEN_SHA256:hash,
    ATLAS_MCP_RELAY_CODING_CHECKOUTS:id,ATLAS_MCP_RELAY_TOKEN_SHA256:hash}),/independent/i);
 const config=loadServerConfig({...env,ATLAS_MCP_RELAY_CODING_TOKEN_SHA256:hash,ATLAS_MCP_RELAY_CODING_CHECKOUTS:id});
 assert.equal(config.mcpAuth.relayCodingTokenHash,hash);
 assert.deepEqual([...config.mcpAuth.relayCodingBaseCheckouts??[]],[id]);
});

test('Relay coding service has only selected file/Git/dev operations, while the ordinary service stays read-only',async()=>{
 const source=randomUUID(),feature=randomUUID(),node=randomUUID(),group=randomUUID();
 const calls:string[]=[];
 const services={
   applications:{tools:()=>['football_generalist_evaluate','football_generalist_baseline',
   'football_generalist_status','football_generalist_evaluation_detail',
   'football_generalist_policies','football_generalist_assessments'].map(name=>({name,description:name,inputSchema:{}}))},
   dispatch:async(name:string,input:Record<string,unknown>)=>{
     calls.push(name);
     if(name==='get_workspace')return {id:input.checkoutId,nodeId:node,logicalWorkspaceId:group,status:'active'};
     if(name==='workspace_git_status')return {available:true,
       branch:input.checkoutId===source?'main':'atlas/example',originRepository:'affank1020/relay'};
     if(name==='workspace_git_create_worktree')return {workspace:{id:feature}};
     return {ok:true};
   },
 } as unknown as TransportServices;
 const server=createMcpTransport(services,undefined,undefined,RELAY_CODING_TOOLS,new Set([source]));
 const client=new Client({name:'coding-credential',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try{
   await server.connect(b);await client.connect(a);
   const names=new Set((await client.listTools()).tools.map(x=>x.name));
   assert.ok(names.has('workspace_patch_file'));
   assert.ok(names.has('workspace_git_create_worktree'));
   assert.ok(names.has('workspace_run_dev_task'));
   for(const denied of ['create_record','update_node','workspace_git_remove_worktree',
     'workspace_git_clone_repository','code_reviews_publish_github'])
     assert.ok(!names.has(denied),denied);
   assert.equal((await client.callTool({name:'workspace_patch_file',
     arguments:{checkoutId:source,path:'x',expectedSha256:'a'.repeat(64),oldText:'a',newText:'b'}})).isError,true);
   const created=await client.callTool({name:'workspace_git_create_worktree',
     arguments:{checkoutId:source,branch:'atlas/example',targetPath:'/tmp/example'}});
   assert.equal(created.isError,undefined);
   const edited=await client.callTool({name:'workspace_create_file',
     arguments:{checkoutId:feature,path:'test.txt',text:'new'}});
   assert.equal(edited.isError,undefined);
   assert.equal((await client.callTool({name:'workspace_git_open_pull_request',
     arguments:{checkoutId:feature,repository:'other/repo',branch:'atlas/example',expectedHead:'a'.repeat(40),title:'Test PR'}})).isError,true);
   const otherService=createMcpTransport(services,undefined,undefined,RELAY_READ_TOOLS);
   const other=new Client({name:'read-credential',version:'1'});const [c,d]=InMemoryTransport.createLinkedPair();
   try{await otherService.connect(d);await other.connect(c);
     const readNames=(await other.listTools()).tools.map(x=>x.name);
     assert.ok(!readNames.includes('workspace_patch_file'));
     assert.ok(!readNames.includes('workspace_git_create_worktree'));
   }finally{await other.close();await otherService.close();}
 }finally{await client.close();await server.close();}
});

test('coding scope rejects unrelated checkouts, unknown Git origins and non-feature branches',async()=>{
 const base=randomUUID(),unrelated=randomUUID(),feature=randomUUID(),node=randomUUID(),group=randomUUID();
 let gitBranch='atlas/fix',repo='affank1020/relay';
 const services={dispatch:async(name:string,input:Record<string,unknown>)=>{
   if(name==='get_workspace')return {id:input.checkoutId,nodeId:node,
     logicalWorkspaceId:input.checkoutId===unrelated?randomUUID():group,status:'active'};
   if(name==='workspace_git_status')return {available:true,
     branch:input.checkoutId===base?'main':gitBranch,
     originRepository:input.checkoutId===unrelated?'other/repo':repo};
   throw Error('Unexpected tool '+name);
 }} as unknown as Pick<TransportServices,'dispatch'>;
 await assert.rejects(admitRelayCodingMutation(services,'workspace_patch_file',
   {checkoutId:unrelated,path:'a'},new Set([base])),/not authorised/);
 gitBranch='main';
 await assert.rejects(admitRelayCodingMutation(services,'workspace_create_file',
   {checkoutId:feature,path:'a'},new Set([base])),/not authorised/);
 gitBranch='atlas/fix';
 await assert.rejects(admitRelayCodingMutation(services,'workspace_git_commit',
   {checkoutId:feature,branch:'atlas/other'},new Set([base])),/not authorised/);
 await assert.doesNotReject(admitRelayCodingMutation(services,'workspace_git_commit',
   {checkoutId:feature,branch:'atlas/fix'},new Set([base])));
});
