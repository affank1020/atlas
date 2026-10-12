import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Workspace, WorkspaceAdapter } from '@atlas/protocol/workspace';
import { AtlasError } from '@atlas/protocol/errors';

const exec = promisify(execFile);
const PHYSICS_TAG = '[M2PhysicsSmoke] PASS:';
const gateMenus = [
    { name: 'stage3', path: 'Football/Drills/Test Stage-3 Control Gate', pass: '[Stage3Gate] PASS:' },
    { name: 'shooting_v2', path: 'Football/Drills/Test Shooting v2 Gates', pass: '[ShootingV2Gate] PASSED' },
    { name: 'receiving_v2', path: 'Football/Drills/Test Receiving v2 Control Gate', pass: '[ReceivingV2Gate] PASS:' },
    { name: 'defending_v2', path: 'Football/Drills/Test Defending V2 Physical Gate', pass: '[DefendingV2Gate] PASS:' },
] as const;
type Evidence = { name: string; status: 'pass' | 'fail' | 'not_run'; detail?: string };
type Receipt = {
    id: string; layer: 'python' | 'editor' | 'physics'; status: 'pass' | 'fail';
    startedAt: string; completedAt: string; durationMs: number;
    sourceSha256: string; checks: Evidence[];
    summary: string; output: string; error?: string;
};
const active = new Set<string>();
const limited = (value: string) => value.slice(-24000);

