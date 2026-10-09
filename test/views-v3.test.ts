import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {cleanupDatabases,databaseFixture} from './database.js';
import {universityFixture} from './views-v3-fixture.js';
import {AtlasCatalog} from '../apps/server/src/catalog.js';
import {AtlasStore} from '../apps/server/src/store.js';
import {createAtlasHttpServer} from '../apps/server/src/server.js';
import type {ViewAction} from '../apps/server/src/types.js';
after(cleanupDatabases);

test('University Start/Complete write through Core, refresh pending data, audit source and survive repository reopen',async()=>{
 const fixture=await databaseFixture();const {catalog}=fixture;const {project,view,first,second,policy}=await universityFixture(catalog);
 const action=(name:string,recordId:string)=>catalog.executeViewAction({projectId:project.id,viewId:view.id,action:name,input:{recordId}});
 const initial=await catalog.renderView(project.id,view.id,{module:'MATH37011'});
 assert.equal((initial.data.pendingTasks![0]!._atlas as any).storeId,first.storeId);assert.match(initial.renderedHtml,new RegExp(first.id));assert.equal(initial.params.module,'MATH37011');
 await action('startTask',first.id);assert.equal((await catalog.getRecord(project.id,first.storeId,first.id)).data.status,'in_progress');
 await action('completeTask',first.id);const refreshed=await catalog.renderView(project.id,view.id,{module:'MATH37011'});
 assert.equal(refreshed.data.pendingTasks!.length,1);assert.equal((refreshed.data.pendingTasks![0]!._atlas as any).id,second.id);
 const events=await catalog.auditHistory({recordId:first.id});assert.equal(events[0]!.operation,'record.updated');assert.equal(events[0]!.viewId,view.id);assert.equal(events[0]!.client,`view:${view.id}:action:completeTask`);
 assert.deepEqual(await catalog.getRecord(project.id,policy.storeId,policy.id),policy);
 assert.equal((await catalog.viewHistory(project.id,view.id)).length,1,'record actions are not definition revisions');
 const reopened=new AtlasStore(fixture.databaseUrl);try{const reader=new AtlasCatalog(reopened);assert.deepEqual((await reader.getView(project.id,view.id)).actions,view.actions);assert.equal((await reader.getRecord(project.id,first.storeId,first.id)).data.status,'completed')}finally{await reopened.close()}
});

test('action capability enforces persisted declarations, field permissions, fixed values and ownership atomically',async()=>{
 const {catalog}=await databaseFixture();const {project,view,first}=await universityFixture(catalog);
 const otherStore=await catalog.createStore({projectId:project.id,name:'Other',fields:[{name:'status',type:'string'}]});const wrong=await catalog.createRecord({projectId:project.id,storeId:otherStore.id,data:{status:'not_started'}});
 const foreignProject=await catalog.createProject({name:'Foreign'});const foreignStore=await catalog.createStore({projectId:foreignProject.id,name:'Private',fields:[{name:'status',type:'string'}]});const foreign=await catalog.createRecord({projectId:foreignProject.id,storeId:foreignStore.id,data:{status:'not_started'}});
 const execute=(action:string,input:unknown)=>catalog.executeViewAction({projectId:project.id,viewId:view.id,action,input});
 for(const [name,input] of [['missing',{recordId:first.id}],['startTask',{recordId:wrong.id}],['startTask',{recordId:foreign.id}],['startTask',{recordId:first.id,data:{title:'hijack'}}],['startTask',{recordId:first.id,data:{status:'completed'}}],['startTask',{recordId:first.id,storeId:foreignStore.id}],['startTask',{recordId:'bad'}],['startTask',[]]] as const)await assert.rejects(()=>execute(name,input));
 assert.equal((await catalog.getRecord(project.id,first.storeId,first.id)).data.status,'not_started');assert.equal((await catalog.auditHistory({recordId:first.id})).length,1);
 const dynamic:ViewAction={name:'status',type:'record.update',storeId:first.storeId,allowedFields:['status']};await catalog.updateView({projectId:project.id,viewId:view.id,actions:[...view.actions!,dynamic]});
 await assert.rejects(()=>execute('status',{recordId:first.id,data:{status:'invalid'}}),/valid enum/);
 await execute('status',{recordId:first.id,data:{status:'in_progress'}});
 await assert.rejects(()=>catalog.updateView({projectId:project.id,viewId:view.id,actions:[{...dynamic,storeId:foreignStore.id}]}),/project/);
 await assert.rejects(()=>catalog.updateView({projectId:project.id,viewId:view.id,actions:[{...dynamic,allowedFields:['missing']}]}),/Unknown action field/);
 await assert.rejects(()=>catalog.updateView({projectId:project.id,viewId:view.id,actions:[{...dynamic,fixedData:{status:'bad'}}]}),/valid enum/);
 await catalog.updateView({projectId:project.id,viewId:view.id,actions:[]});await assert.rejects(()=>execute('status',{recordId:first.id,data:{status:'completed'}}),/Undeclared/);
});

