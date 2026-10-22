import { randomUUID } from 'node:crypto';
import { GitHubBroker } from './github-broker.js';
import type { WorkspaceTransaction, WorkspaceRepository } from './repository.js';
import type { CoreService } from '../core/service.js';
import { AtlasError } from '../shared/errors.js';
import type { NodeRouter } from '../nodes/router.js';
import type { DevTaskResult } from './dev-tasks.js';
import type { Workspace } from './model.js';
import type { WorkspaceOperation } from '@atlas/protocol/workspace-operations';
import { workspaceSchemas, type WorkspaceToolName } from './contracts.js';

export class WorkspaceService {
    constructor(readonly catalog: Pick<CoreService, 'getProject'>, readonly repository: WorkspaceRepository, readonly runtime: NodeRouter, readonly github = new GitHubBroker()) {}
    async call(name: WorkspaceToolName, input: unknown) {
        if (!Object.hasOwn(workspaceSchemas, name)) throw new AtlasError('Unsupported Workspace operation.', 'INVALID_REQUEST');
        const parsed = workspaceSchemas[name].safeParse(input);
        if (!parsed.success) throw new AtlasError(parsed.error.message);
        const x: any = parsed.data;
        if (name === 'list_github_repositories') return this.github.listRepositories();
        if (name === 'list_workspaces') return this.repository.listAll(x.includeArchived, x.nodeId);
        if (x.projectId) await this.catalog.getProject(x.projectId, x.includeArchived);
        if (name === 'list_project_workspaces') return this.repository.list(x.projectId, x.includeArchived);
        if (name === 'create_workspace') {
            const binding = await this.runtime.bindDefault(x.rootPath, x.nodeId);
            const db = await this.repository.connect();
            try {
                await db.begin();
                if (x.projectId) await db.requireActiveProject(x.projectId, true);
                const workspace = await db.insert({ projectId: x.projectId, name: x.name, ...binding, kind: x.kind });
                await db.audit(workspace, 'workspace.created', x.client, workspace); await db.commit(); return workspace;
            } catch (e: any) { await db.rollback(); throw e; }
            finally { db.release(); }
        }
        const workspace = x.projectId && name !== 'link_workspace_project' && name !== 'unlink_workspace_project'
            ? await this.repository.get(x.projectId, x.workspaceId, x.includeArchived)
            : await this.repository.getById(x.workspaceId, x.includeArchived);
        if (name === 'get_workspace') return workspace;
        if (name === 'link_workspace_project' || name === 'unlink_workspace_project') {
            const db = await this.repository.connect();
            try {
                await db.begin();
                await db.requireActiveProject(x.projectId, true);
                await db.lockWorkspace(workspace.id);
                if (name === 'link_workspace_project') await db.link(workspace.id, x.projectId);
                else await db.unlink(workspace.id, x.projectId);
                const updated = await db.getById(workspace.id);
                await db.audit(updated, name === 'link_workspace_project' ? 'workspace.project_linked' : 'workspace.project_unlinked', x.client,
                    { workspaceId: workspace.id, projectId: x.projectId });
                await db.commit();
                return updated;
            } catch (error) { await db.rollback(); throw error; } finally { db.release(); }
        }
        if (name === 'update_workspace' || name === 'archive_workspace') {
            const db = await this.repository.connect();
            try {
                await db.begin(); await db.lockWorkspace(workspace.id);
                if (x.projectId) await db.get(x.projectId, workspace.id, false);
                else await db.getById(workspace.id, false);
                const changed = await db.update(workspace.id, x.name, name === 'archive_workspace'); await db.audit(changed, name === 'archive_workspace' ? 'workspace.archived' : 'workspace.updated', x.client, changed); await db.commit(); return changed;
            } catch (e) { await db.rollback(); throw e; } finally { db.release(); }
        }
        const footballActions = {
            football_train: 'launch_headless',
            football_evaluate: 'evaluate',
            football_training_status: 'jobs',
            football_evaluation_status: 'evaluation_status',
            football_stop: 'stop_job',
        } as const;
        const footballAction = footballActions[name as keyof typeof footballActions];
        if (footballAction && (x.projectId !== 'ce09dbe0-0755-4bd8-9376-e4a3152d59f7' || workspace.kind !== 'unity' || workspace.status !== 'active'))
            throw new AtlasError('Football MCP actions require the active AI Football Unity Workspace.', 'WORKSPACE_UNAVAILABLE');
        const nodeOperation = (footballAction ? 'football_control' : name) as WorkspaceOperation;
        const target = name === 'workspace_git_remove_worktree'
            ? await this.repository.getById(x.targetWorkspaceId) : undefined;
        if (target && (target.nodeId !== workspace.nodeId || target.id === workspace.id ||
            target.kind !== 'generic'))
            throw new AtlasError('Worktree must be a different active Workspace on the same Node.', 'WORKSPACE_DENIED');
        const nodeInput = footballAction ? { ...x, action: footballAction }
            : target ? { ...x, targetPath: target.rootPath } : x;
        const invoke = () => this.runtime.execute(workspace, nodeOperation, nodeInput);
        const operation = ({ workspace_create_file: 'workspace.file_created', workspace_patch_file: 'workspace.file_patched', workspace_delete_file: 'workspace.file_deleted', workspace_git_create_branch: 'workspace.git_branch_created', workspace_git_switch_branch: 'workspace.git_branch_switched', workspace_git_stage: 'workspace.git_staged', workspace_git_commit: 'workspace.git_committed', workspace_git_push_branch: 'workspace.git_pushed', workspace_git_clone_repository: 'workspace.git_repository_cloned', workspace_git_create_worktree: 'workspace.git_worktree_created', workspace_git_remove_worktree: 'workspace.git_worktree_removed', workspace_git_open_pull_request: 'workspace.git_pull_request_created',  unity_run_command: 'workspace.unity_invoked', workspace_run_dev_task: 'workspace.dev_invoked', football_train: 'football.training_requested', football_evaluate: 'football.evaluation_requested', football_stop: 'football.stop_requested' } as Record<string, string>)[name];
        const inspection = ({ workspace_list_files: 'workspace.file_listed', workspace_read_file: 'workspace.file_read', workspace_search_files: 'workspace.files_searched', workspace_git_status: 'workspace.git_status', workspace_git_diff: 'workspace.git_diff', workspace_git_list_worktrees: 'workspace.git_worktrees_listed', unity_status: 'workspace.unity_status', unity_list_commands: 'workspace.unity_commands', workspace_list_dev_tasks: 'workspace.dev_tasks_listed', football_training_status: 'football.jobs_inspected', football_evaluation_status: 'football.evaluation_inspected' } as Record<string, string>)[name];
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
            // Server-only PR creation and server-brokered ephemeral GitHub tokens:
            // neither operation accepts secrets from MCP nor persists them to audit.
            // Resolve the target Node BEFORE acquiring any DB locks. A managed
            // deletion is then authorised using the locked creation audit below.
            const removeRuntime = target
                ? await this.runtime.resolve(workspace.nodeId, 'workspace.git') : undefined;
            const execute = name === 'workspace_git_open_pull_request'
                ? await (async () => {
                    // The broker has access to multiple installations. Verify this
                    // exact Node checkout first, inside the existing mutation lock,
                    // before allowing a server-side GitHub PR operation.
                    const inspect = await this.runtime.prepare(workspace, 'workspace_git_status', {
                        workspaceId: workspace.id,
                    });
                    return async () => {
                        const git = await inspect() as {
                            available?: boolean; branch?: string; head?: string; originRepository?: string | null;
                        };
                        if (git?.available !== true || git.branch !== x.branch ||
                            git.head !== x.expectedHead ||
                            git.originRepository?.toLowerCase() !== x.repository.toLowerCase())
                            throw new AtlasError('Workspace checkout does not match the requested GitHub PR repository, branch and commit.', 'WORKSPACE_DENIED');
                        return this.github.createDraftPullRequest(x.repository, x.branch, x.expectedHead, x.title, x.body);
                    };
                })()
                : target
                    ? async (current: Workspace) => {
                        const expectedBranch = await db!.managedWorktreeBranch(
                            target.id, workspace.id, target.rootPath);
                        if (!expectedBranch)
                            throw new AtlasError('Only an Atlas-created worktree can be removed through Atlas.', 'WORKSPACE_DENIED');
                        // Never trust the caller to provide the branch or target
                        // path. The Node independently checks both Git identity
                        // and the expected branch before any filesystem deletion.
                        return removeRuntime!.execute(current, nodeOperation, { ...nodeInput, expectedBranch });
                    }
                : await this.runtime.prepare(workspace, nodeOperation, name === 'workspace_git_push_branch'
                    ? { ...nodeInput, githubToken: await this.github.gitPublishToken(x.repository) }
                    : name === 'workspace_git_clone_repository'
                        ? { ...nodeInput, githubToken: await this.github.repositoryReadToken(x.repository) }
                        : nodeInput);
            // Resolve the Node's filesystem binder before acquiring a DB connection.
            // The post-creation bind must not re-query Nodes while the mutation
            // transaction is holding the pool and Workspace locks.
            const checkoutRuntime = (name === 'workspace_git_create_worktree' ||
                name === 'workspace_git_clone_repository')
                ? await this.runtime.resolve(workspace.nodeId, 'workspace.files') : undefined;
            db = await this.repository.connect();
            await db.begin();
            await db.lockExecution(`${workspace.nodeId}:${workspace.rootPath}`);
            // Do not hold a Core project row lock across slow external-tool calls.
            if (x.projectId) await db.requireActiveProject(x.projectId);
            await db.lockWorkspace(workspace.id);
            const current = x.projectId ? await db.get(x.projectId, workspace.id, false) : await db.getById(workspace.id, false);
            if (current.nodeId !== workspace.nodeId || current.rootPath !== workspace.rootPath)
                throw new AtlasError('Workspace binding changed; retry the operation.', 'CONFLICT');
            if (target) {
                await db.lockWorkspace(target.id);
                const latest = await db.getById(target.id);
                if (latest.nodeId !== target.nodeId || latest.rootPath !== target.rootPath)
                    throw new AtlasError('Target worktree binding changed.', 'CONFLICT');
            }
            let result: any = await execute(current); applied = true;
            if (name === 'workspace_git_create_worktree' || name === 'workspace_git_clone_repository') {
                // Only register the new checkout after the Node has created and
                // verified it. A database failure leaves it intact for recovery.
                const boundPath = await checkoutRuntime!.bind(result.rootPath);
                const expectedPath = name === 'workspace_git_clone_repository'
                    ? workspace.rootPath.replace(/\/$/, '') + '/' + x.directoryName : x.targetPath;
                if (boundPath !== expectedPath || result.rootPath !== expectedPath)
                    throw new AtlasError('Created checkout binding changed.', 'CONFLICT');
                const registered = await db.insert({ nodeId: workspace.nodeId,
                    // A manager directory is infrastructure, not the cloned repo's Project.
                    // Clones start independent unless explicitly scoped; feature worktrees
                    // inherit their source Project if no Project was supplied.
                    projectId: name === 'workspace_git_clone_repository'
                        ? (x.projectId ?? null) : (x.projectId ?? workspace.projectId),
                    rootPath: boundPath, name: x.name ?? x.branch ?? x.repository, kind: 'generic' });
                await db.audit(registered, 'workspace.created', x.client, {
                    sourceWorkspaceId: workspace.id, branch: result.branch,
                    rootPath: registered.rootPath,
                    managedKind: name === 'workspace_git_create_worktree' ? 'git_worktree' : 'github_clone',
                    repository: result.repository,
                });
                result = { ...result, workspace: registered };
            }
            if (name === 'workspace_git_remove_worktree' && target) {
                await db.update(target.id, undefined, true);
                await db.audit(target, 'workspace.archived', x.client,
                    { sourceWorkspaceId: workspace.id, preservedBranch: result.preservedBranch });
            }
            const outcome = name === 'unity_run_command' && (result as any)?.isError ? 'editor_error' : name === 'workspace_run_dev_task' && !(result as DevTaskResult).success ? 'failed' : 'completed';
            const devSummary = name === 'workspace_run_dev_task' ? (() => { const run = result as DevTaskResult; return { task: x.task, nodeId: workspace.nodeId, startedAt: run.startedAt, completedAt: run.completedAt, durationMs: run.durationMs, exitCode: run.exitCode, timedOut: run.timedOut, success: run.success, stdoutTruncated: run.stdoutTruncated, stderrTruncated: run.stderrTruncated }; })() : {};
            await db.audit(workspace, operation, x.client, { ...metadata, outcome, ...(outcome === 'editor_error' && { error: 'Unity reported an Editor error.' }), ...devSummary, ...(name.startsWith('workspace_') && name !== 'workspace_run_dev_task' ? { result } : {}) });
            await db.commit(); return result;
        } catch (error) {
            await db?.rollback().catch(() => undefined);
            await (db ?? this.repository).audit(workspace, 'workspace.mutation_failed', x.client, {
                ...metadata, outcome: 'failed_or_uncertain', error: auditError(error),
                ...(name === 'workspace_git_push_branch' ? auditGitPushErrorCode(error) : {}),
            }).catch(() => undefined);
            if (applied) throw new AtlasError('The mutation completed but audit finalization failed. Inspect the file/Editor and audit intent before retrying.', 'OUTCOME_UNCERTAIN');
            throw error;
        } finally { db?.release(); }

    }
}
// Persist only stable, known failure codes. Remote errors and plugin inputs are
// untrusted; arbitrary error.code strings must never enter the audit stream.
const gitPushAuditCodes = new Set([
    'GITHUB_WORKFLOWS_PERMISSION_REQUIRED', 'GITHUB_REQUEST_FAILED', 'GITHUB_UNAVAILABLE',
    'GIT_PUSH_NON_FAST_FORWARD', 'GIT_PUSH_PROTECTED', 'GIT_PUSH_AUTH_FAILED',
    'GIT_PUSH_NETWORK_FAILED', 'GIT_PUSH_TIMEOUT', 'GIT_PUSH_NODE_UNAVAILABLE',
    'GIT_PUSH_FAILED', 'GIT_REMOTE_INVALID', 'GIT_REMOTE_MISMATCH',
    'WORKSPACE_DENIED', 'CAPABILITY_UNAVAILABLE', 'CONFLICT',
    'NODE_OFFLINE', 'NODE_UNAVAILABLE', 'NODE_EXECUTION_ERROR',
]);
function auditGitPushErrorCode(error: unknown): { errorCode?: string } {
    return error instanceof AtlasError && gitPushAuditCodes.has(error.code)
        ? { errorCode: error.code }
        : {};
}

// Bounded diagnostic only; never serialize arbitrary adapter error payloads.
function auditError(error: unknown): string {
    if (error instanceof AtlasError) return error.message.slice(0, 500);
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return ({ ENOENT: 'File or directory not found.', EEXIST: 'File already exists.', EACCES: 'Permission denied.', EPERM: 'Operation not permitted.' } as Record<string, string>)[code ?? ''] ?? 'Workspace operation failed. Inspect the client response for details.';
}
