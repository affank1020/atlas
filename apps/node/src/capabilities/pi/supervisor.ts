import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { AtlasError } from '@atlas/protocol/errors';
import { piStartSchema, type PiApproval, type PiEvent, type PiReceipt, type PiWorkers } from '@atlas/protocol/pi-worker';
import type { Workspace } from '@atlas/protocol/workspace';
import { WorkspaceFiles } from '../workspace-files/files.js';
import { verifyManagedAgentWorktree } from '../workspace-files/git-managed.js';

const worker = fileURLToPath(new URL('../../../pi-runtime/worker.mjs', import.meta.url));
const MAX_EVENTS = 256;
const MAX_BYTES = 1024 * 1024;
const frameSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready'), version: z.literal('1.5.0') }).strict(),
    z.object({ type: z.enum(['agent_start', 'agent_end', 'agent_settled', 'worker_error']) }).strict(),
    z.object({ type: z.literal('tool_execution_start'), tool: z.literal('read') }).strict(),
    z.object({ type: z.literal('tool_execution_end'), tool: z.literal('read'), isError: z.boolean() }).strict(),
    z.object({ type: z.literal('result'), ok: z.boolean() }).strict(),
]);
type Launch = (cwd: string) => ChildProcessWithoutNullStreams;
const launch: Launch = cwd => spawn(process.execPath, [worker], {
    cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: '/var/empty', LANG: 'en_US.UTF-8',
        PI_CODING_AGENT_DIR: '/var/empty', NO_COLOR: '1' },
});
type Run = {
    receipt: PiReceipt; root: string; events: PiEvent[];
    done: Promise<void>; resolve: () => void; stopping?: PiReceipt['state']; reason?: string; cancel?: () => void;
};
const terminal = (run: Run) => !!run.receipt.finishedAt;
const denied = () => new AtlasError('Pi run is not authorised for this checkout.', 'WORKSPACE_DENIED');

