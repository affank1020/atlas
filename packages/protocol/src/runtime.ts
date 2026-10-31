import type { Workspace } from './workspace.js';
import type { WorkspaceOperation } from './workspace-operations.js';
import type { NodeCapability } from './node-model.js';
export type NodeOperation = WorkspaceOperation;
/** Transport-neutral, bounded domain operations. Bindings are interpreted only by the runtime. */
export interface NodeRuntime {
    /** Optional, explicitly approved by the recipient. Never automatically change clipboard. */
    receiveDeviceShare?(input: {
        deliveryId: string; sourceNodeId: string; text: string; expiresAt: string;
    }): Promise<{ accepted: boolean }>;
    /** The transport fetches approved binary bytes over authenticated HTTPS
     * before invoking this method. Clipboard writes require explicit approval. */
    receiveDeviceImage?(input: {
        deliveryId: string; sourceNodeId: string; mimeType: 'image/png' | 'image/jpeg';
        byteLength: number; sha256: string; expiresAt: string; bytes: Buffer;
    }): Promise<{ accepted: boolean }>;
    getCapabilities(): NodeCapability[];
    bind(rootPath: string): Promise<string>;
    readLogs?(source: 'stdout' | 'stderr' | 'journal' | 'service', lines: number): Promise<{ source: string; lines: string[]; available: boolean; truncated: boolean }>;
    execute(workspace: Workspace, operation: NodeOperation, input: Record<string, any>): Promise<unknown>;
}
export const requiredCapability: Record<NodeOperation, NodeCapability> = {
    workspace_list_files: 'workspace.files', workspace_read_file: 'workspace.files',
    workspace_search_files: 'workspace.files', workspace_create_file: 'workspace.files',
    workspace_patch_file: 'workspace.files', workspace_delete_file: 'workspace.files',
    workspace_list_dev_tasks: 'workspace.dev', workspace_run_dev_task: 'workspace.dev',
    workspace_git_status: 'workspace.git', workspace_git_diff: 'workspace.git',
    workspace_git_list_worktrees: 'workspace.git', workspace_git_clone_repository: 'workspace.git', workspace_git_create_worktree: 'workspace.git',
    workspace_git_remove_worktree: 'workspace.git', workspace_git_retirement_preflight: 'workspace.git',
    workspace_git_create_branch: 'workspace.git', workspace_git_switch_branch: 'workspace.git',
    workspace_git_stage: 'workspace.git', workspace_git_commit: 'workspace.git',
    workspace_git_push_branch: 'workspace.git',

    unity_status: 'unity', unity_list_commands: 'unity', unity_run_command: 'unity',
    football_control: 'football.training',
};
