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
export const agentEventSchema = z.discriminatedUnion('type',[
    z.object({...eventBase,type:z.enum(['starting','agent_start','agent_end','agent_settled','process_heartbeat']),data:z.object({}).strict()}).strict(),
    z.object({...eventBase,type:z.literal('ready'),data:z.object({version:z.literal('1.5.0')}).strict()}).strict(),
    z.object({...eventBase,type:z.literal('tool_execution_start'),data:z.object({tool:z.literal('read')}).strict()}).strict(),
    z.object({...eventBase,type:z.literal('tool_execution_end'),data:z.object({tool:z.literal('read'),isError:z.boolean()}).strict()}).strict(),
    z.object({...eventBase,type:z.literal('result'),data:z.object({ok:z.boolean()}).strict()}).strict(),
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
    agent_start: z.object({ runId: uuid, checkoutId: uuid, approvalId: uuid,
        instruction: z.string().min(1).max(16384), profileId: modelProfileSchema.shape.id,
        permission: z.literal('read-only'), timeoutMs: piStartSchema.shape.timeoutMs }).strict(),
    agent_get: z.object({ runId: uuid }).strict(),
    agent_events: z.object({ runId: uuid, after: cursor.default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    agent_control: z.object({ runId: uuid, action: z.literal('cancel') }).strict(),
};
export type AgentTool = keyof typeof agentSchemas;
