import { z } from 'zod';
export const nodeSchemas = {
    list_nodes: z.object({}).strict(),
    get_node: z.object({ nodeId: z.string().uuid() }).strict(),
};
export type NodeToolName = keyof typeof nodeSchemas;
