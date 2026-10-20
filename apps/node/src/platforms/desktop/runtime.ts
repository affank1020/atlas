import { runDevTask } from '../../capabilities/dev/runner.js';
import { discoverAutoScripts } from '../../capabilities/dev/auto-scripts.js';
import { devTasksSchema, displayCommand } from '@atlas/protocol/dev-tasks';
import { WorkspaceFiles, git } from '../../capabilities/workspace-files/files.js';
import { gitWrite } from '../../capabilities/workspace-files/git-write.js';
import { UnityAdapter } from '../../capabilities/unity/unity.js';
import { footballControl } from '../../capabilities/football.js';
import { footballValidation } from '../../capabilities/football-validation.js';
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
    private readonly platform: NodeJS.Platform;
    constructor(roots: string[], adapters?: Map<string, WorkspaceAdapter>, platform: NodeJS.Platform = process.platform) {
        this.platform = platform;
        this.files = new WorkspaceFiles(roots);
        // The Linux Node is intentionally not a Unity/football host. A Linux
        // development sandbox is not ready, so no dev execution is advertised.
        this.adapters = platform === 'linux' ? new Map()
            : adapters ?? new Map([["unity", new UnityAdapter(this.files)]]);
    }
    getCapabilities(): NodeCapability[] {
        const shared: NodeCapability[] = ["workspace.files", "workspace.git"];
        if (this.platform === 'linux') return shared;
        return [...shared, "workspace.dev", "football.training", ...(this.adapters.has("unity") ? ["unity" as const] : [])];
    }
    bind(rootPath: string) { return this.files.bind(rootPath); }
    async execute(workspace: Workspace, name: WorkspaceOperation, x: Record<string, any>) {
        // Defence in depth even for direct runtime callers: do not let a
        // forged remote request execute development or macOS-only operations.
        if (this.platform === 'linux' &&
            (name === 'workspace_run_dev_task' || name === 'workspace_list_dev_tasks' ||
             name.startsWith('unity_') || name === 'football_control')) {
            throw new AtlasError('Capability is not available on this Linux Node.', 'CAPABILITY_UNAVAILABLE');
        }
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
                    const configured = devTasksSchema.parse(workspace.devTasks);
                    const discovered = await discoverAutoScripts(workspace.rootPath);
                    return [
                        ...Object.entries(configured).map(([task, definition]) => ({
                            task, command: displayCommand(definition), timeoutMs: definition.timeoutMs, source: 'configured',
                        })),
                        ...Object.entries(discovered).filter(([task]) => !Object.hasOwn(configured, task)).map(([task, definition]) => ({
                            task, command: displayCommand(definition), timeoutMs: definition.timeoutMs, source: 'package-script',
                        })),
                    ];
                }
                case 'workspace_run_dev_task': {
                    const configured = devTasksSchema.parse(workspace.devTasks);
                    const task = Object.hasOwn(configured, x.task) ? configured[x.task]
                        : (await discoverAutoScripts(workspace.rootPath))[x.task];
                    if (!task) throw new AtlasError('Development task is unavailable or not enabled on this Workspace.', 'TASK_UNAVAILABLE');
                    return runDevTask(workspace, x.task, task, this.shutdown.signal);
                }
                case 'workspace_git_status': return git(workspace.rootPath, this.files);
                case 'workspace_git_diff': return git(workspace.rootPath, this.files, true);
                case 'workspace_git_create_branch':
                case 'workspace_git_switch_branch':
                case 'workspace_git_stage':
                case 'workspace_git_commit': return gitWrite(workspace.rootPath, this.files, name, x);
                case 'unity_status': return adapter ? adapter.status(workspace) : { available: false, state: 'no_adapter' };
                case 'unity_list_commands': return adapter ? adapter.capabilities(workspace) : { available: false, state: 'no_adapter', commands: [] };
                case 'unity_run_command': if (!adapter) throw new AtlasError('Workspace has no available Unity adapter.', 'ADAPTER_UNAVAILABLE'); return adapter.invoke(workspace, x.command, x.parameters);
                case 'football_control':
                    if (['validation_status', 'validation_python', 'validation_editor', 'validation_physics'].includes(x.action))
                        return footballValidation(workspace, x.action, adapter);
                    return footballControl(workspace, x);
            }
    }
}

