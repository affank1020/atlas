import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AtlasError } from '@atlas/protocol/errors';
import { workspaceOperationSchemas } from '@atlas/protocol/workspace-operations';
import type { Workspace } from '@atlas/protocol/workspace';

const execFileAsync = promisify(execFile);
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const cleanEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SYSTEMROOT']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return env;
};
type Input = ReturnType<typeof workspaceOperationSchemas.football_control.parse>;
const boundedText = (value: string) => value.slice(-64 * 1024);
const publicJob = (j: any) => ({
    id: j.id, drill: j.drill, preset: j.preset, state: j.state,
    mode: j.mode, arenas: j.arenas, base_port: j.base_port, seed: j.seed,
    behavior: j.behavior, started_at: j.started_at, source_scene: j.source_scene,
    config_sha256: j.config_sha256,
});
function driverPath(workspace: Workspace) {
    if (workspace.kind !== 'unity' || workspace.status !== 'active')
        throw new AtlasError('Football training requires an active Unity Workspace.', 'WORKSPACE_UNAVAILABLE');
    const script = path.join(workspace.rootPath, 'football_driver.py');
    if (!existsSync(script) || lstatSync(script).isSymbolicLink() || !lstatSync(script).isFile() ||
        !realpathSync(script).startsWith(realpathSync(workspace.rootPath) + path.sep))
        throw new AtlasError('The bound Workspace does not contain a safe football_driver.py.', 'DRIVER_UNAVAILABLE');
    return script;
}
const argsFor = (x: Input): string[] => {
    switch (x.action) {
        case 'drills': return ['drills'];
        case 'jobs': return ['training-jobs'];
        case 'job_logs': return ['job-logs', '--run-id', x.runId!, '--lines', String(x.lines ?? 60)];
        case 'policies': return ['policies'];
        case 'evaluations': return ['evaluation-results'];
        case 'viewer_sessions': return ['viewer-sessions'];
        case 'watch_policy': return ['watch', '--policy', x.policyId!, '--arenas', String(x.arenas ?? 1), '--seed', String(x.seed ?? 42)];
        case 'watch_live': return ['watch-live', '--run', x.runId!];
        case 'evaluate': return ['evaluate', '--policy', x.policyId!, '--episodes', String(x.episodes ?? 100), '--seed', String(x.seed ?? 123)];
        case 'index_policy': return ['policies', '--index-run', x.runId!];
        case 'stop_job': return ['stop-job', '--run-id', x.runId!];
        case 'evaluation_plan': return ['evaluate', '--policy', x.policyId!, '--episodes', String(x.episodes ?? 100), '--seed', String(x.seed ?? 42), '--plan-only'];
        case 'launch_headless': return [
            'train-headless', '--drill', x.drill!, '--preset', x.preset ?? 'smoke', '--arenas', String(x.arenas ?? 1),
            '--base-port', String(x.basePort ?? 5005), '--seed', String(x.seed ?? 42),
        ];
        default: throw new AtlasError('Unsupported football driver operation.', 'INVALID_ARGUMENT');
    }
};
function validateAction(x: Input) {
    if (['job_logs', 'stop_job', 'index_policy', 'watch_live', 'viewer_launch_status'].includes(x.action) && !x.runId)
        throw new AtlasError('A run ID is required.', 'INVALID_ARGUMENT');
    if (x.action === 'launch_headless' && !x.drill)
        throw new AtlasError('A drill is required.', 'INVALID_ARGUMENT');
    if (['evaluation_plan', 'evaluate', 'watch_policy'].includes(x.action) && !x.policyId)
        throw new AtlasError('A policy ID is required.', 'INVALID_ARGUMENT');
}
function launchesDir(workspace: Workspace) { return path.join(workspace.rootPath, 'training-driver-runs', 'atlas-launches'); }
function evalDir(workspace: Workspace) { return path.join(workspace.rootPath, 'training-driver-runs', 'atlas-evaluation-launches'); }
function viewerDir(workspace: Workspace) { return path.join(workspace.rootPath, 'training-driver-runs', 'atlas-viewer-launches'); }
function launchStatus(workspace: Workspace, ticket: string, type: 'training' | 'evaluation' | 'viewer' = 'training') {
    if (!RUN_ID.test(ticket)) throw new AtlasError('Invalid launch ticket.', 'INVALID_ARGUMENT');
    const directory = type === 'evaluation' ? evalDir(workspace) : type === 'viewer' ? viewerDir(workspace) : launchesDir(workspace);
    const file = path.join(directory, ticket + '.json');
    if (!existsSync(file)) throw new AtlasError('Launch receipt not found.', 'NOT_FOUND');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    const stdout = existsSync(path.join(directory, ticket + '.out')) ? boundedText(readFileSync(path.join(directory, ticket + '.out'), 'utf8')) : '';
    const stderr = existsSync(path.join(directory, ticket + '.err')) ? boundedText(readFileSync(path.join(directory, ticket + '.err'), 'utf8')) : '';
    let run: unknown;
    try { run = JSON.parse(stdout); } catch {
        const boundary = stdout.lastIndexOf('\n{');
        if (boundary >= 0) { try { run = JSON.parse(stdout.slice(boundary + 1)); } catch {} }
    }
    let alive = false;
    try { process.kill(receipt.pid, 0); alive = true; } catch {}
    return { ticket, state: run ? (type === 'training' ? 'submitted' : 'completed') : alive ? 'launching' : 'stopped_or_failed',
        startedAt: receipt.startedAt, drill: receipt.drill, run,
        output: stdout.slice(-5000), error: stderr.slice(-5000),
        note: run ? (type === 'viewer' ? 'Viewer launched on the connected Mac. Check viewer sessions for its process state.' : type === 'evaluation' ? 'Evaluation command completed. Refresh evaluations for measured results.' : 'Refresh training jobs for live trainer state.') : 'The command has not completed. Check output and error if it stops.' };
}
/**
 * Fixed-contract driver bridge, running only on the Node hosting the Unity Workspace.
 * Never accepts paths, arbitrary commands, environment variables or shell strings.
 */