/** Node-local, operator-authorised feasibility worker. No remote execution entrypoint. */
export class PiWorkerSupervisor implements PiWorkers {
    private runs = new Map<string, Run>();
    private approvals: Map<string, PiApproval>;
    private busy = false;
    private get lockDirectory() { return this.dependencies.lockDirectory ?? path.join(tmpdir(), 'atlas-pi-worker-' + process.getuid?.() + '.lock'); }
    private closed = false;
    constructor(private nodeId: string, private files: WorkspaceFiles, approvals: PiApproval[],
        // Trusted host wiring/test seam; never deserialize these dependencies from a request.
        private dependencies: { launch?: Launch; platform?: NodeJS.Platform; lockDirectory?: string } = {}) {
        this.approvals = new Map(approvals.map(x => [x.runId, { ...x }]));
    }
    private emit(run: Run, type: string, data: PiEvent['data'] = {}) {
        run.events.push({ cursor: ++run.receipt.lastCursor, at: new Date().toISOString(), type, data });
        if (run.events.length > MAX_EVENTS) run.events.shift();
    }
    private scoped(workspace: Workspace, id: string) {
        const run = this.runs.get(id);
        if (!run || workspace.nodeId !== this.nodeId || workspace.id !== run.receipt.workspaceId ||
            workspace.rootPath !== run.root || workspace.status !== 'active') throw denied();
        return run;
    }
    get(workspace: Workspace, id: string) { return { ...this.scoped(workspace, id).receipt }; }
    events(workspace: Workspace, id: string, after = 0) {
        if (!Number.isSafeInteger(after) || after < 0) throw new AtlasError('Invalid event cursor.', 'INVALID_REQUEST');
        const run = this.scoped(workspace, id);
        const oldestCursor = run.events[0]?.cursor ?? 1;
        return { events: run.events.filter(x => x.cursor > after).map(x => ({ ...x, data: { ...x.data } })),
            oldestCursor, lastCursor: run.receipt.lastCursor, truncated: after < oldestCursor - 1 };
    }
    async start(workspace: Workspace, raw: unknown) {
        const input = piStartSchema.parse(raw);
        if ((this.dependencies.platform ?? process.platform) !== 'darwin')
            throw new AtlasError('Pi workers require macOS.', 'CAPABILITY_UNAVAILABLE');
        if (this.closed || this.busy || this.runs.size >= 64 || this.runs.has(input.runId))
            throw new AtlasError('Pi worker admission unavailable; runs are never replayed.', 'CONFLICT');
        this.busy = true; // Reserve before asynchronous filesystem checks.
        try {
            const grant = this.approvals.get(input.runId);
            if (!grant || workspace.status !== 'active' || workspace.nodeId !== this.nodeId ||
                input.workspaceId !== workspace.id || grant.workspaceId !== workspace.id ||
                grant.nodeId !== this.nodeId || grant.rootPath !== workspace.rootPath ||
                grant.head !== input.expectedHead || grant.branch !== input.expectedBranch ||
                grant.timeoutMs !== input.timeoutMs ||
                grant.promptSha256 !== createHash('sha256').update(input.prompt).digest('hex') ||
                !(Date.parse(grant.expiresAt) > Date.now())) throw denied();
            await verifyManagedAgentWorktree(workspace.rootPath, this.files, input.expectedHead, input.expectedBranch);
            if (this.closed || !(Date.parse(grant.expiresAt) > Date.now())) throw denied();
            // Cross-process admission. Never steal a stale lock after a crash or uncertain restart.
            try { await mkdir(this.lockDirectory, { mode: 0o700 }); }
            catch { throw new AtlasError('Pi worker lock unavailable; inspect any prior worker locally.', 'CONFLICT'); }
            if (this.closed) { await rmdir(this.lockDirectory); throw denied(); }
            this.approvals.delete(input.runId);
            let resolve!: () => void;
            const done = new Promise<void>(r => { resolve = r; });
            const run: Run = { root: workspace.rootPath, events: [], done, resolve,
                receipt: { runId: input.runId, workspaceId: workspace.id, nodeId: this.nodeId,
                    state: 'starting', startedAt: new Date().toISOString(), runtimeVersion: '1.5.0',
                    permission: 'read-only', head: input.expectedHead, branch: input.expectedBranch, lastCursor: 0 } };
            this.runs.set(input.runId, run);
            this.emit(run, 'starting');
            this.supervise(run, input.prompt, input.timeoutMs);
            return { ...run.receipt };
        } catch (error) { this.busy = false; throw error; }
    }
    private supervise(run: Run, prompt: string, timeoutMs: number) {
        let child: ChildProcessWithoutNullStreams;
        try { child = (this.dependencies.launch ?? launch)(run.root); }
        catch { void this.finish(run, 'failed', 'spawn_failed'); return; }
        run.receipt.pid = child.pid;
        let bytes = 0, buffer = '', ready = false, started = false, settled = false;
        let result: boolean | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = Date.now() + timeoutMs;
        const startupDeadline = Math.min(deadline, Date.now() + 30_000);
        const decoder = new StringDecoder('utf8');
        const signal = (name: NodeJS.Signals) => {
            if (child.pid) { try { process.kill(-child.pid, name); } catch { /* Already gone. */ } }
        };
        const stop = (state: PiReceipt['state'], reason: string) => {
            if (terminal(run) || run.stopping) return;
            run.stopping = state; run.reason = reason;
            this.emit(run, 'stopping', { reason });
            signal('SIGTERM');
            killTimer = setTimeout(() => signal('SIGKILL'), 1000);
        };
        const heartbeat = setInterval(() => {
            if (Date.now() >= deadline) stop('timed_out', 'deadline');
            else if (!ready && Date.now() >= startupDeadline) stop('failed', 'startup_timeout');
            else if (!run.stopping) this.emit(run, 'process_heartbeat');
        }, 1000);
        const timeout = setTimeout(() => stop('timed_out', 'deadline'), timeoutMs);
        run.cancel = () => stop('cancelled', 'operator_cancel');
        child.stdout.on('data', (chunk: Buffer) => {
            if (run.stopping) return;
            bytes += chunk.length;
            if (bytes > MAX_BYTES) return stop('failed', 'output_limit');
            buffer += decoder.write(chunk);
            let end: number;
            while ((end = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
                if (run.stopping) continue;
                if (Buffer.byteLength(line) > 32_768) { stop('failed', 'frame_limit'); continue; }
                try {
                    const frame = frameSchema.parse(JSON.parse(line));
                    if (frame.type === 'ready') {
                        if (ready || result !== undefined) throw new Error();
                        ready = true; run.receipt.state = 'running';
                    } else if (frame.type !== 'worker_error' && (!ready || result !== undefined)) throw new Error();
                    if (frame.type === 'agent_start') started = true;
                    if (frame.type === 'agent_settled') settled = true;
                    if (frame.type === 'result') {
                        if (!started || !settled) throw new Error();
                        result = frame.ok;
                    }
                    if (frame.type === 'worker_error') stop('failed', 'pi_error');
                    const { type, ...data } = frame;
                    this.emit(run, type, data);
                } catch { stop('failed', 'invalid_protocol'); }
            }
            if (Buffer.byteLength(buffer) > 32_768) stop('failed', 'frame_limit');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) stop('failed', 'output_limit');
            // Never retain raw diagnostics: they may contain secrets or provider response text.
        });
        child.stdin.on('error', () => stop('failed', 'stdin_failed'));
        child.on('error', () => stop('failed', 'spawn_failed'));
        child.on('close', (code, sig) => {
            clearInterval(heartbeat); clearTimeout(timeout); clearTimeout(killTimer);
            signal('SIGKILL'); // Clean unexpected descendants before reporting a terminal result.
            run.receipt.exitCode = code; run.receipt.signal = sig;
            const state = run.stopping ?? (buffer || decoder.end() ? 'failed'
                : result === true && code === 0 && !sig ? 'completed'
                : result === false ? 'failed' : 'incomplete');
            void this.finish(run, state, run.reason ?? (state === 'completed' ? 'pi_finished' : 'unexpected_exit_or_result'));
        });
        child.stdin.write(JSON.stringify({ prompt, modelId: 'qwen3-coder:30b' }) + '\n');
    }
    private async finish(run: Run, state: PiReceipt['state'], reason: string) {
        if (terminal(run)) return;
        try { await rmdir(this.lockDirectory); }
        catch { state = 'incomplete'; reason = 'lock_cleanup_failed'; }
        Object.assign(run.receipt, { state, reason, finishedAt: new Date().toISOString() });
        this.emit(run, 'terminal', { state, reason });
        this.busy = false;
        run.resolve();
    }
    cancel(workspace: Workspace, id: string) {
        const run = this.scoped(workspace, id);
        if (!terminal(run)) run.cancel?.();
        return { ...run.receipt }; // A submitted signal is not a terminal receipt.
    }
    async close() {
        this.closed = true;
        for (const run of this.runs.values()) if (!terminal(run)) run.cancel?.();
        await Promise.all([...this.runs.values()].map(x => x.done));
    }
}
