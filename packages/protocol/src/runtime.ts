import type { Workspace } from './workspace.js';
import type { WorkspaceOperation } from './workspace-operations.js';
import type { NodeCapability } from './node-model.js';
export type NodeOperation = WorkspaceOperation;
/** Transport-neutral, bounded domain operations. Bindings are interpreted only by the runtime. */
export interface NodeRuntime {
    getCapabilities(): NodeCapability[];
    bind(rootPath: string): Promise<string>;
    execute(workspace: Workspace, operation: NodeOperation, input: Record<string, any>): Promise<unknown>;
}
export const requiredCapability: Record<NodeOperation, NodeCapability> = {
    workspace_list_files: 'workspace.files', workspace_read_file: 'workspace.files',
    workspace_search_files: 'workspace.files', workspace_create_file: 'workspace.files',
    workspace_patch_file: 'workspace.files', workspace_delete_file: 'workspace.files',
    workspace_list_dev_tasks: 'workspace.dev', workspace_run_dev_task: 'workspace.dev',
    workspace_git_status: 'workspace.git', workspace_git_diff: 'workspace.git',
    unity_status: 'unity', unity_list_commands: 'unity', unity_run_command: 'unity',
    football_control: 'football.training',
};
