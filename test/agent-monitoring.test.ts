import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {databaseFixture,cleanupDatabases} from './database.js';
import {composeServer} from '../apps/server/src/server/composition.js';
import {loadServerConfig} from '../apps/server/src/server/config.js';
import {createHttpTransport} from '../apps/server/src/api/http/index.js';
import {agentOwner} from '../apps/server/src/agents/service.js';
import {PostgresNodeRepository} from '../apps/server/src/infrastructure/database/nodes.js';
import {PostgresWorkspaceRepository} from '../apps/server/src/infrastructure/database/workspaces.js';

after(cleanupDatabases);
const caller={kind:'mcp-oauth' as const,issuer:'https://agents-owner.invalid/',subject:'owner'};
const other={...caller,subject:'other-owner'};
const secret='a'.repeat(64),tokenHash=createHash('sha256').update(secret).digest('hex');
const profile={id:'local',provider:'ollama',model:'coder',contextWindow:32768,maxTokens:4096};
async function setup(t:any,enabled=true) {
    const db=await databaseFixture();
    const config=loadServerConfig({DATABASE_URL:db.databaseUrl,ATLAS_TRUSTED_INGRESS:'true',
        ATLAS_MCP_OAUTH_ISSUER:caller.issuer,ATLAS_MCP_OAUTH_ALLOWED_SUBJECT:caller.subject,ATLAS_MCP_RESOURCE:'https://atlas.invalid/mcp',
        ...(enabled?{ATLAS_AGENTS_WEB_TOKEN_SHA256:tokenHash}:{}),ATLAS_WORKSPACE_ORIGINS:'https://atlas.invalid'});
    const services=composeServer(config);
    t.after(()=>services.lifecycle.close());
    const ticket=await services.identity.ticket(undefined,false);
    const {nodeId}=await services.identity.enrol({token:ticket.enrolmentToken,name:'Worker Mac',platform:'darwin'});
    await new PostgresNodeRepository(db.store.pool).registerRemote(nodeId,'Worker Mac',['agent.pi'],randomUUID(),'darwin');
    const tx=await new PostgresWorkspaceRepository(db.store.pool).connect();await tx.begin();
    const w=await tx.insert({nodeId,projectId:null,name:'Checkout',rootPath:'/approved/checkout',kind:'generic'});await tx.commit();tx.release();
    const seed=async(state='completed',owner=caller,at='2026-11-02T12:00:00.123456Z')=>{
        const id=randomUUID(),approvalId=randomUUID(),ownerKey=agentOwner(owner);
        await db.store.pool.query(`INSERT INTO agent_approvals(id,run_id,owner_key,checkout_id,node_id,root_path,head,branch,instruction_sha256,timeout_ms,profile,expires_at)
            VALUES($1,$2,$3,$4,$5,'/approved/checkout',$6,'atlas/test','private-hash',10000,$7,now()+interval '1 hour')`,[approvalId,id,ownerKey,w.id,nodeId,'a'.repeat(40),profile]);
        const terminal=['completed','failed','cancelled','timed_out','incomplete'].includes(state);
        await db.store.pool.query(`INSERT INTO agent_runs(id,approval_id,owner_key,checkout_id,node_id,token,dispatch_session,request_sha256,profile,head,branch,state,created_at,observed_at,finished_at,started_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,'private-hash',$8,$9,'atlas/test',$10,$11,now(),$12,$11)`,[id,approvalId,ownerKey,w.id,nodeId,randomUUID(),randomUUID(),profile,'a'.repeat(40),state,at,terminal?at:null]);
        return id;
    };
    const http=createHttpTransport(services);http.listen(0,'127.0.0.1');await once(http,'listening');
    const base='http://127.0.0.1:'+(http.address() as any).port;
    const request=async(action:string,input:unknown={},headers:Record<string,string>={})=>{
        const r=await fetch(base+'/api/agents/'+action,{method:'POST',headers:{'content-type':'application/json','x-atlas-agents-ingress':'Bearer '+secret,origin:'https://atlas.invalid',...headers},body:JSON.stringify(input)});
        return {status:r.status,body:await r.json() as any};
    };
    t.after(async()=>{await services.nodeGateway.close();await new Promise<void>(r=>http.close(()=>r()));await services.lifecycle.close();});
    return {db,services,nodeId,w,seed,request,base};
}

