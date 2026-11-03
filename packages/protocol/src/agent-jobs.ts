import { z } from 'zod';
import { piStartSchema } from './pi-worker.js';

export const modelProfileSchema = z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    provider: z.literal('ollama'), model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/),
    contextWindow: z.number().int().min(4096).max(131072),
    maxTokens: z.number().int().min(256).max(16384),
}).strict().refine(x => x.maxTokens < x.contextWindow);
export type AgentModelProfile = z.infer<typeof modelProfileSchema>;
const uuid = z.string().uuid();
const cursor = z.number().int().min(0).max(1_000_000);
export const agentCommandSchema = z.discriminatedUnion('action', [
    z.object({ type: z.literal('agent.command'), action: z.literal('start'), runId: uuid, token: uuid,
        expiresAt: z.string().datetime(),
        workspace: z.object({ id: uuid, nodeId: uuid, rootPath: z.string().min(1).max(4096),
            status: z.literal('active') }).strict(),
        input: piStartSchema, profile: modelProfileSchema }).strict(),
    z.object({ type: z.literal('agent.command'), action: z.enum(['observe','cancel']), runId: uuid,
        token: uuid, after: cursor, profile: modelProfileSchema }).strict(),
]);
export type AgentCommand = z.infer<typeof agentCommandSchema>;
export const agentStateSchema = z.enum(['starting','running','completed','failed','cancelled','timed_out','incomplete']);
export const agentReceiptSchema = z.object({
    runId: uuid, workspaceId: uuid, nodeId: uuid, state: agentStateSchema,
    startedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
    exitCode: z.number().int().min(-255).max(255).nullable().optional(),
    signal: z.string().regex(/^SIG[A-Z0-9]{1,12}$/).nullable().optional(),
    reason: z.enum(['spawn_failed','operator_cancel','deadline','startup_timeout','output_limit','frame_limit',
        'invalid_protocol','stdin_failed','pi_error','pi_finished','unexpected_exit_or_result','lock_cleanup_failed']).optional(),
    pid: z.number().int().positive().optional(), runtimeVersion: z.literal('1.5.0'),
    permission: z.literal('read-only'), head: z.string().regex(/^[a-f0-9]{40}$/),
    branch: piStartSchema.shape.expectedBranch, lastCursor: cursor,
}).strict();
// Metadata only. Drop raw text/args/results on the producer; reject them at the wire boundary.
const eventBase={cursor:cursor.refine(x=>x>0),at:z.string().datetime()};
export const agentChildRoleSchema=z.enum(['scout','worker','reviewer','general']);
export const agentChildTerminalSchema=z.enum(['completed','failed','cancelled','timed_out','incomplete']);
const childId=z.string().uuid();
const childProfileId=modelProfileSchema.shape.id;
export const agentEventSchema = z.discriminatedUnion('type',[
    z.object({...eventBase,type:z.enum(['starting','agent_start','agent_end','agent_settled','process_heartbeat','worker_error']),data:z.object({}).strict()}).strict(),
    z.object({...eventBase,type:z.literal('ready'),data:z.object({version:z.literal('1.5.0')}).strict()}).strict(),
    z.object({...eventBase,type:z.literal('tool_execution_start'),data:z.object({tool:z.literal('read')}).strict()}).strict(),
    z.object({...eventBase,type:z.literal('tool_execution_end'),data:z.object({tool:z.literal('read'),isError:z.boolean()}).strict()}).strict(),
    z.object({...eventBase,type:z.literal('result'),data:z.object({ok:z.boolean()}).strict()}).strict(),
    // Produced only by a reviewed native Pi child runtime. No prompt, raw tool data or
    // model text is accepted; an event is observation, not authority to spawn a child.
    z.object({...eventBase,type:z.literal('child_start'),data:z.object({
        agentId:childId,parentAgentId:childId,role:agentChildRoleSchema,
        requestedProfileId:childProfileId,
    }).strict()}).strict(),
    z.object({...eventBase,type:z.literal('child_state'),data:z.object({
        agentId:childId,state:z.enum(['starting','running']),
        actualProfile:modelProfileSchema.optional(),
    }).strict()}).strict(),
    z.object({...eventBase,type:z.literal('child_terminal'),data:z.object({
        agentId:childId,state:agentChildTerminalSchema,
        actualProfile:modelProfileSchema.optional(),
    }).strict()}).strict(),
    z.object({...eventBase,type:z.literal('stopping'),data:z.object({reason:agentReceiptSchema.shape.reason.unwrap()}).strict()}).strict(),
    z.object({...eventBase,type:z.literal('terminal'),data:z.object({state:agentStateSchema,reason:agentReceiptSchema.shape.reason.unwrap()}).strict()}).strict(),
]);
export const agentReportSchema = z.object({
    type: z.literal('agent.report'), runId: uuid, token: uuid,
    status: z.enum(['observed','pending','missing','rejected']),
    receipt: agentReceiptSchema.nullable(), profile: modelProfileSchema,
    events: z.array(agentEventSchema).max(32), oldestCursor: cursor,
}).strict();
export type AgentReport = z.infer<typeof agentReportSchema>;
export const agentAckSchema = z.object({ type: z.literal('agent.ack'), runId: uuid, token: uuid, cursor }).strict();
export const agentSchemas = {
    agent_list: z.object({
        state: z.enum(['active','dispatching','starting','running','cancelling','unknown','completed','failed','cancelled','timed_out','incomplete']).optional(),
        nodeId: uuid.optional(), checkoutId: uuid.optional(), logicalWorkspaceId: uuid.optional(),
        before: z.object({createdAt:z.string().datetime(),runId:uuid}).strict().optional(),
        limit:z.number().int().min(1).max(100).default(50),
    }).strict(),
    agent_start: z.object({ runId: uuid, checkoutId: uuid, approvalId: uuid,
        instruction: z.string().min(1).max(16384), profileId: modelProfileSchema.shape.id,
        permission: z.literal('read-only'), timeoutMs: piStartSchema.shape.timeoutMs }).strict(),
    agent_get: z.object({ runId: uuid }).strict(),
    agent_events: z.object({ runId: uuid, after: cursor.default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    agent_control: z.object({ runId: uuid, action: z.literal('cancel') }).strict(),
};
export type AgentTool = keyof typeof agentSchemas;

export type AgentState = 'dispatching' | 'starting' | 'running' | 'cancelling' | 'unknown' |
    'completed' | 'failed' | 'cancelled' | 'timed_out' | 'incomplete';
// A hierarchy is an observation contract, never authority to delegate. Child rows
// require authenticated Node runtime events; the first Pi worker still emits only root.
export type AgentHierarchyNode = {
    agentId:string; parentAgentId:string|null; role:string; state:AgentState;
    actualProfile:AgentModelProfile|null; requestedProfileId?:string;
    startedAt?:string|null; observedAt?:string|null; finishedAt?:string|null;
    children:AgentHierarchyNode[];
};
export type AgentRunView = {
    runId:string; checkoutId:string; nodeId:string; projectId:string|null; logicalWorkspaceId:string|null;
    state:AgentState; permission:'read-only'; requestedProfileId:string; requestedProfile:AgentModelProfile;
    actualProfile:AgentModelProfile|null; head:string; branch:string;
    createdAt:string; startedAt:string|null; observedAt:string|null; finishedAt:string|null; cancelRequestedAt:string|null;
    lastCursor:number; eventGap:boolean; result:z.infer<typeof agentReceiptSchema>|null; reason:string|null;
    nodeName:string; nodeOnline:boolean; checkoutName:string; approvedRoot:string;
    source:'owner-oauth'; canCancel:boolean; hierarchy:AgentHierarchyNode;
    evidence:{source:'authenticated_node_process_receipts';verifiedTests:never[];verifiedCommits:never[];
        taskSuccessVerified:false;runtimeReady?:boolean;agentStarted?:boolean;agentSettled?:boolean;
        piResult?:boolean;terminalCompleted?:boolean;toolExecutions?:number};
};
export type AgentRunPage = {runs:AgentRunView[];next:{createdAt:string;runId:string}|null;
    scopes?:{nodes:{id:string;name:string}[];checkouts:{id:string;name:string}[];truncated:boolean}};
export type AgentEventPage = {runId:string;events:z.infer<typeof agentEventSchema>[];oldestCursor:number;lastCursor:number;truncated:boolean};