export async function footballControl(workspace: Workspace, raw: unknown): Promise<unknown> {
    const x = workspaceOperationSchemas.football_control.parse(raw);
    validateAction(x);
    const script = driverPath(workspace);
    if (x.action === 'launch_status') return launchStatus(workspace, x.runId!);
    if (x.action === 'evaluation_status') return launchStatus(workspace, x.runId!, 'evaluation');
    if (x.action === 'viewer_launch_status') return launchStatus(workspace, x.runId!, 'viewer');
    if (['launch_headless', 'evaluate', 'watch_policy', 'watch_live'].includes(x.action)) {
        const directory = x.action === 'evaluate' ? evalDir(workspace) : ['watch_policy', 'watch_live'].includes(x.action) ? viewerDir(workspace) : launchesDir(workspace);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const ticket = randomUUID();
        const outfile = openSync(path.join(directory, ticket + '.out'), 'wx', 0o600);
        const errfile = openSync(path.join(directory, ticket + '.err'), 'wx', 0o600);
        let pid: number | undefined;
        try {
            const child = spawn('python3', [script, ...argsFor(x)], {
                cwd: workspace.rootPath, env: cleanEnv(), shell: false, detached: true, stdio: ['ignore', outfile, errfile],
            });
            // A startup error happens asynchronously and is written to the receipt log.
            child.on('error', error => {
                try { writeFileSync(path.join(directory, ticket + '.err'), String(error.message).slice(0, 1000)); } catch {}
            });
            if (!child.pid) throw new AtlasError('Unable to start the local Python driver.', 'DRIVER_UNAVAILABLE');
            child.unref();
            pid = child.pid;
        } finally { closeSync(outfile); closeSync(errfile); }
        writeFileSync(path.join(directory, ticket + '.json'),
            JSON.stringify({ ticket, pid, drill: x.drill, policyId: x.policyId, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
        return { accepted: true, ticket, drill: x.drill, policyId: x.policyId, status: 'launching',
            note: x.action === 'evaluate' ? 'Evaluation requested; poll the receipt until Unity finishes.' : ['watch_policy', 'watch_live'].includes(x.action) ? 'Viewer launch requested on the connected Mac. Check the receipt and viewer sessions.' : 'Training launch requested; poll its receipt and training jobs.' };
    }
    try {
        const { stdout } = await execFileAsync('python3', [script, ...argsFor(x)], {
            cwd: workspace.rootPath, env: cleanEnv(), shell: false, encoding: 'utf8', maxBuffer: 512 * 1024,
            timeout: x.action === 'index_policy' ? 50_000 : 25_000,
        });
        if (x.action === 'job_logs') return { runId: x.runId, text: boundedText(stdout) };
        const parsed = JSON.parse(stdout);
        if (x.action === 'jobs') return Array.isArray(parsed) ? parsed.map(publicJob) : [];
        if (x.action === 'viewer_sessions') return Array.isArray(parsed) ? parsed.map((item: any) => ({ id: item.id, mode: item.mode ?? 'policy', policy_id: item.policy_id, source_run_id: item.source_run_id, checkpoint_step: item.checkpoint_step, drill: item.drill, arenas: item.arenas, started_at: item.started_at, state: item.state })) : [];
        if (x.action === 'policies') return Array.isArray(parsed) ? parsed.map(p => ({
            id: p.id, source_run_id: p.source_run_id, drill: p.drill, behavior: p.behavior,
            role: p.role, indexed_at: p.indexed_at, evaluation: p.evaluation,
            artifacts: Array.isArray(p.artifacts) ? p.artifacts.map((a: any) => ({ path: a.path, final: a.final, size_bytes: a.size_bytes })) : [],
        })) : [];
        return parsed;
    } catch (error: any) {
        const detail = (error?.stderr || error?.message || 'Driver operation failed.').toString();
        throw new AtlasError(boundedText(detail).slice(-500), 'FOOTBALL_DRIVER_ERROR');
    }
}