function directory(workspace: Workspace) {
    return path.join(workspace.rootPath, 'training-driver-runs', 'atlas-validations');
}
function sourceFingerprint(workspace: Workspace) {
    // Include the source, the test definitions and the runner contracts.
    // The manifest is intentionally explicit; generated checkpoint/model output
    // and unrelated project assets must not influence the evidence key.
    const files = [
        'Assets/Scripts/Training/FootballBallControlAgent.cs',
        'Assets/Scripts/Training/FootballShootingAgent.cs',
        'Assets/Scripts/Training/FootballPhysicalIntegrationSmoke.cs',
        'Assets/Scripts/Training/FootballReceivingAgent.cs',
        'Assets/Scripts/Training/FootballSkillDrillAgent.cs',
        'Assets/Editor/FootballDribbleGateSelfTest.cs',
        'Assets/Editor/FootballShootingV2GateSelfTest.cs',
        'Assets/Editor/FootballReceivingV2GateSelfTest.cs',
        'Assets/Editor/FootballDefendingV2GateSelfTest.cs',
        'Assets/Scenes/MovementEvaluation.unity',
        'Assets/Scenes/BallControlDrill.unity',
        'Assets/Scenes/ShootingDrill.unity',
        'Assets/Scenes/PassingDrill.unity',
        'Assets/Scenes/ReceivingDrill.unity',
        'Assets/Scenes/DefendingDrill.unity',
        'Assets/Prefabs/FootballArena.prefab',
        'ml-agents/config/drills.json',
        'football_driver.py', 'football_training_contracts.py',
        'football_evaluation_diagnostics.py',
    ];
    const testRoot = path.join(workspace.rootPath, 'tests');
    if (existsSync(testRoot)) {
        files.push(...readdirSync(testRoot).filter(name => /^test_[A-Za-z0-9_]+\.py$/.test(name))
            .sort().map(name => 'tests/' + name));
    }
    const hash = createHash('sha256');
    for (const relative of files) {
        const absolute = path.join(workspace.rootPath, relative);
        hash.update(relative + '\0');
        if (existsSync(absolute)) {
            const stat = lstatSync(absolute);
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new AtlasError('Validation source must be a regular file within the bound workspace.', 'WORKSPACE_DENIED');
            hash.update(readFileSync(absolute));
        } else hash.update('MISSING');
        hash.update('\0');
    }
    return hash.digest('hex');
}
function save(workspace: Workspace, receipt: Receipt) {
    const dir = directory(workspace);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, receipt.id + '.json');
    const tmp = target + '.tmp';
    writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, target);
    return receipt;
}
function history(workspace: Workspace) {
    const dir = directory(workspace);
    if (!existsSync(dir)) return [] as Receipt[];
    return readdirSync(dir).filter(name => /^val_[0-9a-f-]{36}\.json$/.test(name)).flatMap(name => {
            try {
                const value = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Receipt;
                return value && ['python', 'editor', 'physics'].includes(value.layer) ? [value] : [];
            } catch { return []; }
        }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
}
function decode(value: unknown): any {
    if (value && typeof value === 'object' && Array.isArray((value as any).content)) {
        const part = (value as any).content.find((item: any) => item.type === 'text');
        if (part?.text) {
            try { return JSON.parse(part.text); } catch { return { message: part.text }; }
        }
    }
    return value;
}
async function call(unity: WorkspaceAdapter, workspace: Workspace, name: string, parameters = {}) {
    const result: any = await unity.invoke(workspace, name, parameters);
    if (result?.isError) throw new Error('Unity returned an Editor error for ' + name);
    return decode(result);
}
async function idle(unity: WorkspaceAdapter, workspace: Workspace) {
    const editor = await call(unity, workspace, 'editor_status') as any;
    if (editor.status !== 'ready' || editor.compiling || editor.domainReloadInProgress || editor.playMode !== 'stopped' || editor.projectPath !== workspace.rootPath)
        throw new Error('The correct Unity Editor must be idle, compiled and outside Play Mode.');
    const sceneState: any = await call(unity, workspace, 'list_open_scenes');
    const scenes = sceneState.scenes as { path: string; isDirty: boolean; isActive: boolean }[] | undefined;
    if (!Array.isArray(scenes) || !scenes.length || scenes.some(s => s.isDirty))
        throw new Error('Editor must have a loaded scene with no unsaved changes.');
    const compile: any = await call(unity, workspace, 'recompile_status');
    if (compile.compilationFailed || compile.failed || compile.status !== 'completed')
        throw new Error('Unity compile gate must be completed successfully before validation.');
    return scenes.map(s => ({ path: s.path, isActive: s.isActive }));
}
async function noTraining(workspace: Workspace) {
    const { stdout } = await exec('python3', ['football_driver.py', 'training-jobs'], {
        cwd: workspace.rootPath, timeout: 15000, maxBuffer: 256 * 1024,
    });
    const jobs = JSON.parse(stdout) as { state?: string; phase?: string }[];
    if (!Array.isArray(jobs)) throw new Error('Training status was not an array.');
    if (jobs.some(j => ['running', 'queued', 'starting', 'building', 'advancing', 'checkpointing'].includes(j.state ?? '') ||
        ['running', 'queued', 'starting', 'building', 'advancing', 'checkpointing'].includes(j.phase ?? '')))
        throw new Error('Validation requires all football training/build/queue jobs idle.');
}
async function runPython(workspace: Workspace) {
    // A fixed argv, no shell, and no caller-controlled path/command/environment.
    const { stdout, stderr } = await exec('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
        cwd: workspace.rootPath, timeout: 180000, maxBuffer: 256 * 1024,
        env: Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','USER','LOGNAME']
            .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    });
    return { stdout, stderr };
}
async function runEditor(workspace: Workspace, unity?: WorkspaceAdapter) {
    if (!unity) throw new Error('Unity Adapter unavailable for this Workspace.');
    const capabilities: any = await unity.capabilities(workspace);
    if (!capabilities.available || !capabilities.commands?.some((c: any) => c.name === 'menu' && c.approved))
        throw new Error('Unity menu execution is not approved by the Mac owner. Enable only the fixed football gate menu allowlist.');
    const sceneBefore = await idle(unity, workspace);
    await noTraining(workspace);
    const snapshot: any = await call(unity, workspace, 'console', { tail: 1 });
    let cursor = snapshot.cursor as number | undefined;
    let session = snapshot.session as string | undefined;
    const checks: Evidence[] = [];
    for (const gate of gateMenus) {
        await call(unity, workspace, 'menu', { path: gate.path });
        const output: any = await call(unity, workspace, 'console', {
            tail: 100, ...(cursor !== undefined && { since: cursor }),
            ...(session && { since_session: session }),
        });
        // Never accept historical PASS from an older session or cursor reset.
        const fresh = !output.reset && !output.dropped && Array.isArray(output.entries) ? output.entries : [];
        cursor = output.cursor; session = output.session;
        const pass = fresh.some((entry: any) => entry.level === 'log' && typeof entry.message === 'string' && entry.message.includes(gate.pass));
        const error = fresh.find((entry: any) => entry.level === 'error');
        checks.push({ name: gate.name, status: pass && !error ? 'pass' : 'fail',
            detail: error?.message ?? (!pass ? 'No fresh PASS log from this gate' : undefined) });
        if (!pass || error) break;
    }
    const sceneAfter = await idle(unity, workspace);
    if (JSON.stringify(sceneBefore) !== JSON.stringify(sceneAfter))
        throw new Error('Editor scene state changed during validation. Inspect the Editor before continuing.');
    for (const gate of gateMenus.slice(checks.length)) checks.push({ name: gate.name, status: 'not_run' });
    return checks;
}
async function runPhysics(workspace: Workspace, unity?: WorkspaceAdapter): Promise<Evidence[]> {
    if (!unity) throw new Error('Unity Adapter unavailable for this Workspace.');
    const capabilities: any = await unity.capabilities(workspace);
    if (!capabilities.available || !capabilities.commands?.some((c: any) => c.name === 'menu' && c.approved))
        throw new Error('The Mac owner must approve the restricted football validation menus.');
    const original = await idle(unity, workspace);
    await noTraining(workspace);
    const before: any = await call(unity, workspace, 'console', { tail: 1 });
    let cursor = before.cursor as number | undefined;
    let session = before.session as string | undefined;
    if (cursor === undefined || !session)
        throw new Error('Console cursor unavailable; cannot distinguish fresh physical evidence from historical logs.');

    await call(unity, workspace, 'menu', { path: 'Football/Drills/Run Physical Collision Smoke (Play Mode)' });
    let sawPass = false;
    let sawFailure = '';
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 700));
        const output: any = await call(unity, workspace, 'console', { tail: 100, since: cursor, since_session: session });
        if (output.reset || output.dropped) throw new Error('Console cursor reset/dropped; cannot certify fresh physics result.');
        cursor = output.cursor; session = output.session;
        for (const entry of Array.isArray(output.entries) ? output.entries : []) {
            if (entry.level === 'error') sawFailure = String(entry.message ?? 'Unity exception during physical smoke');
            if (entry.level === 'log' && typeof entry.message === 'string' && entry.message.includes(PHYSICS_TAG))
                sawPass = true;
        }
        const editor: any = await call(unity, workspace, 'editor_status');
        if (sawPass && editor.playMode === 'stopped') break;
        if (sawFailure && editor.playMode === 'stopped') break;
    }
    if (sawFailure) throw new Error('Unity exception during physics smoke: ' + sawFailure.slice(0, 500));
    if (!sawPass) throw new Error('No new physical PASS callback within the safety deadline.');
    const restored = await idle(unity, workspace);
    if (JSON.stringify(original) !== JSON.stringify(restored))
        throw new Error('Original Editor scene state changed during physics smoke.');
    return [{
        name: 'shared_rigidbody_collision_and_goal', status: 'pass',
        detail: 'Fresh Unity OnCollisionEnter, legal impulse, goal-line event and score latch; not a Shooting/Receiving agent end-to-end test',
    }];
}
export async function footballValidation(workspace: Workspace, action: 'validation_status' | 'validation_python' | 'validation_editor' | 'validation_physics', unity?: WorkspaceAdapter) {
    if (workspace.kind !== 'unity' || workspace.status !== 'active' ||
        workspace.projectId !== 'ce09dbe0-0755-4bd8-9376-e4a3152d59f7')
        throw new AtlasError('Validation requires the active AI Football Unity Workspace.', 'WORKSPACE_UNAVAILABLE');
    if (action === 'validation_status') {
        const receipts = history(workspace);
        const approved = unity ? await unity.capabilities(workspace).catch(() => null) : null;
        return { results: receipts.map(({ output, ...rest }) => ({ ...rest, output: limited(output) })),
            pythonAvailable: existsSync(path.join(workspace.rootPath, 'football_driver.py')),
            editorMenuApproved: !!(approved as any)?.commands?.some((c: any) => c.name === 'menu' && c.approved),
            sourceSha256: sourceFingerprint(workspace),
            physicsRuntime: 'shared_runtime_probe_only_not_agent_validation',
            physicsTag: PHYSICS_TAG };
    }
    if (active.has(workspace.rootPath)) throw new AtlasError('A football validation is already running.', 'VALIDATION_BUSY');
    active.add(workspace.rootPath);
    const started = Date.now();
    const evidence: Receipt = {
        id: 'val_' + randomUUID(), layer: action === 'validation_python' ? 'python' : action === 'validation_physics' ? 'physics' : 'editor',
        status: 'fail', startedAt: new Date(started).toISOString(), completedAt: '',
        durationMs: 0, sourceSha256: sourceFingerprint(workspace),
        checks: [], summary: '', output: '',
    };
    try {
        if (action === 'validation_python') {
            const result = await runPython(workspace);
            const output = limited(result.stdout + '\n' + result.stderr);
            const count = /Ran (\d+) tests? in [\d.]+s/.exec(output)?.[1];
            const passed = Number(count) > 0 && /(?:^|\n)OK\s*$/m.test(output) && !/FAILED \(/.test(output);
            evidence.checks = [{ name: 'python_unittest', status: passed ? 'pass' : 'fail', detail: count ? count + ' tests executed' : 'No complete unittest summary found' }];
            evidence.status = passed ? 'pass' : 'fail';
            evidence.output = output;
        } else if (action === 'validation_physics') {
            evidence.checks = await runPhysics(workspace, unity);
            evidence.status = evidence.checks[0]?.status === 'pass' ? 'pass' : 'fail';
            evidence.output = evidence.checks.map(c => c.name + ': ' + c.status + (c.detail ? ' (' + c.detail + ')' : '')).join('\n');
        } else {
            evidence.checks = await runEditor(workspace, unity);
            evidence.status = evidence.checks.length === gateMenus.length && evidence.checks.every(c => c.status === 'pass') ? 'pass' : 'fail';
            evidence.output = evidence.checks.map(c => c.name + ': ' + c.status + (c.detail ? ' (' + c.detail + ')' : '')).join('\n');
        }
    } catch (error: any) {
        evidence.error = limited(String(error?.stderr ?? error?.message ?? error));
        evidence.output = limited(String(error?.stdout ?? ''));
        if (action === 'validation_python') {
            const output = evidence.output + '\n' + evidence.error;
            const count = /Ran (\d+) tests? in [\d.]+s/.exec(output)?.[1];
            evidence.checks.push({ name: 'python_unittest', status: 'fail', detail: count ? count + ' tests executed; see failures' : 'Test process failed before completion' });
        }
    } finally {
        evidence.completedAt = new Date().toISOString();
        evidence.durationMs = Date.now() - started;
        evidence.summary = evidence.status === 'pass' ? 'All ' + evidence.layer + ' checks passed' :
            evidence.error ? 'Validation blocked/failed: ' + evidence.error.slice(0, 300) : 'One or more checks failed';
        active.delete(workspace.rootPath);
    }
    return save(workspace, evidence);
}