test('declared creates use Core schema validation, reject overrides and preserve actions in definition updates/history',async()=>{
 const {catalog}=await databaseFixture();const {project,view,first}=await universityFixture(catalog);
 const create:ViewAction={name:'newTask',type:'record.create',storeId:first.storeId,allowedFields:['moduleCode','title','status','type'],fixedData:{status:'not_started',moduleCode:'MATH37011',type:'reading'}};
 const updated=await catalog.updateView({projectId:project.id,viewId:view.id,actions:[...view.actions!,create]});
 const result=await catalog.executeViewAction({projectId:project.id,viewId:view.id,action:'newTask',input:{data:{title:'New reading'}}});assert.equal(result.record.data.status,'not_started');
 await assert.rejects(()=>catalog.executeViewAction({projectId:project.id,viewId:view.id,action:'newTask',input:{}}),/Required field/);
 await assert.rejects(()=>catalog.executeViewAction({projectId:project.id,viewId:view.id,action:'newTask',input:{recordId:first.id,data:{title:'bad'}}}),/do not accept/);
 const styled=await catalog.updateView({projectId:project.id,viewId:view.id,css:'atlas-page{padding:1rem}'});assert.deepEqual(styled.actions,updated.actions);
 assert.deepEqual((await catalog.viewHistory(project.id,view.id))[0]!.resulting,styled);
 await catalog.archiveView(project.id,view.id);await assert.rejects(()=>catalog.executeViewAction({projectId:project.id,viewId:view.id,action:'startTask',input:{recordId:first.id}}),/archived/);
});

test('V2 definitions stay read-only and preserve templates, params, flattened data and safe metadata',async()=>{
 const {catalog}=await databaseFixture();const {project,view,first}=await universityFixture(catalog);
 const legacy=await catalog.createView({projectId:project.id,name:'V2',slug:'v2',queries:view.queries,manifest:{viewKitVersion:1,capabilities:['url-params'],params:{q:''}},html:'<p>{{params.q}}</p>{{#each pendingTasks}}<p>{{title}}</p>{{/each}}',css:''});
 const rendered=await catalog.renderView(project.id,legacy.id,{q:'search'});assert.match(rendered.renderedHtml,/<p>search<\/p>/);assert.match(rendered.renderedHtml,/Read Markov notes/);assert.equal((rendered.data.pendingTasks![0]!._atlas as any).storeId,first.storeId);
 await assert.rejects(()=>catalog.executeViewAction({projectId:project.id,viewId:legacy.id,action:'startTask',input:{recordId:first.id}}),/Undeclared/);
});

test('standalone active slug, parameters, archive/unknown routing and MCP V3 contract',async()=>{
 const fixture=await databaseFixture();const {project,view,first}=await universityFixture(fixture.catalog);const server=createAtlasHttpServer({databaseUrl:fixture.databaseUrl,nodeExecution:'remote'});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
 const client=new Client({name:'v3-test',version:'1'});
 try{
  const route=`${base}/projects/${project.id}/views/${view.slug}`;const response=await fetch(route+'?module=MATH37011');assert.equal(response.status,200);const page=await response.text();assert.match(page,/frame.srcdoc=themedDocument\(rendered\)/);assert.match(page,/color-scheme:dark/);assert.match(page,/atlas-button>button\{color:#15171c\}/);assert.match(page,/MATH37011/);assert.match(page,/installViewHost/);assert.match(page,/allow-scripts allow-popups allow-popups-to-escape-sandbox/);assert.match(page,/restoreScroll/);assert.match(page,/atlas-view-scroll/);
  const withoutSlug=await fixture.catalog.createView({projectId:project.id,name:'Legacy without slug',queries:[],html:'<p>Legacy</p>',css:''});
  assert.equal((await fetch(`${base}/projects/${project.id}/views/${withoutSlug.id}`)).status,200);
  assert.equal((await fetch(`${base}/projects/${project.id}/views/${view.id}`)).status,200);
  assert.equal((await fetch(`${base}/projects/${project.id}/views/missing`)).status,404);assert.equal((await fetch(route+'?undeclared=x')).status,400);
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));const tools=(await client.listTools()).tools;const schema=tools.find(t=>t.name==='update_view')!.inputSchema as any;assert.ok(schema.properties.actions);assert.ok(schema.properties.manifest);assert.ok(schema.properties.script);for(const name of ['create_view','update_view'])assert.match(tools.find(t=>t.name===name)!.description!,/Safe external links.*noopener noreferrer/);
  const result=await client.callTool({name:'execute_view_action',arguments:{projectId:project.id,viewId:view.id,action:'startTask',input:{recordId:first.id}}});assert.ok(!result.isError);assert.equal((result.structuredContent as any).result.record.data.status,'in_progress');
  const blocked=await fetch(base+'/api/tools/execute_view_action',{method:'POST',headers:{origin:'null','content-type':'application/json'},body:JSON.stringify({projectId:project.id,viewId:view.id,action:'completeTask',input:{recordId:first.id}})});assert.equal(blocked.status,403);
  await fixture.catalog.archiveView(project.id,view.id);assert.equal((await fetch(route)).status,404);
 }finally{await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
