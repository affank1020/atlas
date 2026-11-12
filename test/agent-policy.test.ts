import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentNodeHost, agentPolicySchema, readAgentPolicy } from '../apps/node/src/capabilities/pi/agent-host.js';
import { WorkspaceFiles } from '../apps/node/src/capabilities/workspace-files/files.js';
import { LocalNodeRuntime } from '../apps/node/src/platforms/desktop/runtime.js';
import type { AgentCommand } from '@atlas/protocol/agent-jobs';
const profile={id:'local',provider:'ollama' as const,model:'test',contextWindow:8192,maxTokens:512};
test('Pi Node capability is opt-in on Linux and macOS, not implicitly enabled on unsupported hosts', () => {
    const mockHost={ close:async()=>{} } as unknown as AgentNodeHost;
    const linux=new LocalNodeRuntime(['/tmp'],new Map(),'linux',undefined,false,undefined,undefined,mockHost);
    const emptyLinux=new LocalNodeRuntime(['/tmp'],new Map(),'linux');
    const darwin=new LocalNodeRuntime(['/tmp'],new Map(),'darwin',undefined,false,undefined,undefined,mockHost);
    assert.ok(linux.getCapabilities().includes('agent.pi'));
    assert.ok(darwin.getCapabilities().includes('agent.pi'));
    assert.ok(!emptyLinux.getCapabilities().includes('agent.pi'));
    assert.ok(!linux.getCapabilities().includes('workspace.dev'));
});
test('local policy is owner-private, Node-bound and rejects ambiguous or unsupported model authority',async t=>{
    const root=await mkdtemp(path.join(tmpdir(),'atlas-agent-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
    const policy={nodeId:randomUUID(),checkouts:[{id:randomUUID(),rootPath:root}],profiles:[profile]};
    const file=path.join(root,'policy.json');await writeFile(file,JSON.stringify(policy),{mode:0o600});
    assert.equal((await readAgentPolicy(file,policy.nodeId)).profiles[0].model,'test');
    await assert.rejects(readAgentPolicy(file,randomUUID()));
    await chmod(file,0o644);await assert.rejects(readAgentPolicy(file,policy.nodeId));
    assert.equal(agentPolicySchema.safeParse({...policy,profiles:[profile,{...profile,model:'other'}]}).success,false);
    assert.equal(agentPolicySchema.safeParse({...policy,profiles:[{...profile,provider:'hosted',apiKey:'secret'}]}).success,false);
});
test('expired, mismatched checkout and missing model policies reject before the worker can start',async t=>{
    const root=await mkdtemp(path.join(tmpdir(),'atlas-agent-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
    const nodeId=randomUUID(),workspaceId=randomUUID();
    let starts=0;
    const workers={start:async()=>{starts++;throw new Error('must not start');},get:()=>{throw new Error();},events:()=>({events:[],oldestCursor:0,lastCursor:0,truncated:false}),
        cancel:()=>{throw new Error();},close:async()=>{}};
    const host=new AgentNodeHost({nodeId,checkouts:[{id:workspaceId,rootPath:root}],profiles:[profile]},path.join(root,'journal'),new WorkspaceFiles([root]),workers);
    t.after(()=>host.close());
    const command:Extract<AgentCommand,{action:'start'}>={type:'agent.command',action:'start',runId:randomUUID(),token:randomUUID(),
        expiresAt:new Date(Date.now()+10000).toISOString(),workspace:{id:workspaceId,nodeId,rootPath:root,status:'active'},
        input:{runId:'',workspaceId,expectedHead:'0'.repeat(40),expectedBranch:'atlas/test',prompt:'Read',permission:'read-only',timeoutMs:1000,modelProfile:profile.id},profile};
    for(const change of [{expiresAt:new Date(0).toISOString()},{workspace:{...command.workspace,rootPath:'/unapproved'}},
        {profile:{...profile,id:'missing'}}]) {
        const runId=randomUUID();
        await host.handle({...command,...change,runId,input:{...command.input,runId}});
        const report=await host.report();assert.equal(report?.status,'rejected');
        host.ack({type:'agent.ack',runId,token:command.token,cursor:0});
    }
    assert.equal(starts,0);
});
