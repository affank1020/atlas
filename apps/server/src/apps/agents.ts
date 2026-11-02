import { agentSchemas } from '@atlas/protocol/agent-jobs';
import type { AgentService } from '../agents/service.js';
import type { ApplicationDefinition } from './registry.js';

/** Monitoring reuses the execution domain; it cannot grant approval or start work. */
export function agentsApplication(agents:Pick<AgentService,'call'>):ApplicationDefinition {
    return {type:'agents',slug:'agents',name:'Agents',description:'Observe Pi execution, process receipts and uncertain runs across Nodes and Workspaces.',
        tools:(['agent_list','agent_get','agent_events','agent_control'] as const).map(name=>({
            name,description:`${name}: owner-scoped durable Pi run monitoring.`,inputSchema:agentSchemas[name].shape,
            invoke:(input,caller)=>agents.call(name,input,caller),
        }))};
}
