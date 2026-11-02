import { createServer } from 'node:http';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash, generateKeyPairSync, createSign } from 'node:crypto';
import { databaseFixture, cleanupDatabases } from './database.js';
import { composeServer } from '../apps/server/src/server/composition.js';
import { loadServerConfig } from '../apps/server/src/server/config.js';
import { createHttpTransport } from '../apps/server/src/api/http/index.js';
import { NodeService } from '../apps/server/src/nodes/service.js';
import { PostgresNodeRepository } from '../apps/server/src/infrastructure/database/nodes.js';
import { AgentService } from '../apps/server/src/agents/service.js';
import { PostgresWorkspaceRepository } from '../apps/server/src/infrastructure/database/workspaces.js';
import { LocalNodeRuntime } from '../apps/node/src/platforms/desktop/runtime.js';
import { StandaloneNode } from '../apps/node/src/core/connection/standalone.js';
import { PiWorkerSupervisor } from '../apps/node/src/capabilities/pi/supervisor.js';
import { AgentNodeHost } from '../apps/node/src/capabilities/pi/agent-host.js';
import { WorkspaceFiles } from '../apps/node/src/capabilities/workspace-files/files.js';
import { agentReportSchema, agentCommandSchema, type AgentReport } from '@atlas/protocol/agent-jobs';

after(cleanupDatabases);
const sdkInstalled=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../apps/node/pi-runtime/node_modules/@earendil-works/pi-coding-agent/package.json',import.meta.url),'utf8'))
    .catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const exec=promisify(execFile);
const profile={id:'test-local',provider:'ollama' as const,model:'test-model',contextWindow:32768,maxTokens:4096};
const caller={kind:'mcp-oauth' as const,issuer:'https://agent-test.invalid/',subject:'owner'};
const script=fileURLToPath(new URL('./fixtures/pi-process.cjs',import.meta.url));
async function until<T>(fn:()=>Promise<T>,check:(x:T)=>boolean,ms=10000) {
    const end=Date.now()+ms;
    while(Date.now()<end) {const x=await fn();if(check(x))return x;await new Promise(r=>setTimeout(r,30));}
    throw new Error('Expected agent observation did not arrive.');
}
async function setup(t:any,mode='success',modelUrl?:string) {
    const db=await databaseFixture();
    const root=await realpath(await mkdtemp(path.join(tmpdir(),'atlas-agent-service-')));
    const base=path.join(root,'base'),checkout=path.join(root,'worker');await mkdir(base);
    const previous=process.env.ATLAS_GIT_TRUSTED_ROOTS;process.env.ATLAS_GIT_TRUSTED_ROOTS=root;
    t.after(()=>{if(previous===undefined)delete process.env.ATLAS_GIT_TRUSTED_ROOTS;else process.env.ATLAS_GIT_TRUSTED_ROOTS=previous;});
    const git=async(...args:string[])=>(await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',base,...args],
        {env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})).stdout.trim();
    await git('init','-b','main');await git('-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','init');
    const head=await git('rev-parse','HEAD');await git('worktree','add','-b','atlas/agent-test',checkout);
    const services=composeServer(loadServerConfig({DATABASE_URL:db.databaseUrl,ATLAS_NODE_EXECUTION:'remote',ATLAS_HOST:'127.0.0.1'}));
    const ticket=await services.identity.ticket(undefined,false);
    const enrolled=await services.identity.enrol({token:ticket.enrolmentToken,name:'Agent test',platform:'darwin'});
    const nodeId=enrolled.nodeId;
    const tx=await new PostgresWorkspaceRepository(db.store.pool).connect();await tx.begin();
    const project=await db.catalog.createProject({name:'Agent test project'});
    const workspace=await tx.insert({nodeId,projectId:project.id,name:'Approved agent checkout',rootPath:checkout,kind:'generic'});await tx.commit();tx.release();
    await writeFile(path.join(checkout,'README.md'),'native-pi-read-evidence');
    const files=new WorkspaceFiles([root]);
    let launches=0;
    const workers=new PiWorkerSupervisor(nodeId,files,[],{
        platform:'darwin',lockDirectory:path.join(root,'worker.lock'),profiles:[profile],
        approve:(w,input)=>({runId:input.runId,workspaceId:w.id,nodeId,rootPath:w.rootPath,head:input.expectedHead,
            branch:input.expectedBranch,modelProfile:input.modelProfile,promptSha256:createHash('sha256').update(input.prompt).digest('hex'),
            timeoutMs:input.timeoutMs,expiresAt:new Date(Date.now()+60000).toISOString()}),
        launch:cwd=>{launches++;return spawn(process.execPath,mode==='sdk'?[fileURLToPath(new URL('./fixtures/pi-sdk-child.mjs',import.meta.url)),modelUrl!]:[script,mode],{cwd,detached:true,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});},
    });
    const policy={nodeId,checkouts:[{id:workspace.id,rootPath:checkout}],profiles:[profile]};
    const host=new AgentNodeHost(policy,path.join(root,'journal'),files,workers);
    const runtime=new LocalNodeRuntime([root],new Map(),'darwin',undefined,false,undefined,undefined,host);
    const http=createHttpTransport(services);http.listen(0,'127.0.0.1');await once(http,'listening');
    const url='ws://127.0.0.1:'+(http.address() as any).port+'/node/connect';
    const node=new StandaloneNode({id:nodeId,name:'Agent test',token:enrolled.credential,serverUrl:url,reconnectMinMs:100,reconnectMaxMs:100},runtime);
    const online=once(node,'online');node.start();await online;
    t.after(async()=>{await node.stop();await services.nodeGateway.close();await new Promise<void>(r=>http.close(()=>r()));await services.lifecycle.close();await rm(root,{recursive:true,force:true});});
    const request={runId:randomUUID(),checkoutId:workspace.id,approvalId:randomUUID(),instruction:'Inspect approved source; never run tests.',
        profileId:profile.id,permission:'read-only' as const,timeoutMs:10000};
    const grant=async(req=request,change:any={})=>services.agents.approve({approvalId:req.approvalId,runId:req.runId,checkoutId:req.checkoutId,
        issuer:caller.issuer,subject:caller.subject,instruction:req.instruction,expectedHead:head,expectedBranch:'atlas/agent-test',
        profile,timeoutMs:req.timeoutMs,expiresAt:new Date(Date.now()+60000).toISOString(),...change});
    const call=(name:any,input:any=request)=>services.agents.call(name,input,caller);
    return {db,services,node,http,root,workspace,request,grant,call,profile,host,files,policy,runtime,launches:()=>launches};
}

