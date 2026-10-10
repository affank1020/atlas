import { z } from 'zod';
import { workspaceOperationSchemas } from '@atlas/protocol/workspace-operations';
const project = { projectId: z.string().uuid() };
const scope = { ...project, workspaceId: z.string().uuid() };
const client = { client: z.string().trim().min(1).max(200).optional() };
const name = z.string().trim().min(1).max(200);
const file = z.string().min(1).max(4096);
const directory = z.string().max(4096).default('');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(512 * 1024);
// The Football Application's internal Node operation must not become a generic
// Workspace tool exposed through MCP or the unscoped HTTP dispatcher.
const { football_control: _footballControl, ...publicWorkspaceOperations } = workspaceOperationSchemas;
export const workspaceSchemas = {
    list_project_workspaces: z.object({ ...project, includeArchived: z.boolean().optional() }).strict(),
    get_workspace: z.object({ ...scope, includeArchived: z.boolean().optional() }).strict(),
    create_workspace: z.object({ ...project, ...client, name, rootPath: file, nodeId: z.string().uuid().optional(), kind: z.enum(['generic', 'unity']).default('generic') }).strict(),
    update_workspace: z.object({ ...scope, ...client, name: name.optional() }).strict(),
    archive_workspace: z.object({ ...scope, ...client }).strict(),
    ...publicWorkspaceOperations,
    football_train: workspaceOperationSchemas.football_control.omit({ action: true }).extend({ drill: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/) }).strict(),
    football_evaluate: workspaceOperationSchemas.football_control.omit({ action: true }).extend({ policyId: z.string().regex(/^policy_[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/) }).strict(),
    football_training_status: workspaceOperationSchemas.football_control.omit({ action: true }).strict(),
    football_evaluation_status: workspaceOperationSchemas.football_control.omit({ action: true }).extend({ runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/) }).strict(),
    football_stop: workspaceOperationSchemas.football_control.omit({ action: true }).extend({ runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/) }).strict(),

};
export type WorkspaceToolName = keyof typeof workspaceSchemas;
export const workspaceDescriptions: Record<WorkspaceToolName, string> = {
    list_project_workspaces: 'List a project’s local workspaces; files remain on disk.',
    get_workspace: 'Get workspace configuration by project and stable workspace ID.',
    create_workspace: 'Bind an existing directory beneath ATLAS_WORKSPACE_ROOTS. One active workspace per project.',
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
    football_train: 'Request headless football training on the bound AI Football Mac. Returns an asynchronous receipt.',
    football_evaluate: 'Request seeded policy inference evaluation on the bound AI Football Mac. Returns an asynchronous receipt.',
    football_training_status: 'List training runs in the bound AI Football workspace.',
    football_evaluation_status: 'Poll the asynchronous status of a football evaluation request.',
    football_stop: 'Request a graceful stop of one verified football training run.',
    unity_status: 'Check optional Unity CLI and project-scoped Editor/Pipeline connectivity.',
    unity_list_commands: 'Discover this Editor’s MCP commands and schemas, with local approval flags.',
    unity_run_command: 'Invoke a discovered, locally approved Unity command with structured parameters. No shell or evaluation escape.',
};
