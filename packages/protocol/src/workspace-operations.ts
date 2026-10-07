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
};
export type WorkspaceOperation = keyof typeof workspaceOperationSchemas;