test('OAuth MCP → durable dispatch → real child receipts; client lifetime is independent, terminal state persists',async t=>{
    const f=await setup(t);
    const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
    const jwk={...publicKey.export({format:'jwk'}),kid:'agent-test',alg:'RS256',use:'sig'};
    const original=globalThis.fetch;
    globalThis.fetch=((input:any,init:any)=>String(input)===caller.issuer+'.well-known/jwks.json'
        ?Promise.resolve(new Response(JSON.stringify({keys:[jwk]}))):original(input,init)) as typeof fetch;
    t.after(()=>{globalThis.fetch=original;});
    // HTTP transport reads the same mutable config object; verifier was created before enabling it,
    // so use a second HTTP listener with the configured OAuth boundary and the same domain services.
    const config=loadServerConfig({DATABASE_URL:f.db.databaseUrl,ATLAS_NODE_EXECUTION:'remote',
        ATLAS_TRUSTED_INGRESS:'true',ATLAS_MCP_OAUTH_ISSUER:caller.issuer,ATLAS_MCP_OAUTH_ALLOWED_SUBJECT:caller.subject,
        ATLAS_MCP_RESOURCE:'https://atlas.example/mcp'});
    const http=createHttpTransport({...f.services,config});http.listen(0,'127.0.0.1');await once(http,'listening');
    t.after(()=>new Promise<void>(r=>http.close(()=>r())));
    const encode=(x:any)=>Buffer.from(JSON.stringify(x)).toString('base64url');
    const payload=encode({alg:'RS256',kid:jwk.kid})+'.'+encode({iss:caller.issuer,sub:caller.subject,aud:config.mcpAuth.resource,
        scope:config.mcpAuth.scope,exp:Math.floor(Date.now()/1000)+600});
    const token=payload+'.'+createSign('RSA-SHA256').update(payload).end().sign(privateKey).toString('base64url');
    let id=0;
    const mcp=async(name:string,args:any,bearer=token)=>{
        const response=await original('http://127.0.0.1:'+(http.address() as any).port+'/mcp',{method:'POST',
            headers:{authorization:'Bearer '+bearer,accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2025-03-26'},
            body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}})});
        const text=await response.text();
        if(response.status!==200) return {status:response.status,text};
        const data=JSON.parse(text.split('\n').find(x=>x.startsWith('data: '))!.slice(6));
        return data.result;
    };
    await f.grant();
    assert.equal((await mcp('agent_start',f.request,'wrong')).status,401);
    assert.equal((await mcp('agent_start',{...f.request,executable:'/bin/sh'})).isError,true);
    const started=await mcp('agent_start',f.request);
    assert.equal(started.isError,undefined,JSON.stringify(started));
    assert.equal(started.structuredContent.result.runId,f.request.runId);
    assert.notEqual(started.structuredContent.result.state,'completed');
    await Promise.all(Array.from({length:5},()=>f.call('agent_start')));
    const done:any=await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='completed');
    for(const name of ['agent_get','agent_events','agent_control'])
        await assert.rejects(f.services.agents.call(name as any,{runId:f.request.runId,...(name==='agent_control'?{action:'cancel'}:{})},{...caller,subject:'other'}));
    assert.equal(f.launches(),1);assert.equal(done.result.exitCode,0);assert.ok(done.result.pid);
    assert.equal(done.evidence.taskSuccessVerified,false);assert.deepEqual(done.evidence.verifiedTests,[]);
    assert.equal(done.actualProfile.model,profile.model);
    const events:any=await mcp('agent_events',{runId:f.request.runId,limit:3});
    assert.equal(events.structuredContent.result.events.length,3);
    const restarted=new AgentService(f.db.store.pool,f.services.nodes);
    assert.equal((await restarted.call('agent_get',{runId:f.request.runId},caller)).state,'completed');
    assert.equal(JSON.stringify(done).includes(f.request.instruction),false);
});

