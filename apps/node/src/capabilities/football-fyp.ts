import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AtlasError } from '@atlas/protocol/errors';
import type { Workspace } from '@atlas/protocol/workspace';
import { workspaceOperationSchemas } from '@atlas/protocol/workspace-operations';

type Input = ReturnType<typeof workspaceOperationSchemas.football_control.parse>;
const execFileAsync = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'LOGNAME']
        .filter(name => process.env[name] !== undefined)
        .map(name => [name, process.env[name]]),
);

function safeSource(workspace: Workspace, relative: string) {
    const root = realpathSync(workspace.rootPath);
    const source = path.join(root, relative);
    const resolved = realpathSync(source);
    if (!resolved.startsWith(root + path.sep) || lstatSync(source).isSymbolicLink() ||
        !statSync(resolved).isFile())
        throw new AtlasError('FYP file is not a regular source in its Unity checkout.', 'DRIVER_UNAVAILABLE');
    return resolved;
}

/** Separate, fail-closed ABI. Never interprets a legacy 54/5 or 54/7 policy as FootballV1. */
export function fypManifest(workspace: Workspace) {
    if (workspace.kind !== 'unity' || workspace.status !== 'active' || workspace.name !== 'FYP')
        throw new AtlasError('FYP requires its own registered, active Unity checkout.', 'WORKSPACE_UNAVAILABLE');
    let data: any;
    try {
        const file = safeSource(workspace, 'Training/atlas_contract.json');
        if (statSync(file).size > 32 * 1024) throw new Error('Oversized contract');
        data = JSON.parse(readFileSync(file, 'utf8'));
        if (data.contract_id !== 'fyp-football-v1' || data.behavior !== 'FootballV1' ||
            data.observations?.size !== 25 || data.actions?.continuous !== 8 ||
            data.trainer_kind !== 'poca' || data.source_project !== 'affank1020/FYP' ||
            data.scene !== 'Assets/Football/Scenes/OpenGoalClose.unity')
            throw new Error('Unsupported FYP ABI');
        const prefab = readFileSync(safeSource(workspace, 'Assets/Football/Prefabs/Player.prefab'), 'utf8');
        if (!['VectorObservationSize: 25','m_NumContinuousActions: 8','m_BehaviorName: FootballV1']
            .every(token => prefab.includes(token)))
            throw new Error('FYP prefab has a different observation/action ABI');
        safeSource(workspace, 'Training/football_v1.yaml');
        safeSource(workspace, data.scene);
    } catch (error) {
        if (error instanceof AtlasError) throw error;
        throw new AtlasError('FYP manifest or prefab is missing or incompatible.', 'DRIVER_UNAVAILABLE');
    }
    return { available: true, contract: data,
        provenance: 'source-tree-only; not Unity build, runner, or policy verification' };
}

function bridge(workspace: Workspace) {
    fypManifest(workspace);
    return safeSource(workspace, 'Training/atlas_fyp.py');
}

async function python(workspace: Workspace, argv: string[]): Promise<any> {
    const file = bridge(workspace);
    const { stdout } = await execFileAsync('python3', [file, ...argv], {
        cwd: workspace.rootPath, env: cleanEnv(), shell: false,
        maxBuffer: 512 * 1024, timeout: 90_000,
    });
    try { return JSON.parse(stdout); }
    catch { throw new AtlasError('FYP driver returned invalid JSON.', 'DRIVER_UNAVAILABLE'); }
}

function operationsDir(workspace: Workspace) {
    const root = realpathSync(workspace.rootPath);
    const state = path.join(root, '.atlas-fyp');
    if (existsSync(state) && (lstatSync(state).isSymbolicLink() ||
        realpathSync(state) !== state))
        throw new AtlasError('Unsafe FYP state directory.', 'INVALID_ARGUMENT');
    const directory = path.join(state, 'operations');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory)
        throw new AtlasError('Unsafe FYP operations directory.', 'INVALID_ARGUMENT');
    return directory;
}

function launch(workspace: Workspace, action: 'fyp_build' | 'fyp_train' | 'fyp_evaluate', argv: string[], runId?: string) {
    const file = bridge(workspace);
    const directory = operationsDir(workspace);
    const ticket = randomUUID();
    const outFile = path.join(directory, ticket + '.out');
    const errFile = path.join(directory, ticket + '.err');
    const out = openSync(outFile, 'wx', 0o600);
    const err = openSync(errFile, 'wx', 0o600);
    let pid: number | undefined;
    try {
        const child = spawn('python3', [file, ...argv], {
            cwd: workspace.rootPath, env: cleanEnv(), detached: true,
            shell: false, stdio: ['ignore', out, err],
        });
        child.on('error', error => {
            try { writeFileSync(errFile, String(error.message).slice(0, 1000)); } catch {}
        });
        pid = child.pid;
        if (!pid) throw new AtlasError('Unable to launch FYP driver.', 'DRIVER_UNAVAILABLE');
        child.unref();
    } finally { closeSync(out); closeSync(err); }
    writeFileSync(path.join(directory, ticket + '.json'),
        JSON.stringify({ ticket, action, run_id: runId ?? null, pid, started_at: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600 });
    return { accepted: true, ticket, run_id: runId ?? null, action, status: 'launching',
        note: 'Accepted locally; inspect FYP run or operation status. This does not prove training or build success.' };
}

function safeReceiptText(file: string): string {
    if (!existsSync(file)) return '';
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024)
        throw new AtlasError('Unsafe or oversized FYP operation receipt.', 'INVALID_ARGUMENT');
    return readFileSync(file, 'utf8');
}

