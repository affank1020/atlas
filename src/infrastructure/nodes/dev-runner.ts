import { spawn } from 'node:child_process';
import type { Workspace } from '../../workspaces/model.js';
import { displayCommand, type DevTask, type DevTaskResult } from '../../workspaces/dev-tasks.js';
const OUTPUT_LIMIT = 128 * 1024;
/** Keep the tail so the last compiler/test failure survives a large output stream. */
function boundedOutput() {
    let value = Buffer.alloc(0); let truncated = false;
    return {
        add(chunk: Buffer) {
            if (chunk.length + value.length > OUTPUT_LIMIT) truncated = true;
            value = Buffer.concat([value, chunk]).subarray(-OUTPUT_LIMIT);
        },
        finish() { return { text: value.toString('utf8'), truncated }; },
    };
}
function taskEnvironment(task: DevTask): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { CI: '1' };
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SystemRoot', 'WINDIR']) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    for (const name of task.passEnvironment) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    return env;
}
export function runDevTask(workspace: Workspace, taskName: string, task: DevTask): Promise<DevTaskResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    return new Promise(resolve => {
        const stdout = boundedOutput(); const stderr = boundedOutput();
        let timedOut = false; let finished = false;
        const child = spawn(task.executable, task.args, {
            cwd: workspace.rootPath, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true, detached: process.platform !== 'win32',
            env: taskEnvironment(task),
        });
        child.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk));
        const stop = () => {
            if (finished) return;
            timedOut = true;
            // POSIX process group also stops npm's child test/build processes.
            try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
        };
        const timer = setTimeout(stop, task.timeoutMs);
        let launchError: string | undefined;
        child.on('error', error => { launchError = error.message; });
        child.on('close', (exitCode, signal) => {
            finished = true; clearTimeout(timer);
            if (launchError) stderr.add(Buffer.from(launchError));
            const completed = Date.now(); const out = stdout.finish(); const err = stderr.finish();
            resolve({ workspaceId: workspace.id, nodeId: workspace.nodeId, task: taskName, command: displayCommand(task),
                success: !timedOut && !launchError && exitCode === 0, exitCode, signal, timedOut,
                stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated, stderrTruncated: err.truncated,
                startedAt, completedAt: new Date(completed).toISOString(), durationMs: completed - started });
        });
    });
}
