import type { DevTasks } from './dev-tasks.js';
export type Workspace = { id: string; nodeId: string; projectId: string; name: string; rootPath: string; kind: 'generic' | 'unity'; adapter: 'unity' | null; status: 'active' | 'archived'; devTasks: DevTasks; createdAt: string; updatedAt: string; archivedAt?: string };
export interface WorkspaceAdapter {
    status(workspace: Workspace): Promise<unknown>;
    capabilities(workspace: Workspace): Promise<unknown>;
    invoke(workspace: Workspace, command: string, parameters: Record<string, unknown>): Promise<unknown>;
}
