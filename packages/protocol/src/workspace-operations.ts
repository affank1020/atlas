import { z } from 'zod';
const scope = { projectId: z.string().uuid(), workspaceId: z.string().uuid() };
const client = { client: z.string().trim().min(1).max(200).optional() };
const file = z.string().min(1).max(4096);
const directory = z.string().max(4096).default('');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(512 * 1024);
export const workspaceOperationSchemas = {
    workspace_list_files: z.object({ ...scope, ...client, path: directory, depth: z.number().int().min(0).max(20).default(4), limit: z.number().int().min(1).max(2000).default(500) }).strict(),
    workspace_read_file: z.object({ ...scope, ...client, path: file }).strict(),
    workspace_search_files: z.object({ ...scope, ...client, path: directory, query: z.string().min(1).max(500), limit: z.number().int().min(1).max(200).default(100) }).strict(),
    workspace_create_file: z.object({ ...scope, ...client, path: file, text }).strict(),
    workspace_patch_file: z.object({ ...scope, ...client, path: file, expectedSha256: sha256, oldText: text.min(1), newText: text }).strict(),
    workspace_delete_file: z.object({ ...scope, ...client, path: file, expectedSha256: sha256 }).strict(),
    workspace_list_dev_tasks: z.object({ ...scope, ...client }).strict(),
    workspace_run_dev_task: z.object({ ...scope, ...client, task: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }).strict(),
    workspace_git_status: z.object({ ...scope, ...client }).strict(),
    workspace_git_diff: z.object({ ...scope, ...client }).strict(),
    unity_status: z.object({ ...scope, ...client }).strict(),
    unity_list_commands: z.object({ ...scope, ...client }).strict(),
    unity_run_command: z.object({ ...scope, ...client, command: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/), parameters: z.record(z.string(), z.unknown()).default({}).refine(x => JSON.stringify(x).length <= 65536, 'Parameters exceed 64 KiB') }).strict(),
    // Internal first-party football control: not published as a generic Workspace MCP tool.
    // Only the Football Training Application exposes carefully scoped typed actions.
    football_control: z.object({
        ...scope,
        action: z.enum(['drills', 'jobs', 'job_logs', 'policies', 'index_policy', 'launch_headless', 'launch_status', 'stop_job', 'evaluation_plan', 'evaluate', 'evaluation_status', 'evaluations', 'viewer_sessions', 'watch_policy', 'watch_live', 'viewer_launch_status']),
        drill: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
        runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
        policyId: z.string().regex(/^policy_[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
        preset: z.enum(['smoke', 'full', 'approach', 'first_touch', 'dribble']).optional(),
        arenas: z.number().int().min(1).max(16).optional(),
        basePort: z.number().int().min(1024).max(65519).optional(),
        seed: z.number().int().min(0).max(2147483647).optional(),
        episodes: z.number().int().min(1).max(10000).optional(),
        lines: z.number().int().min(1).max(200).optional(),
    }).strict(),

};
export type WorkspaceOperation = keyof typeof workspaceOperationSchemas;