test('approval, caller, placement and model boundaries fail before dispatch; revocation is durable',async t=>{
    const f=await setup(t);
    await assert.rejects(f.call('agent_start'));await f.grant();
    for(const changed of [{instruction:'different'},{profileId:'unavailable'},{checkoutId:randomUUID()},{timeoutMs:100}])
        await assert.rejects(f.call('agent_start',{...f.request,...changed}));
    await assert.rejects(f.services.agents.call('agent_start',f.request,undefined));
    await assert.rejects(f.services.agents.call('agent_start',f.request,{...caller,subject:'someone-else'}));
    for(const extra of [{executable:'/bin/sh'},{env:{SECRET:'x'}},{path:'/tmp'},{permission:'write'}])
        await assert.rejects(f.call('agent_start',{...f.request,...extra}));
    await f.services.agents.revoke(f.request.approvalId);await assert.rejects(f.call('agent_start'));
    assert.equal(f.launches(),0);
});

test('cancel survives disconnect intent, reconnect only observes and does not launch twice',async t=>{
    const f=await setup(t,'hang');await f.grant();await f.call('agent_start');
    await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='running');
    const old=f.services.nodes.runtimes.get(f.workspace.nodeId) as any;
    old.socket.terminate();
    await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='unknown');
    await f.call('agent_control',{runId:f.request.runId,action:'cancel'});
    const done:any=await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='cancelled');
    assert.equal(done.result.signal,'SIGKILL');assert.equal(f.launches(),1);
    await assert.rejects(f.services.agents.call('agent_get',{runId:f.request.runId},{...caller,subject:'other'}));
    await assert.rejects(f.call('agent_start',{...f.request,instruction:'changed retry'}));
});

