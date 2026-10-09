import { randomUUID } from 'node:crypto';
import type { WorkspaceTransaction, WorkspaceRepository } from './repository.js';
import type { CoreService } from '../core/service.js';
import { AtlasError } from '../shared/errors.js';
import type { NodeRouter } from '../nodes/router.js';
import type { DevTaskResult } from './dev-tasks.js';
import type { Workspace } from './model.js';
import { workspaceSchemas, type WorkspaceToolName } from './contracts.js';

export class WorkspaceService {
    constructor(readonly catalog: Pick<CoreService, 'getProject'>, readonly repository: WorkspaceRepository, readonly runtime: NodeRouter) {}
    async call(name: WorkspaceToolName, input: unknown) {
        if (!Object.hasOwn(workspaceSchemas, name)) throw new AtlasError('Unsupported Workspace operation.', 'INVALID_REQUEST');
        const parsed = workspaceSchemas[name].safeParse(input);
        if (!parsed.success) throw new AtlasError(parsed.error.message);
        const x: any = parsed.data;
        await this.catalog.getProject(x.projectId, x.includeArchived);
        if (name === 'list_project_workspaces') return this.repository.list(x.projectId, x.includeArchived);
        if (name === 'create_workspace') {
            const binding = await this.runtime.bindDefault(x.rootPath, x.nodeId);
            const db = await this.repository.connect();
            try {
                await db.begin();
                await db.requireActiveProject(x.projectId, true);
                const workspace = await db.insert({ projectId: x.projectId, name: x.name, ...binding, kind: x.kind });
                await db.audit(workspace, 'workspace.created', x.client, workspace); await db.commit(); return workspace;
            } catch (e: any) { await db.rollback(); throw e; }
            finally { db.release(); }
        }
        const workspace = await this.repository.get(x.projectId, x.workspaceId, x.includeArchived);
        if (name === 'get_workspace') return workspace;
        if (name === 'update_workspace' || name === 'archive_workspace') {
            const db = await this.repository.connect();
            try {
                await db.begin(); await db.lockWorkspace(workspace.id);
                await db.get(x.projectId, workspace.id, false);
                const changed = await db.update(workspace.id, x.name, name === 'archive_workspace'); await db.audit(changed, name === 'archive_workspace' ? 'workspace.archived' : 'workspace.updated', x.client, changed); await db.commit(); return changed;
            } catch (e) { await db.rollback(); throw e; } finally { db.release(); }
        }
        if (name === 'workspace_run_dev_task' && !Object.hasOwn(workspace.devTasks, x.task))
            throw new AtlasError('Development task is not configured on this Workspace.', 'TASK_UNAVAILABLE');
        const invoke = () => this.runtime.execute(workspace, name, x);
        const operation = ({ workspace_create_file: 'workspace.file_created', workspace_patch_file: 'workspace.file_patched', workspace_delete_file: 'workspace.file_deleted', unity_run_command: 'workspace.unity_invoked', workspace_run_dev_task: 'workspace.dev_invoked' } as Record<string, string>)[name];
        const inspection = ({ workspace_list_files: 'workspace.file_listed', workspace_read_file: 'workspace.file_read', workspace_search_files: 'workspace.files_searched', workspace_git_status: 'workspace.git_status', workspace_git_diff: 'workspace.git_diff', unity_status: 'workspace.unity_status', unity_list_commands: 'workspace.unity_commands', workspace_list_dev_tasks: 'workspace.dev_tasks_listed' } as Record<string, string>)[name];
        if (inspection) {
            // One event per explicit tool call, never per internal file/adapter lookup.
            // Do not persist file contents, diffs, search text/results or command parameters.
            const metadata = { operation: inspection, activityKind: 'inspection', ...(x.path !== undefined && { path: x.path }) };
            let result;
            try { result = await invoke(); }
            catch (error) {
                await this.repository.audit(workspace, inspection, x.client, { ...metadata, outcome: 'failed', error: auditError(error) });
                throw error;
            }
            await this.repository.audit(workspace, inspection, x.client, { ...metadata, outcome: 'completed' });
            return result;
        }
        if (!operation) return invoke();
        // Serialize Atlas writers across processes. Commit an intent before touching disk/Editor:
        // filesystem and PostgreSQL cannot share an atomic transaction. A crash leaves a visible intent.
        const attemptId = randomUUID();
        const metadata = { workspaceId: workspace.id, attemptId, operation, ...(x.path && { path: x.path }), ...(x.command && { command: x.command }), ...(x.task && { task: x.task, nodeId: workspace.nodeId }), ...(x.expectedSha256 && { expectedSha256: x.expectedSha256 }) };
        // Persist before reserving the transaction connection: using a second pooled
        // connection while holding locks can deadlock a saturated connection pool.
        await this.repository.audit(workspace, 'workspace.mutation_requested', x.client, metadata);
        let db: WorkspaceTransaction | undefined; let applied = false;
        try {
            // Resolve registry/capabilities before leasing a mutation connection. Otherwise
            // concurrent writers can exhaust the pool and deadlock on Node lookup.
            const execute = await this.runtime.prepare(workspace, name, x);
            db = await this.repository.connect();
            await db.begin();
            await db.lockExecution(`${workspace.nodeId}:${workspace.rootPath}`);
            // Do not hold a Core project row lock across slow external-tool calls.
            await db.requireActiveProject(workspace.projectId);
            await db.lockWorkspace(workspace.id);
            const current = await db.get(x.projectId, workspace.id, false);
            if (current.nodeId !== workspace.nodeId || current.rootPath !== workspace.rootPath)
                throw new AtlasError('Workspace binding changed; retry the operation.', 'CONFLICT');
            if (name === 'workspace_run_dev_task' && !Object.hasOwn(current.devTasks, x.task))
                throw new AtlasError('Development task is not configured on this Workspace.', 'TASK_UNAVAILABLE');
            const result = await execute(current); applied = true;
            const outcome = name === 'unity_run_command' && (result as any)?.isError ? 'editor_error' : name === 'workspace_run_dev_task' && !(result as DevTaskResult).success ? 'failed' : 'completed';
            const devSummary = name === 'workspace_run_dev_task' ? (() => { const run = result as DevTaskResult; return { task: x.task, nodeId: workspace.nodeId, startedAt: run.startedAt, completedAt: run.completedAt, durationMs: run.durationMs, exitCode: run.exitCode, timedOut: run.timedOut, success: run.success, stdoutTruncated: run.stdoutTruncated, stderrTruncated: run.stderrTruncated }; })() : {};
            await db.audit(workspace, operation, x.client, { ...metadata, outcome, ...(outcome === 'editor_error' && { error: 'Unity reported an Editor error.' }), ...devSummary, ...(name.startsWith('workspace_') && name !== 'workspace_run_dev_task' ? { result } : {}) });
            await db.commit(); return result;
        } catch (error) {
            await db?.rollback().catch(() => undefined);
            await (db ?? this.repository).audit(workspace, 'workspace.mutation_failed', x.client, { ...metadata, outcome: 'failed_or_uncertain', error: auditError(error) }).catch(() => undefined);
            if (applied) throw new AtlasError('The mutation completed but audit finalization failed. Inspect the file/Editor and audit intent before retrying.', 'OUTCOME_UNCERTAIN');
            throw error;
        } finally { db?.release(); }

    }
}
// Bounded diagnostic only; never serialize arbitrary adapter error payloads.
function auditError(error: unknown): string {
    if (error instanceof AtlasError) return error.message.slice(0, 500);
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return ({ ENOENT: 'File or directory not found.', EEXIST: 'File already exists.', EACCES: 'Permission denied.', EPERM: 'Operation not permitted.' } as Record<string, string>)[code ?? ''] ?? 'Workspace operation failed. Inspect the client response for details.';
}
