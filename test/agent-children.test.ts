import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentEventSchema } from '@atlas/protocol/agent-jobs';
import { buildAgentHierarchy, type AgentChildProjection } from '../apps/server/src/agents/hierarchy.js';

test('bounded child lifecycle events reject prose, paths, credentials and unknown roles', () => {
    const parentAgentId=randomUUID(),agentId=randomUUID(),at=new Date().toISOString();
    const event={type:'child_start',cursor:1,at,
        data:{agentId,parentAgentId,role:'reviewer',requestedProfileId:'review-hosted'}};
    assert.equal(agentEventSchema.safeParse(event).success,true);
    for(const data of [
        {...event.data,role:'sudo'},
        {...event.data,toolArgs:'cat /etc/passwd'},
        {...event.data,apiKey:'secret'},
        {...event.data,agentId:'not-a-uuid'},
    ]) assert.equal(agentEventSchema.safeParse({...event,data}).success,false);
    assert.equal(agentEventSchema.safeParse({type:'child_terminal',cursor:2,at,
        data:{agentId,state:'completed',modelOutput:'I ran tests'}}).success,false);
});

test('child hierarchy preserves ordered ancestry and marks only in-flight children uncertain', () => {
    const root=randomUUID(),scout=randomUUID(),reviewer=randomUUID(),now=new Date().toISOString();
    const rows:AgentChildProjection[]=[
        {agentId:scout,parentAgentId:root,role:'scout',requestedProfileId:'local',
            state:'completed',actualProfile:null,startedAt:now,observedAt:now,finishedAt:now},
        {agentId:reviewer,parentAgentId:scout,role:'reviewer',requestedProfileId:'strong',
            state:'running',actualProfile:null,startedAt:now,observedAt:now,finishedAt:null},
    ];
    const tree=buildAgentHierarchy(root,'unknown',null,rows);
    assert.equal(tree.children[0].state,'completed');
    assert.equal(tree.children[0].children[0].state,'unknown');
    assert.equal(tree.children[0].children[0].requestedProfileId,'strong');
    assert.throws(()=>buildAgentHierarchy(root,'running',null,[rows[1]]));
    assert.throws(()=>buildAgentHierarchy(root,'running',null,[rows[0],rows[0]]));
});