function taskStatus(workspace: Workspace, id: string) {
    if (!UUID.test(id)) throw new AtlasError('Invalid FYP ticket.', 'INVALID_ARGUMENT');
    const dir = operationsDir(workspace);
    const base = path.join(dir, id);
    if (!existsSync(base + '.json')) throw new AtlasError('FYP ticket not found.', 'NOT_FOUND');
    const info = JSON.parse(safeReceiptText(base + '.json'));
    if (info.ticket !== id || !['fyp_build','fyp_train','fyp_evaluate'].includes(info.action))
        throw new AtlasError('Invalid FYP operation receipt.', 'INVALID_ARGUMENT');
    const output = safeReceiptText(base + '.out').slice(-4000);
    const error = safeReceiptText(base + '.err').slice(-4000);
    let result: any = null;
    try { result = JSON.parse(output.trim().split('\n').at(-1) ?? ''); } catch {}
    let alive = false;
    if (Number.isInteger(info.pid) && info.pid > 1) {
        try { process.kill(info.pid, 0); alive = true; } catch {}
    }
    return { ticket: id, action: info.action, run_id: info.run_id, result,
        status: result?.state === 'failed' ? 'failed' :
            result?.completed === true || result?.state === 'completed' ? 'completed' :
            alive ? 'running' : 'failed_or_unknown',
        output, error, note: result ? 'Completed command; assess resulting artifacts separately.' :
            'No completion receipt. Process status alone does not establish success.' };
}

export async function fypOperation(workspace: Workspace, x: Input): Promise<unknown> {
    if (x.action === 'fyp_manifest') return fypManifest(workspace);
    if (x.action === 'fyp_preflight') return python(workspace, ['preflight', ...(x.environmentId ? ['--environment-id', x.environmentId] : [])]);
    if (x.action === 'fyp_runs') return python(workspace, ['runs']);
    if (x.action === 'fyp_evaluations') return python(workspace, ['evaluations']);
    if (x.action === 'fyp_environments') return python(workspace, ['environments']);
    if (x.action === 'fyp_status') {
        if (!x.runId || !/^fyp-[a-f0-9-]{36}$/.test(x.runId))
            throw new AtlasError('Valid FYP run ID required.', 'INVALID_ARGUMENT');
        return python(workspace, ['status', '--run-id', x.runId]);
    }
    if (x.action === 'fyp_task_status') {
        if (!x.runId) throw new AtlasError('FYP task ticket required.', 'INVALID_ARGUMENT');
        return taskStatus(workspace, x.runId);
    }
    if (x.action === 'fyp_build') return launch(workspace, 'fyp_build', ['build']);
    if (x.action === 'fyp_train') {
        if (!['smoke','pilot_50k'].includes(x.preset ?? '') || x.seed === undefined)
            throw new AtlasError('FYP training requires an approved preset and seed.', 'INVALID_ARGUMENT');
        const readiness = await python(workspace, ['preflight', ...(x.environmentId ? ['--environment-id', x.environmentId] : [])]);
        if (readiness?.ready_to_train !== true)
            throw new AtlasError('FYP preflight failed: configure the trainer and open the selected catalogued FootballV1 environment in Edit Mode. Atlas will start the learner; then press Play to connect.', 'DRIVER_UNAVAILABLE');
        const runId = 'fyp-' + randomUUID();
        return launch(workspace, 'fyp_train',
            ['train', '--run-id', runId, '--preset', x.preset!,
                '--seed', String(x.seed), ...(x.environmentId ? ['--environment-id', x.environmentId] : [])], runId);
    }
    if (x.action === 'fyp_evaluate') {
        if (!x.runId || !/^fyp-[a-f0-9-]{36}$/.test(x.runId) ||
            x.episodes === undefined || x.episodes < 1 || x.episodes > 100 || x.seed === undefined)
            throw new AtlasError('FYP evaluation requires a completed run ID, 1–100 episodes and seed.', 'INVALID_ARGUMENT');
        const readiness = await python(workspace, ['preflight', ...(x.environmentId ? ['--environment-id', x.environmentId] : [])]);
        if (readiness?.ready_to_train !== true)
            throw new AtlasError('FYP preflight failed: open the selected catalogued environment in Unity Edit Mode; stop Play Mode before requesting evaluation.', 'DRIVER_UNAVAILABLE');
        const evaluationId = 'fyp-eval-' + randomUUID();
        return launch(workspace, 'fyp_evaluate',
            ['evaluate', '--evaluation-id', evaluationId, '--run-id', x.runId,
                '--episodes', String(x.episodes), '--seed', String(x.seed), ...(x.environmentId ? ['--environment-id', x.environmentId] : [])], x.runId);
    }
    throw new AtlasError('Unsupported FYP operation.', 'INVALID_ARGUMENT');
}
