import { z } from 'zod';
import { workspaceOperationSchemas } from '@atlas/protocol/workspace-operations';
const project = { projectId: z.string().uuid() };
const scope = { projectId: z.string().uuid().optional(), workspaceId: z.string().uuid() };
const client = { client: z.string().trim().min(1).max(200).optional() };
const name = z.string().trim().min(1).max(200);
const file = z.string().min(1).max(4096);
const directory = z.string().max(4096).default('');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(512 * 1024);
// The Football Application's internal Node operation must not become a generic
// Workspace tool exposed through MCP or the unscoped HTTP dispatcher.
const { football_control: _footballControl, workspace_git_push_branch: _privatePush, workspace_git_clone_repository: _privateClone, ...publicWorkspaceOperations } = workspaceOperationSchemas;
export const workspaceSchemas = {
    list_github_repositories: z.object({}).strict(),
    list_workspaces: z.object({ nodeId: z.string().uuid().optional(), includeArchived: z.boolean().optional() }).strict(),
    list_logical_workspaces: z.object({ includeArchived: z.boolean().optional() }).strict(),
    attach_checkout_repository: z.object({ ...scope, ...client }).strict(),
    link_logical_workspace_project: z.object({ logicalWorkspaceId: z.string().uuid(), ...project, ...client }).strict(),
    unlink_logical_workspace_project: z.object({ logicalWorkspaceId: z.string().uuid(), ...project, ...client }).strict(),
    list_project_workspaces: z.object({ ...project, includeArchived: z.boolean().optional() }).strict(),
    get_workspace: z.object({ ...scope, includeArchived: z.boolean().optional() }).strict(),
    create_workspace: z.object({ projectId: z.string().uuid().optional(), ...client, name, rootPath: file, nodeId: z.string().uuid().optional(), kind: z.enum(['generic', 'unity']).default('generic') }).strict(),
    link_workspace_project: z.object({ ...project, workspaceId: z.string().uuid(), ...client }).strict(),
    unlink_workspace_project: z.object({ ...project, workspaceId: z.string().uuid(), ...client }).strict(),
    update_workspace: z.object({ ...scope, ...client, name: name.optional() }).strict(),
    archive_workspace: z.object({ ...scope, ...client }).strict(),
    ...publicWorkspaceOperations,
    workspace_git_push_branch: workspaceOperationSchemas.workspace_git_push_branch.omit({ githubToken: true }).strict(),
    workspace_git_clone_repository: workspaceOperationSchemas.workspace_git_clone_repository.omit({ githubToken: true }).strict(),
    workspace_git_remove_worktree: workspaceOperationSchemas.workspace_git_remove_worktree.omit({ targetPath: true, expectedBranch: true }).strict(),
    workspace_git_open_pull_request: z.object({ ...scope, ...client,
        repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
        branch: z.string().regex(/^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/),
        expectedHead: z.string().regex(/^[a-f0-9]{40}$/),
        title: z.string().trim().min(5).max(120), body: z.string().max(8000).optional(),
    }).strict(),
    football_train: workspaceOperationSchemas.football_control.omit({ action: true }).extend({ drill: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/) }).strict(),
    football_evaluate: workspaceOperationSchemas.football_control.omit({ action: true }).extend({ policyId: z.string().regex(/^policy_[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/) }).strict(),
    football_training_status: workspaceOperationSchemas.football_control.omit({ action: true }).strict(),
    football_evaluation_status: workspaceOperationSchemas.football_control.omit({ action: true }).extend({ runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/) }).strict(),
    football_stop: workspaceOperationSchemas.football_control.omit({ action: true }).extend({ runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/) }).strict(),

};
export type WorkspaceToolName = keyof typeof workspaceSchemas;
export const workspaceDescriptions: Record<WorkspaceToolName, string> = {
    list_github_repositories: 'Discover the repositories and accounts available to the installed GitHub App.',
    list_workspaces: 'List checkout bindings across Nodes (legacy Workspace operations).',
    list_logical_workspaces: 'List node-independent logical Workspaces and their associated checkout bindings.',
    attach_checkout_repository: 'Attach one registered checkout to a logical repository Workspace, after verifying its Git origin on its Node.',
    link_logical_workspace_project: 'Associate a Project with every checkout in a logical Workspace, independent of Node placement.',
    unlink_logical_workspace_project: 'Remove a logical Workspace–Project association without deleting any checkouts.',
    list_project_workspaces: 'List Workspaces associated with a Project; Project association is optional.',
    get_workspace: 'Get a Workspace by stable ID, optionally verifying its Project association.',
    create_workspace: 'Register an existing directory on a Node; Project association is optional.',
    link_workspace_project: 'Associate an existing Workspace with a Project without moving its files.',
    unlink_workspace_project: 'Remove a Workspace–Project association without removing the Workspace.',
    update_workspace: 'Rename a workspace. To change its root or adapter, archive it and register a new workspace.',
    archive_workspace: 'Detach a workspace without deleting its files.',
    workspace_list_files: 'List a bounded, sorted tree excluding symlinks, secrets and generated directories.',
    workspace_read_file: 'Read UTF-8 text up to 512 KiB and its SHA-256 for conflict-safe edits.',
    workspace_search_files: 'Bounded deterministic case-sensitive literal search; reports truncation and skipped files.',
    workspace_create_file: 'Create a new text file exclusively; parent directory must exist.',
    workspace_patch_file: 'Replace exactly one oldText match, requiring the SHA-256 from a recent read.',
    workspace_delete_file: 'Delete one text file only if expectedSha256 matches; no recursive deletion.',
    workspace_list_dev_tasks: 'List named development tasks configured by the Workspace owner; no commands can be supplied by a caller.',
    workspace_run_dev_task: 'Run one owner-configured development task on the Workspace Node, with bounded time/output and a structured result. No arbitrary shell.',
    workspace_git_status: 'Read Git branch and bounded changed-file summary; no Git writes.',
    workspace_git_diff: 'Read staged and unstaged diffs for safe current text files. Removed/protected files are omitted.',
    workspace_git_clone_repository: 'Clone one GitHub App-authorised repository into an empty child of a trusted Node development root and register an independent Workspace.',
    workspace_git_list_worktrees: 'List Git worktrees reachable from this registered checkout within the approved Node filesystem roots.',
    workspace_git_create_worktree: 'Create a new isolated atlas/* worktree inside an explicitly trusted Node Git directory and register it as an independent Workspace.',
    workspace_git_remove_worktree: 'Remove an explicitly selected, clean registered feature worktree while retaining its Git branch and commits.',
    workspace_git_create_branch: 'Create an atlas/* branch only on an explicitly approved Git workspace.',
    workspace_git_switch_branch: 'Switch an approved local atlas/* branch with a clean working tree.',
    workspace_git_stage: 'Stage only explicitly named regular files whose SHA-256 matches the inspection.',
    workspace_git_commit: 'Commit exactly the staged files after checking Git tree identity.',
    workspace_git_push_branch: 'Publish an approved atlas/* branch to an allowlisted GitHub repository using a short-lived server-brokered token; no force push.',
    workspace_git_open_pull_request: 'Open a draft GitHub PR for the expected remote branch head; no merges.',
    football_train: 'Request headless football training on the bound AI Football Mac. Returns an asynchronous receipt.',
    football_evaluate: 'Request seeded policy inference evaluation on the bound AI Football Mac. Returns an asynchronous receipt.',
    football_training_status: 'List training runs in the bound AI Football workspace.',
    football_evaluation_status: 'Poll the asynchronous status of a football evaluation request.',
    football_stop: 'Request a graceful stop of one verified football training run.',
    unity_status: 'Check optional Unity CLI and project-scoped Editor/Pipeline connectivity.',
    unity_list_commands: 'Discover this Editor’s MCP commands and schemas, with local approval flags.',
    unity_run_command: 'Invoke a discovered, locally approved Unity command with structured parameters. No shell or evaluation escape.',
};
