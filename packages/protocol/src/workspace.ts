import type { DevTasks } from './dev-tasks.js';
/** Legacy Workspace is a Node-bound checkout until MCP operations migrate to checkoutId. */
export type Workspace = { id: string; logicalWorkspaceId?: string; nodeId: string; projectId: string | null; name: string; rootPath: string; kind: 'generic' | 'unity'; adapter: 'unity' | null; status: 'active' | 'archived'; devTasks: DevTasks; createdAt: string; updatedAt: string; archivedAt?: string };
/** One logical development identity, with zero or more node-bound checkouts. */
export type LogicalWorkspace = {
    id: string; name: string; repository: string | null; kind: 'git' | 'local';
    checkouts: Workspace[]; createdAt: string; updatedAt: string;
};
export interface WorkspaceAdapter {
    status(workspace: Workspace): Promise<unknown>;
    capabilities(workspace: Workspace): Promise<unknown>;
    invoke(workspace: Workspace, command: string, parameters: Record<string, unknown>): Promise<unknown>;
}
