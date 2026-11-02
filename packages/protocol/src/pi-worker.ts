import { z } from 'zod';
/** Node-local contract only. Deliberately absent from WorkspaceOperation/MCP. */
export const piStartSchema = z.object({
    runId: z.string().uuid(), workspaceId: z.string().uuid(),
    expectedHead: z.string().regex(/^[a-f0-9]{40}$/),
    expectedBranch: z.string().regex(/^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/)
        .refine(x => !x.includes('//') && !x.endsWith('/')),
    prompt: z.string().min(1).max(16_384),
    permission: z.literal('read-only'),
    timeoutMs: z.number().int().min(100).max(600_000),
}).strict();
export type PiStart = z.infer<typeof piStartSchema>;
export type PiState = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'incomplete';
export type PiEvent = { cursor: number; at: string; type: string; data: Record<string, string | number | boolean | null> };
export type PiReceipt = {
    runId: string; workspaceId: string; nodeId: string; state: PiState;
    startedAt: string; finishedAt?: string; exitCode?: number | null; signal?: string | null;
    reason?: string; pid?: number; runtimeVersion: '1.5.0'; permission: 'read-only';
    head: string; branch: string; lastCursor: number;
};
/** A local operator grants this exact prompt/target/deadline once. Never caller supplied. */
export type PiApproval = {
    runId: string; workspaceId: string; rootPath: string; nodeId: string;
    head: string; branch: string; promptSha256: string; timeoutMs: number; expiresAt: string;
};
export interface PiWorkers {
    start(workspace: import('./workspace.js').Workspace, input: PiStart): Promise<PiReceipt>;
    get(workspace: import('./workspace.js').Workspace, runId: string): PiReceipt;
    events(workspace: import('./workspace.js').Workspace, runId: string, after?: number): {
        events: PiEvent[]; oldestCursor: number; lastCursor: number; truncated: boolean;
    };
    cancel(workspace: import('./workspace.js').Workspace, runId: string): PiReceipt;
    close(): Promise<void>;
}
