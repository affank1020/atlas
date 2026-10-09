import { runDevTask } from '../../capabilities/dev/runner.js';
import { devTasksSchema, displayCommand } from '@atlas/protocol/dev-tasks';
import { WorkspaceFiles, git } from '../../capabilities/workspace-files/files.js';
import { UnityAdapter } from '../../capabilities/unity/unity.js';
import { footballControl } from '../../capabilities/football.js';
import { AtlasError } from '@atlas/protocol/errors';
import type { NodeRuntime } from '@atlas/protocol/runtime';
import type { NodeCapability } from '@atlas/protocol/node-model';
import type { Workspace, WorkspaceAdapter } from '@atlas/protocol/workspace';
import type { WorkspaceOperation } from '@atlas/protocol/workspace-operations';
export class LocalNodeRuntime implements NodeRuntime {
    private readonly shutdown = new AbortController();
    close() { this.shutdown.abort(); }
    readonly files: WorkspaceFiles;
    readonly adapters: Map<string, WorkspaceAdapter>;
    constructor(roots: string[], adapters?: Map<string, WorkspaceAdapter>) {
        this.files = new WorkspaceFiles(roots);
        this.adapters = adapters ?? new Map([["unity", new UnityAdapter(this.files)]]);
    }
    getCapabilities(): NodeCapability[] { return ["workspace.files", "workspace.git", "workspace.dev", "football.training", ...(this.adapters.has("unity") ? ["unity" as const] : [])]; }
    bind(rootPath: string) { return this.files.bind(rootPath); }
    async execute(workspace: Workspace, name: WorkspaceOperation, x: Record<string, any>) {
        const adapter = workspace.adapter ? this.adapters.get(workspace.adapter) : undefined;
            await this.files.resolve(workspace.rootPath, '');
            switch (name) {
                case 'workspace_list_files': return this.files.list(workspace.rootPath, x.path, x.depth, x.limit);
                case 'workspace_read_file': return this.files.read(workspace.rootPath, x.path);
                case 'workspace_search_files': return this.files.search(workspace.rootPath, x.query, x.path, x.limit);
                case 'workspace_create_file': return this.files.create(workspace.rootPath, x.path, x.text);
                case 'workspace_patch_file': return this.files.patch(workspace.rootPath, x.path, x.expectedSha256, x.oldText, x.newText);
                case 'workspace_delete_file': return this.files.delete(workspace.rootPath, x.path, x.expectedSha256);
                case 'workspace_list_dev_tasks': {
                    const tasks = devTasksSchema.parse(workspace.devTasks);
                    return Object.entries(tasks).map(([task, definition]) => ({ task, command: displayCommand(definition), timeoutMs: definition.timeoutMs }));
                }
                case 'workspace_run_dev_task': {
                    const tasks = devTasksSchema.parse(workspace.devTasks);
                    const task = Object.hasOwn(tasks, x.task) ? tasks[x.task] : undefined;
                    if (!task) throw new AtlasError('Development task is not configured on this Workspace.', 'TASK_UNAVAILABLE');
                    return runDevTask(workspace, x.task, task, this.shutdown.signal);
                }
                case 'workspace_git_status': return git(workspace.rootPath, this.files);
                case 'workspace_git_diff': return git(workspace.rootPath, this.files, true);
                case 'unity_status': return adapter ? adapter.status(workspace) : { available: false, state: 'no_adapter' };
                case 'unity_list_commands': return adapter ? adapter.capabilities(workspace) : { available: false, state: 'no_adapter', commands: [] };
                case 'unity_run_command': if (!adapter) throw new AtlasError('Workspace has no available Unity adapter.', 'ADAPTER_UNAVAILABLE'); return adapter.invoke(workspace, x.command, x.parameters);
                case 'football_control': return footballControl(workspace, x);
            }
    }
}

