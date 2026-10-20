import { z } from 'zod';
export const nodeSchemas = {
    list_nodes: z.object({}).strict(),
    get_node: z.object({ nodeId: z.string().uuid() }).strict(),
    read_node_logs: z.object({ nodeId: z.string().uuid(), source: z.enum(['stdout', 'stderr']).default('stderr'), lines: z.number().int().min(1).max(200).default(100) }).strict(),
    create_node_enrolment: z.object({}).strict(),
    update_node: z.object({ nodeId: z.string().uuid(), name: z.string().trim().min(1).max(200) }).strict(),
    rotate_node_credential: z.object({ nodeId: z.string().uuid() }).strict(),
    revoke_node: z.object({ nodeId: z.string().uuid() }).strict(),
    assign_workspace_node: z.object({ projectId: z.string().uuid(), workspaceId: z.string().uuid(), nodeId: z.string().uuid(), expectedNodeId: z.string().uuid() }).strict(),
};
export type NodeToolName = keyof typeof nodeSchemas;
