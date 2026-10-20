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
    workspace_git_create_branch: z.object({ ...scope, ...client, branch: z.string().regex(/^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/) }).strict(),
    workspace_git_switch_branch: z.object({ ...scope, ...client, branch: z.string().regex(/^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/) }).strict(),
    workspace_git_stage: z.object({ ...scope, ...client, files: z.array(z.object({ path: file, expectedSha256: sha256 }).strict()).min(1).max(40) }).strict(),
    workspace_git_commit: z.object({ ...scope, ...client, branch: z.string().regex(/^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/), expectedTree: z.string().regex(/^[a-f0-9]{40}$/), files: z.array(file).min(1).max(40), message: z.string().trim().min(3).max(200) }).strict(),
    // githubToken is injected by the Server after GitHub App authorization, never accepted from MCP.
    workspace_git_push_branch: z.object({ ...scope, ...client, repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/), branch: z.string().regex(/^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/), expectedHead: z.string().regex(/^[a-f0-9]{40}$/), githubToken: z.string().min(20).max(2048) }).strict(),

    unity_status: z.object({ ...scope, ...client }).strict(),
    unity_list_commands: z.object({ ...scope, ...client }).strict(),
    unity_run_command: z.object({ ...scope, ...client, command: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/), parameters: z.record(z.string(), z.unknown()).default({}).refine(x => JSON.stringify(x).length <= 65536, 'Parameters exceed 64 KiB') }).strict(),
    // Internal first-party football control: not published as a generic Workspace MCP tool.
    // Only the Football Training Application exposes carefully scoped typed actions.
    football_control: z.object({
        ...scope,
        action: z.enum(['generalist_manifest', 'generalist_runs', 'generalist_run_detail', 'generalist_evaluation_detail', 'generalist_policies', 'generalist_assessments', 'generalist_policy_update', 'generalist_activity', 'generalist_status', 'generalist_stop', 'generalist_package', 'generalist_train', 'generalist_evaluate', 'generalist_baseline', 'generalist_watch', 'prebuild_training', 'training_resources', 'recover_queue', 'resume_training', 'drills', 'jobs', 'job_logs', 'policies', 'index_policy', 'launch_headless', 'launch_status', 'stop_job', 'evaluation_plan', 'evaluate', 'evaluate_baseline', 'evaluation_status', 'evaluations', 'evaluation_detail', 'viewer_sessions', 'watch_policy', 'watch_live', 'viewer_launch_status', 'validation_status', 'validation_python', 'validation_editor', 'validation_physics']),
        scenario: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
        initializeFromRunId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
        drill: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
        runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
        policyId: z.string().regex(/^(?:policy_[A-Za-z0-9][A-Za-z0-9_-]{0,79}|generalist-[A-Za-z0-9_-]{1,70})$/).optional(),
        displayName: z.string().min(1).max(64).optional(),
        featured: z.boolean().optional(),
        evaluationId: z.string().regex(/^eval_[A-Za-z0-9_]{1,74}$/).optional(),
        baselineMode: z.enum(['zero', 'random', 'forward', 'scripted']).optional(),
        replayEpisode: z.number().int().min(0).max(10000).optional(),
        evaluationStage: z.union([z.literal(1), z.literal(2)]).optional(), // Cross-stage retention or zero-shot First Touch benchmark
        offset: z.number().int().min(0).max(10000).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        preset: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
        arenas: z.number().int().min(1).max(65535).optional(),
        basePort: z.number().int().min(1024).max(65535).optional(),
        seed: z.number().int().min(0).max(2147483647).optional(),
        episodes: z.number().int().min(1).max(10000).optional(),
        lines: z.number().int().min(1).max(200).optional(),
    }).strict(),

};
export type WorkspaceOperation = keyof typeof workspaceOperationSchemas;