test('Agents is a global code-defined Application; list pagination is scoped, ordered and preserves microsecond cursors',async t=>{
    const f=await setup(t);
    assert.equal(f.services.applications.get(null,'agents').name,'Agents');
    assert.ok(f.services.applications.tools().some(x=>x.name==='agent_list'));
    const one=await f.seed(),two=await f.seed(),three=await f.seed('failed',caller,'2026-11-02T12:00:00.123455Z');await f.seed('completed',other);
    const all:any=await f.services.agents.call('agent_list',{},caller);assert.equal(all.runs.length,3);
    assert.equal((await f.services.agents.call('agent_list',{},other) as any).runs.length,1);
    const first=await f.request('list',{limit:1});assert.equal(first.status,200);assert.equal(first.body.runs.length,1);
    assert.equal(first.body.next.createdAt,'2026-11-02T12:00:00.123456Z');
    const second=await f.request('list',{limit:1,before:first.body.next});
    const third=await f.request('list',{limit:1,before:second.body.next});
    assert.deepEqual(new Set([first.body.runs[0].runId,second.body.runs[0].runId,third.body.runs[0].runId]),new Set([one,two,three]));
    assert.equal(third.body.next,null);
    assert.equal((await f.request('list',{state:'failed',nodeId:f.nodeId,checkoutId:f.w.id})).body.runs[0].runId,three);
    assert.equal((await f.request('list',{nodeId:randomUUID()})).body.runs.length,0);
    assert.equal((await f.request('list',{logicalWorkspaceId:randomUUID()})).body.runs.length,0);
    assert.equal((await f.request('list',{limit:101})).status,400);
    const detail=await f.request('get',{runId:one});
    const mcp=await f.services.dispatch('agent_get',{runId:one},'atlas-mcp',caller);
    assert.deepEqual(detail.body,JSON.parse(JSON.stringify(mcp)));
    assert.equal(detail.body.canCancel,false);assert.deepEqual(detail.body.hierarchy.children,[]);
    assert.equal(detail.body.approvedRoot,'/approved/checkout');assert.equal(detail.body.nodeName,'Worker Mac');
    for(const privateField of ['owner_key','token','private-hash'])assert.ok(!JSON.stringify(all).includes(privateField));
});

test('ordered authenticated child events persist into the same MCP and browser hierarchy',async t=>{
    const f=await setup(t),runId=await f.seed('running');
    const token=(await f.db.store.pool.query('SELECT token FROM agent_runs WHERE id=$1',[runId])).rows[0].token;
    const childId=randomUUID(),grandchildId=randomUUID(),at=new Date().toISOString();
    const events=[
        {type:'ready',cursor:1,at,data:{version:'1.5.0'}},
        {type:'agent_start',cursor:2,at,data:{}},
        {type:'child_start',cursor:3,at,data:{agentId:childId,parentAgentId:runId,role:'scout',requestedProfileId:'local'}},
        {type:'child_state',cursor:4,at,data:{agentId:childId,state:'running',actualProfile:profile}},
        {type:'child_start',cursor:5,at,data:{agentId:grandchildId,parentAgentId:childId,role:'reviewer',requestedProfileId:'local'}},
        {type:'child_terminal',cursor:6,at,data:{agentId:childId,state:'completed'}},
    ];
    await f.services.agents.receive(f.nodeId,{type:'agent.report',runId,token,status:'observed',
        receipt:null,profile,oldestCursor:1,events});
    const detail=(await f.request('get',{runId})).body;
    assert.equal(detail.hierarchy.children.length,1);
    assert.equal(detail.hierarchy.children[0].role,'scout');
    assert.equal(detail.hierarchy.children[0].actualProfile.model,'coder');
    assert.equal(detail.hierarchy.children[0].children[0].role,'reviewer');
    assert.equal(detail.hierarchy.children[0].children[0].state,'unknown');
    const mcp=await f.services.agents.call('agent_get',{runId},caller);
    assert.deepEqual(detail,JSON.parse(JSON.stringify(mcp)));
    const page=(await f.request('events',{runId,after:2,limit:10})).body;
    assert.deepEqual(page.events.map((x:any)=>x.type),['child_start','child_state','child_start','child_terminal']);
    await assert.rejects(f.services.agents.receive(f.nodeId,{type:'agent.report',runId,token,
        status:'observed',receipt:null,profile,oldestCursor:7,
        events:[{type:'child_terminal',cursor:7,at,data:{agentId:childId,state:'completed'}}]}));
    assert.equal((await f.db.store.pool.query('SELECT last_cursor FROM agent_runs WHERE id=$1',[runId])).rows[0].last_cursor,6);
});