test('Node restart keeps a claim tombstone and reports unknown rather than replaying execution',async t=>{
    const f=await setup(t,'hang');await f.grant();await f.call('agent_start');
    await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='running');
    await f.host.close();
    const row=(await f.db.store.pool.query('SELECT * FROM agent_runs WHERE id=$1',[f.request.runId])).rows[0];
    const restarted=new AgentNodeHost(f.policy,path.join(f.root,'journal'),f.files);
    t.after(()=>restarted.close());
    await restarted.handle({type:'agent.command',action:'observe',runId:row.id,token:row.token,after:row.last_cursor,profile});
    const report=await restarted.report();assert.equal(report!.status,'missing');
    await f.services.agents.receive(f.workspace.nodeId,report);
    assert.equal((await f.call('agent_get',{runId:row.id})).state,'unknown');
    assert.equal(f.launches(),1);
});

test('fake completion without process/evidence is incomplete; ordered duplicates are idempotent and raw payloads rejected',async t=>{
    const f=await setup(t);
    // Stop automatic reports while exercising the authenticated report ingestion domain.
    f.runtime.agentHost!.report=async()=>undefined;
    await f.grant();await f.call('agent_start');
    const r=(await f.db.store.pool.query('SELECT * FROM agent_runs WHERE id=$1',[f.request.runId])).rows[0];
    const at=new Date().toISOString();
    const report:AgentReport={type:'agent.report',runId:r.id,token:r.token,status:'observed',profile,oldestCursor:1,
        receipt:{runId:r.id,workspaceId:f.workspace.id,nodeId:f.workspace.nodeId,state:'completed',
            startedAt:at,finishedAt:at,runtimeVersion:'1.5.0',permission:'read-only',head:r.head,branch:r.branch,lastCursor:1,exitCode:0,signal:null},
        events:[{cursor:1,at,type:'terminal',data:{state:'completed',reason:'pi_finished'}}]};
    await assert.rejects(f.services.agents.receive(randomUUID(),report));
    await assert.rejects(f.services.agents.receive(f.workspace.nodeId,{...report,events:[{...report.events[0],data:{state:'completed',stdout:'secret'}}]}));
    await assert.rejects(f.services.agents.receive(f.workspace.nodeId,{...report,events:[{...report.events[0],cursor:2}]}));
    const missingFinished={...report,receipt:{...report.receipt,finishedAt:undefined}};
    await assert.rejects(f.services.agents.receive(f.workspace.nodeId,missingFinished));
    assert.equal(await f.services.agents.receive(f.workspace.nodeId,report),1);
    assert.equal(await f.services.agents.receive(f.workspace.nodeId,report),1);
    assert.equal((await f.call('agent_get',{runId:r.id})).state,'incomplete');
    assert.equal((await f.db.store.pool.query('SELECT count(*) FROM agent_events WHERE run_id=$1',[r.id])).rows[0].count,'1');
});

