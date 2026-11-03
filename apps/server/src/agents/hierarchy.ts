import type { AgentHierarchyNode, AgentModelProfile, AgentState } from '@atlas/protocol/agent-jobs';

export type AgentChildProjection = {
    agentId:string; parentAgentId:string; role:'scout'|'worker'|'reviewer'|'general';
    state:AgentState; actualProfile:AgentModelProfile|null; requestedProfileId:string;
    startedAt:string; observedAt:string; finishedAt:string|null;
};

/**
 * Reconstruct the observed child tree from materialised event receipts.
 * This does not confer permission to spawn or write. On an uncertain parent run,
 * in-flight children are also uncertain rather than shown as safely stopped.
 */
export function buildAgentHierarchy(runId:string,rootState:AgentState,
    actualProfile:AgentModelProfile|null,records:AgentChildProjection[]):AgentHierarchyNode {
    const root:AgentHierarchyNode={agentId:runId,parentAgentId:null,role:'root',
        state:rootState,actualProfile,children:[]};
    const known=new Map<string,AgentHierarchyNode>([[runId,root]]);
    for(const record of records) {
        if(record.agentId===runId||known.has(record.agentId)||!known.has(record.parentAgentId))
            throw new Error('Invalid persisted child ancestry.');
        const state=rootState==='unknown' &&
            !['completed','failed','cancelled','timed_out','incomplete'].includes(record.state)
            ? 'unknown' : record.state;
        const child:AgentHierarchyNode={agentId:record.agentId,parentAgentId:record.parentAgentId,
            role:record.role,state,requestedProfileId:record.requestedProfileId,
            actualProfile:record.actualProfile,startedAt:record.startedAt,
            observedAt:record.observedAt,finishedAt:record.finishedAt,children:[]};
        known.get(record.parentAgentId)!.children.push(child);
        known.set(record.agentId,child);
    }
    return root;
}