test('browser authentication fails closed; caller headers cannot change owner or broaden operations',async t=>{
    const f=await setup(t);const hidden=await f.seed('running',other);
    assert.equal((await f.request('list',{}, {'x-atlas-agents-ingress':''})).status,401);
    assert.equal((await f.request('list',{}, {'x-atlas-agents-ingress':'Bearer '+'b'.repeat(64)})).status,401);
    assert.equal((await f.request('list',{}, {origin:'https://evil.invalid'})).status,403);
    assert.equal((await f.request('list',{}, {'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await f.request('get',{runId:hidden},{'x-atlas-owner':other.subject})).status,404);
    assert.equal((await f.request('events',{runId:hidden})).status,404);
    assert.equal((await f.request('control',{runId:hidden,action:'cancel'})).status,404);
    assert.equal((await f.request('start',{})).status,404);
    assert.equal((await f.request('__proto__',{})).status,404);
    assert.equal((await f.request('list',{owner:other.subject})).status,400);
    const direct=await fetch(f.base+'/api/tools/agent_list',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(direct.status,400);assert.equal((await direct.json() as any).error,'AGENT_DENIED');
    await assert.rejects(f.services.agents.call('agent_list',{},undefined));
    const noOrigin=await f.request('control',{runId:hidden,action:'cancel'},{origin:''});assert.equal(noOrigin.status,403);
    assert.equal((await f.request('list',{padding:'x'.repeat(5000)})).status,413);
    assert.equal((await f.request('list',{}, {'content-type':'text/plain'})).status,415);
    const method=await fetch(f.base+'/api/agents/list',{headers:{'x-atlas-agents-ingress':'Bearer '+secret}});
    assert.equal(method.status,405);
    const off=await setup(t,false);assert.equal((await off.request('list')).status,503);
});

test('production ingress authenticates before injecting the private Agents credential and strips spoofed generic headers',async()=>{
    const caddy=await readFile('infra/Caddyfile.production','utf8');
    assert.ok(caddy.indexOf('basic_auth {')<caddy.indexOf('@agents path /api/agents/*'));
    assert.match(caddy,/reverse_proxy @agents server:3000 \{\s*header_up X-Atlas-Agents-Ingress "Bearer \{\$ATLAS_AGENTS_WEB_TOKEN:\}"/);
    assert.match(caddy,/reverse_proxy @backend server:3000 \{\s*header_up -X-Atlas-Agents-Ingress/);
});

test('effective offline and stale status agrees between list, web detail and MCP; cancellation records intent only',async t=>{
    const f=await setup(t);const id=await f.seed('running');
    assert.equal((await f.request('list',{state:'running'})).body.runs.length,0);
    assert.equal((await f.request('list',{state:'unknown'})).body.runs[0].state,'unknown');
    const runtime={getCapabilities:()=>['agent.pi'],agentSessionId:randomUUID(),agentCommand:()=>{},close:async()=>{}} as any;
    f.services.nodes.attachRemote(f.nodeId,runtime);
    assert.equal((await f.request('get',{runId:id})).body.state,'running');
    await f.db.store.pool.query("UPDATE agent_runs SET observed_at=now()-interval '30 seconds' WHERE id=$1",[id]);
    const stale=await f.request('get',{runId:id});assert.equal(stale.body.state,'unknown');assert.equal(stale.body.nodeOnline,true);
    assert.equal((await f.request('list',{state:'active'})).body.runs[0].state,'unknown');
    const cancelled=await f.request('control',{runId:id,action:'cancel'});assert.equal(cancelled.status,200);
    assert.ok(cancelled.body.cancelRequestedAt);assert.equal(cancelled.body.finishedAt,null);assert.notEqual(cancelled.body.state,'cancelled');
    assert.deepEqual(cancelled.body,JSON.parse(JSON.stringify(await f.services.agents.call('agent_get',{runId:id},caller))));
});

test('browser event pagination is ordered, bounded and explicit about retained gaps',async t=>{
    const f=await setup(t);const id=await f.seed();
    for(const cursor of [3,1,2])await f.db.store.pool.query('INSERT INTO agent_events(run_id,cursor,event) VALUES($1,$2,$3)',[id,cursor,{cursor,at:new Date().toISOString(),type:'agent_start',data:{}}]);
    await f.db.store.pool.query('UPDATE agent_runs SET last_cursor=3 WHERE id=$1',[id]);
    const page=await f.request('events',{runId:id,limit:2});assert.deepEqual(page.body.events.map((x:any)=>x.cursor),[1,2]);
    assert.deepEqual((await f.request('events',{runId:id,after:2,limit:2})).body.events.map((x:any)=>x.cursor),[3]);
    await f.db.store.pool.query('DELETE FROM agent_events WHERE run_id=$1 AND cursor=1',[id]);
    assert.equal((await f.request('events',{runId:id})).body.truncated,true);
    assert.equal((await f.request('events',{runId:id,limit:101})).status,400);
    assert.equal((await f.request('events',{runId:id,after:-1})).status,400);
});

test('Agents web configuration requires explicit owner ingress and independent credentials',()=>{
    const base={DATABASE_URL:'postgres://unused',ATLAS_AGENTS_WEB_TOKEN_SHA256:tokenHash};
    assert.throws(()=>loadServerConfig(base),/Agents Web requires/);
    assert.throws(()=>loadServerConfig({...base,ATLAS_TRUSTED_INGRESS:'true',ATLAS_MCP_OAUTH_ISSUER:caller.issuer,ATLAS_MCP_OAUTH_ALLOWED_SUBJECT:caller.subject,ATLAS_MCP_RESOURCE:'https://atlas.invalid/mcp',ATLAS_MCP_RELAY_TOKEN_SHA256:tokenHash}),/independent/);
});
