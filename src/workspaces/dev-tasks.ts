import { z } from 'zod';
/** Owner-managed process argv. Shell parsing and client-supplied command text are absent. */
export const devTaskSchema = z.object({
    executable: z.string().trim().min(1).max(256).refine(value => !/[\u0000-\u001f]/.test(value)),
    args: z.array(z.string().max(2048).refine(value => !value.includes('\u0000'))).max(32).default([]),
    passEnvironment: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(16).default([]),
    timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
}).strict();
export const devTasksSchema = z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), devTaskSchema).refine(tasks => Object.keys(tasks).length <= 16, 'At most 16 development tasks.');
export type DevTask = z.infer<typeof devTaskSchema>;
export type DevTasks = z.infer<typeof devTasksSchema>;
export interface DevTaskResult {
    workspaceId: string;
    nodeId: string;
    task: string;
    command: string;
    success: boolean;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    startedAt: string;
    completedAt: string;
    durationMs: number;
}
/** Display only; never used to reconstruct argv. */
export function displayCommand(task: DevTask) { return [task.executable, ...task.args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(' '); }
