import { z } from 'zod';
import { workspaceOperationSchemas, type WorkspaceOperation } from './workspace-operations.js';
import { devTasksSchema } from './dev-tasks.js';
import { requiredCapability } from './runtime.js';
export const NODE_PROTOCOL_VERSION = 2;
export const MAX_NODE_FRAME_BYTES = 2 * 1024 * 1024;
export const capabilitySchema = z.enum(['workspace.files', 'workspace.git', 'workspace.dev', 'unity', 'football.training']);
export const registrationSchema = z.object({
    type: z.literal('register'), protocol: z.literal(NODE_PROTOCOL_VERSION),
    nodeId: z.string().uuid(), name: z.string().trim().min(1).max(200),
    capabilities: z.array(capabilitySchema).max(16),
    platform: z.string().trim().min(1).max(80), version: z.string().max(80).optional(),
}).strict();
const workspaceSchema = z.object({
    id: z.string().uuid(), nodeId: z.string().uuid(), projectId: z.string().uuid(),
    name: z.string(), rootPath: z.string().min(1).max(4096),
    kind: z.enum(['generic', 'unity']), adapter: z.enum(['unity']).nullable(),
    status: z.enum(['active', 'archived']), devTasks: devTasksSchema,
    createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().optional(),
}).strict();
export const nodeRequestSchema = z.discriminatedUnion('kind', [
    z.object({ type: z.literal('request'), requestId: z.string().uuid(), kind: z.literal('bind'), rootPath: z.string().min(1).max(4096) }).strict(),
    z.object({ type: z.literal('request'), requestId: z.string().uuid(), kind: z.literal('execute'), workspace: workspaceSchema,
        operation: z.enum(Object.keys(requiredCapability) as [keyof typeof requiredCapability, ...(keyof typeof requiredCapability)[]]),
        input: z.record(z.string(), z.unknown()),
    }).strict(),
]);
export const nodeResponseSchema = z.discriminatedUnion('ok', [
    z.object({ type: z.literal('response'), requestId: z.string().uuid(), ok: z.literal(true), result: z.unknown() }).strict(),
    z.object({ type: z.literal('response'), requestId: z.string().uuid(), ok: z.literal(false), error: z.object({ code: z.string().max(80), message: z.string().max(500) }).strict() }).strict(),
]);
export const registeredSchema = z.object({ type: z.literal('registered'), nodeId: z.string().uuid(), protocol: z.literal(NODE_PROTOCOL_VERSION) }).strict();
/** Re-parse at the Node boundary; trust in the Server does not bypass Node-side policy. */
export function validateNodeOperation(operation: WorkspaceOperation, input: unknown) {
    return workspaceOperationSchemas[operation].safeParse(input);
}