test('wire contract has no executable/path/env command or child-agent authority',()=>{
    assert.equal(agentCommandSchema.safeParse({type:'agent.command',action:'bash',command:'id'}).success,false);
    assert.equal(agentReportSchema.safeParse({type:'agent.report',text:'Tests passed',success:true}).success,false);
});
test('Server restart reconciles an active Node by observation without replaying the original start',async t=>{
    const f=await setup(t,'hang');await f.grant();await f.call('agent_start');
    await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='running');
    const port=(f.http.address() as any).port;
    await f.services.nodeGateway.close();
    await new Promise<void>(r=>f.http.close(()=>r()));await f.services.lifecycle.close();
    const restarted=composeServer(loadServerConfig({DATABASE_URL:f.db.databaseUrl,ATLAS_NODE_EXECUTION:'remote',ATLAS_HOST:'127.0.0.1'}));
    const http=createHttpTransport(restarted);http.listen(port,'127.0.0.1');await once(http,'listening');
    t.after(async()=>{await restarted.nodeGateway.close();await new Promise<void>(r=>http.close(()=>r()));await restarted.lifecycle.close();});
    await until(()=>restarted.agents.call('agent_get',{runId:f.request.runId},caller),x=>x.state==='running');
    assert.equal(f.launches(),1);
    await restarted.agents.call('agent_control',{runId:f.request.runId,action:'cancel'},caller);
    await until(()=>restarted.agents.call('agent_get',{runId:f.request.runId},caller),x=>x.state==='cancelled');
    assert.equal(f.launches(),1);
});
test('cursor retention is bounded and an explicit source gap cannot become verified completion',async t=>{
    const f=await setup(t);
    f.runtime.agentHost!.report=async()=>undefined;
    await f.grant();await f.call('agent_start');
    const r=(await f.db.store.pool.query('SELECT * FROM agent_runs WHERE id=$1',[f.request.runId])).rows[0],at=new Date().toISOString();
    const report:AgentReport={type:'agent.report',runId:r.id,token:r.token,status:'observed',profile,oldestCursor:1,receipt:null,events:[]};
    for(let cursor=1;cursor<=2048;cursor+=32) {
        report.events=Array.from({length:32},(_,i)=>({cursor:cursor+i,at,type:'process_heartbeat',data:{}}));
        await f.services.agents.receive(f.workspace.nodeId,report);
    }
    assert.equal((await f.db.store.pool.query('SELECT count(*) FROM agent_events WHERE run_id=$1',[r.id])).rows[0].count,'2000');
    const page:any=await f.call('agent_events',{runId:r.id,after:0,limit:3});
    assert.equal(page.oldestCursor,49);assert.equal(page.truncated,true);assert.equal(page.events.length,3);
    report.oldestCursor=2050;report.events=[{cursor:2050,at,type:'terminal',data:{state:'completed',reason:'pi_finished'}}];
    report.receipt={runId:r.id,workspaceId:f.workspace.id,nodeId:f.workspace.nodeId,state:'completed',
        startedAt:at,finishedAt:at,runtimeVersion:'1.5.0',permission:'read-only',head:r.head,branch:r.branch,
        lastCursor:2050,exitCode:0,signal:null,pid:1234};
    await f.services.agents.receive(f.workspace.nodeId,report);
    const done:any=await f.call('agent_get',{runId:r.id});
    assert.equal(done.state,'incomplete');assert.equal(done.eventGap,true);
});
test('offline Nodes do not consume approval; changed placement and expired grants cannot dispatch',async t=>{
    const f=await setup(t);await f.grant();
    const remote=f.services.nodes.runtimes.get(f.workspace.nodeId)!;
    f.services.nodes.detachRemote(f.workspace.nodeId,remote);
    await assert.rejects(f.call('agent_start'));
    assert.equal((await f.db.store.pool.query('SELECT consumed_at FROM agent_approvals WHERE id=$1',[f.request.approvalId])).rows[0].consumed_at,null);
    f.services.nodes.attachRemote(f.workspace.nodeId,remote);
    await f.db.store.pool.query('UPDATE workspaces SET root_path=$2 WHERE id=$1',[f.workspace.id,f.root]);
    await assert.rejects(f.call('agent_start'));
    await f.db.store.pool.query('UPDATE workspaces SET root_path=$2 WHERE id=$1',[f.workspace.id,f.workspace.rootPath]);
    await f.db.store.pool.query("UPDATE agent_approvals SET expires_at=now()-interval '1 second' WHERE id=$1",[f.request.approvalId]);
    await assert.rejects(f.call('agent_start'));assert.equal(f.launches(),0);
});
test('a genuine failed process remains incomplete rather than successful through transport',async t=>{
    const f=await setup(t,'crash');await f.grant();await f.call('agent_start');
    const done:any=await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='incomplete');
    assert.equal(done.result.exitCode,2);assert.equal(done.evidence.taskSuccessVerified,false);
});
test('real worker session construction failures persist redacted failure events and release admission',{skip:!sdkInstalled},async t=>{
    const f=await setup(t,'sdk','session-error');await f.grant();await f.call('agent_start');
    const done:any=await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='failed');
    assert.equal(done.result.reason,'pi_error');assert.equal(done.evidence.taskSuccessVerified,false);
    const events:any=await f.call('agent_events',{runId:f.request.runId});
    assert.ok(events.events.some((x:any)=>x.type==='worker_error'&&Object.keys(x.data).length===0));
    assert.ok(!JSON.stringify(events).includes('Private provider'));
    const next={...f.request,runId:randomUUID(),approvalId:randomUUID()};
    await f.grant(next);await f.call('agent_start',next);
    await until(()=>f.call('agent_get',{runId:next.runId}),x=>x.state==='failed');
    assert.equal(f.launches(),2);
});
test('full job channel hosts the real Pi SDK tool loop against a simulated model; model claims are never test receipts', {timeout:15000,skip:!sdkInstalled},async t=>{
    let calls=0;
    const server=createServer(async(req,res)=>{
        let input='';for await(const chunk of req)input+=chunk;
        const request=JSON.parse(input);calls++;
        assert.deepEqual(request.tools.map((x:any)=>x.function.name),['read']);
        if(calls===2)assert.ok(JSON.stringify(request.messages).includes('native-pi-read-evidence'));
        res.writeHead(200,{'content-type':'text/event-stream'});
        const tool=calls===1;
        const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'read',arguments:'{"path":"README.md"}'}}]}
            :{role:'assistant',content:'All tests passed! This model claim must never become verified evidence.'};
        for(const [content,finish] of [[delta,null],[{},tool?'tool_calls':'stop']])
            res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test-model',
                choices:[{index:0,delta:content,finish_reason:finish}]})+'\n\n');
        res.end('data: [DONE]\n\n');
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(()=>{server.closeAllConnections();server.close();});
    const f=await setup(t,'sdk','http://127.0.0.1:'+(server.address() as any).port+'/v1');
    await f.grant();await f.call('agent_start');
    const done:any=await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.finishedAt!==null);
    assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(calls,2);
    assert.equal(done.evidence.toolExecutions,1);
    assert.deepEqual(done.evidence.verifiedTests,[]);assert.equal(done.evidence.taskSuccessVerified,false);
    assert.ok(!JSON.stringify(done).includes('All tests passed'));
});
test('revoking a consumed approval records and delivers cancellation',async t=>{
    const f=await setup(t,'hang');await f.grant();await f.call('agent_start');
    await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='running');
    const admin=new AgentService(f.db.store.pool,new NodeService(new PostgresNodeRepository(f.db.store.pool)));
    await admin.revoke(f.request.approvalId); // Separate CLI process has no live Node attachments.
    const done:any=await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='cancelled');
    assert.ok(done.cancelRequestedAt);assert.equal(f.launches(),1);
});
test('cancellation during asynchronous Node admission is remembered until the process exists',async t=>{
    const f=await setup(t,'hang');await f.grant();await f.call('agent_start');
    // The start frame and cancel frame are ordered on the socket, but Git admission is asynchronous.
    await f.call('agent_control',{runId:f.request.runId,action:'cancel'});
    const done:any=await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='cancelled');
    assert.ok(done.finishedAt);assert.equal(f.launches(),1);
});
test('archival while a run is active triggers cancellation rather than retaining checkout authority',async t=>{
    const f=await setup(t,'hang');await f.grant();await f.call('agent_start');
    await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='running');
    await f.db.store.pool.query("UPDATE workspaces SET status='archived',archived_at=now() WHERE id=$1",[f.workspace.id]);
    const done:any=await until(()=>f.call('agent_get',{runId:f.request.runId}),x=>x.state==='cancelled');
    assert.ok(done.cancelRequestedAt);
});
test('concurrent initial start consumes approval once; an unacknowledged dispatch becomes unknown without retry',async t=>{
    const f=await setup(t,'hang');
    f.host.report=async()=>undefined;
    await f.grant();
    const starts=await Promise.all(Array.from({length:5},()=>f.call('agent_start')));
    assert.ok(starts.every(x=>x.runId===f.request.runId));
    await until(async()=>f.launches(),x=>x===1);
    await f.db.store.pool.query("UPDATE agent_runs SET created_at=now()-interval '20 seconds' WHERE id=$1",[f.request.runId]);
    const retry:any=await f.call('agent_start');
    assert.equal(retry.state,'unknown');assert.equal(f.launches(),1);
    assert.equal((await f.db.store.pool.query('SELECT count(*) FROM agent_runs WHERE id=$1',[f.request.runId])).rows[0].count,'1');
});
