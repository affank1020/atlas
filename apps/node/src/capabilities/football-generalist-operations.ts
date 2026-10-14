import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AtlasError } from '@atlas/protocol/errors';
import type { Workspace } from '@atlas/protocol/workspace';
import { generalistManifest } from './football-generalist.js';
import { listGeneralistRuns } from './football-generalist-runs.js';

type Args = { action: string; runId?: string; policyId?: string; scenario?: string; preset?: string; arenas?: number; basePort?: number; seed?: number; episodes?: number };
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const env = () => Object.fromEntries(['PATH','HOME','TMPDIR','LANG','USER','LOGNAME'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));

function safeFile(workspace: Workspace, file: string): string {
    const root = realpathSync(workspace.rootPath);
    const resolved = realpathSync(file);
    if (!resolved.startsWith(root + path.sep) || lstatSync(file).isSymbolicLink() || !statSync(resolved).isFile()) throw new AtlasError('Generalist file must be inside the Unity workspace.', 'INVALID_ARGUMENT');
    return resolved;
}
/** Only the fixed isolated generalist build location is allowed outside the workspace.
 *  The canonical Python runner subsequently checks its stamped binary/asset hashes. */
function safeRunnerBinary(workspace: Workspace, file: string): string {
    try { return safeFile(workspace, file); } catch {}
    const resolved = realpathSync(file);
    const temp = realpathSync('/tmp');
    const relative = path.relative(temp, resolved).replaceAll(path.sep, '/');
    if (!/^atlas-football-generalist-build[a-zA-Z0-9_-]*\.app\/Contents\/MacOS\/AI Football$/.test(relative) ||
        lstatSync(file).isSymbolicLink() || !statSync(resolved).isFile())
        throw new AtlasError('Runner must be a recorded workspace build or an allowlisted isolated generalist build.', 'INVALID_ARGUMENT');
    return resolved;
}
function readJson(file: string): any {
    if (statSync(file).size > 1024 * 1024) throw new Error('Oversized metadata');
    return JSON.parse(readFileSync(file, 'utf8'));
}
function scan(workspace: Workspace, filename: string) {
    const results: string[] = [];
    const roots = [path.join(workspace.rootPath, 'training-driver-runs'), path.join(workspace.rootPath, 'validation/generalist')];
    const walk = (dir: string, depth: number) => {
        if (results.length >= 300 || depth > 5 || !existsSync(dir) || lstatSync(dir).isSymbolicLink()) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (results.length >= 300) break;
            if (entry.isSymbolicLink()) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!['atlas-evaluation-launches','atlas-launches','training-cache'].includes(entry.name)) walk(full, depth + 1);
            } else if (entry.isFile() && entry.name === filename) results.push(full);
        }
    };
    for (const root of roots) walk(root, 0);
    return results;
}
export function generalistPolicies(workspace: Workspace) {
    const manifest = generalistManifest(workspace);
    const found = [];
    const seen = new Set<string>();
    for (const file of scan(workspace, 'policy.json')) {
        try {
            const policy = readJson(file);
            if (policy.family !== 'generalist' || typeof policy.id !== 'string' || !idPattern.test(policy.id) || seen.has(policy.id)) continue;
            seen.add(policy.id);
            const compatibleMetadata = policy.behavior === manifest.contract.behavior &&
                policy.contract_sha256 === manifest.fingerprints.contract_sha256 &&
                policy.scenario_sha256 === manifest.fingerprints.scenario_sha256;
            found.push({ id: policy.id, family: 'generalist', behavior: policy.behavior, status: policy.status ?? 'unverified',
                source: path.relative(workspace.rootPath, file), compatible_metadata: compatibleMetadata,
                // The canonical runner checks implementation + model + bundle hashes at execution.
                executable_verified: false, view_scenario: policy.view_scenario,
                onnx_available: typeof policy.onnx_path === 'string' && existsSync(policy.onnx_path),
                bundle_available: typeof policy.bundle_path === 'string' && existsSync(policy.bundle_path) });
        } catch { /* damaged or unrelated metadata must not contaminate the index */ }
    }
    return found;
}
function policyFile(workspace: Workspace, id: string) {
    if (!idPattern.test(id)) throw new AtlasError('Invalid generalist policy ID.', 'INVALID_ARGUMENT');
    for (const file of scan(workspace, 'policy.json')) {
        try { if (readJson(file)?.family === 'generalist' && readJson(file)?.id === id) return { file: safeFile(workspace, file), policy: readJson(file) }; } catch {}
    }
    throw new AtlasError('Generalist policy metadata not found.', 'NOT_FOUND');
}
function taskDir(workspace: Workspace) {
    const root = path.join(workspace.rootPath, 'training-driver-runs', 'atlas-generalist-operations');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
}
function launch(workspace: Workspace, action: string, command: string[], fields: Record<string, unknown>) {
    const directory = taskDir(workspace);
    const ticket = randomUUID();
    const out = openSync(path.join(directory, ticket + '.out'), 'wx', 0o600);
    const err = openSync(path.join(directory, ticket + '.err'), 'wx', 0o600);
    let pid: number | undefined;
    try {
        const child = spawn('python3', command, { cwd: workspace.rootPath, env: env(), detached: true, shell: false, stdio: ['ignore', out, err] });
        child.on('error', error => { try { writeFileSync(path.join(directory, ticket + '.err'), String(error.message).slice(0, 1000)); } catch {} });
        pid = child.pid;
        if (!pid) throw new AtlasError('Unable to start generalist operation.', 'DRIVER_UNAVAILABLE');
        child.unref();
    } finally { closeSync(out); closeSync(err); }
    writeFileSync(path.join(directory, ticket + '.json'), JSON.stringify({ ticket, pid, action, ...fields, started_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    return { accepted: true, ticket, action, status: 'launching', note: 'Operation accepted. Inspect its receipt; acceptance does not mean success.' };
}
function receipt(workspace: Workspace, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AtlasError('Invalid receipt ID.', 'INVALID_ARGUMENT');
    const dir = taskDir(workspace);
    const name = path.join(dir, id);
    if (!existsSync(name + '.json')) throw new AtlasError('Generalist receipt not found.', 'NOT_FOUND');
    const item = readJson(name + '.json');
    const output = existsSync(name + '.out') ? readFileSync(name + '.out', 'utf8').slice(-4000) : '';
    const error = existsSync(name + '.err') ? readFileSync(name + '.err', 'utf8').slice(-4000) : '';
    let alive = false;
    try { process.kill(item.pid, 0); alive = true; } catch {}
    let result: any;
    if (item.action === 'generalist_train') {
        // Only the bridge's explicit completion receipt can establish training command success.
        const line = output.trim().split('\n').at(-1);
        try { const parsed = JSON.parse(line || ''); if (parsed.completed === true && parsed.family === 'generalist') result = { run_id: parsed.run_id, completed: true }; } catch {}
    } else if (typeof item.output === 'string' && existsSync(item.output)) {
        try {
            const parsed = readJson(item.output);
            if (parsed.contract === 'football-generalist-v2' && Array.isArray(parsed.episodes)) {
                const counts: Record<string, number> = {};
                for (const episode of parsed.episodes) if (typeof episode.outcome === 'string') counts[episode.outcome] = (counts[episode.outcome] ?? 0) + 1;
                result = { episodes: parsed.episodes.length, outcomes: counts };
            }
        } catch {}
    }
    const status = alive ? 'running' : result ? 'completed' : error.trim() ? 'failed_or_stopped' : 'unverified_exit';
    return { ...item, status, result, output, error };
}
function reports(workspace: Workspace) {
    const dir = taskDir(workspace);
    if (!existsSync(dir)) return [];
    const result = [];
    for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.json') || !/^[a-f0-9-]{36}\.json$/.test(entry)) continue;
        try {
            const meta = readJson(path.join(dir, entry));
            if (['generalist_evaluate', 'generalist_baseline', 'generalist_watch'].includes(meta.action))
                result.push(receipt(workspace, meta.ticket));
        } catch {}
    }
    return result.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, 100);
}
export function generalistOperation(workspace: Workspace, x: Args): unknown {
    if (workspace.kind !== 'unity' || workspace.status !== 'active') throw new AtlasError('Active Unity workspace required.', 'WORKSPACE_UNAVAILABLE');
    if (x.action === 'generalist_runs') return listGeneralistRuns(workspace);
    if (x.action === 'generalist_policies') return generalistPolicies(workspace);
    if (x.action === 'generalist_activity') return reports(workspace);
    if (x.action === 'generalist_status') return receipt(workspace, x.runId!);
    if (x.action === 'generalist_stop') {
        const item = receipt(workspace, x.runId!);
        if (item.action !== 'generalist_train' || item.status !== 'running' ||
            !Number.isSafeInteger(item.pid) || item.pid <= 1 ||
            !Number.isFinite(Date.parse(item.started_at)) ||
            Date.now() - Date.parse(item.started_at) > 48 * 60 * 60 * 1000)
            throw new AtlasError('Only a recent running Atlas-owned generalist training launch can be interrupted.', 'INVALID_ARGUMENT');
        // The launch is detached; SIGINT reaches Python PPO and Unity in its own process group.
        process.kill(-item.pid, 'SIGINT');
        return { requested: true, ticket: item.ticket, status: 'interrupt_requested' };
    }
    const manifest = generalistManifest(workspace);
    const scenarios = new Set(['mix', ...manifest.scenarios.scenarios.map((s: { id: string }) => s.id)]);
    const scenario = x.scenario ?? 'mix';
    if (!scenarios.has(scenario)) throw new AtlasError('Scenario is not present in the generalist manifest.', 'INVALID_ARGUMENT');
    if (x.action === 'generalist_train') {
        if (manifest.curriculum.held_out_seeds?.includes(x.seed ?? 42)) throw new AtlasError('Held-out seeds are reserved for evaluation.', 'INVALID_ARGUMENT');
        const script = safeFile(workspace, path.join(workspace.rootPath, 'atlas_generalist_launch.py'));
        const runId = 'atlas-generalist-' + randomUUID().replaceAll('-', '').slice(0, 12);
        return launch(workspace, x.action, [script, '--run-id', runId, '--scenario', scenario, '--preset', x.preset ?? 'smoke', '--seed', String(x.seed ?? 42), '--base-port', String(x.basePort ?? 5605), '--arenas', String(x.arenas ?? 1)], { run_id: runId, scenario, preset: x.preset ?? 'smoke' });
    }
    const script = safeFile(workspace, path.join(workspace.rootPath, 'football_generalist.py'));
    const ticket = randomUUID();
    const output = path.join(taskDir(workspace), ticket + '.result.json');
    const cmd = [script];
    const args = ['--scenario', scenario, '--seed', String(x.seed ?? 515), '--arenas', String(x.arenas ?? 1), '--episodes', String(x.episodes ?? 10), '--output', output];
    const action = x.action === 'generalist_baseline' ? 'baseline' : x.action === 'generalist_evaluate' ? 'evaluate' : x.action === 'generalist_watch' ? 'watch' : null;
    if (!action) throw new AtlasError('Unsupported generalist action.', 'INVALID_ARGUMENT');
    let binary: string;
    if (action !== 'baseline') {
        const p = policyFile(workspace, x.policyId!);
        if (p.policy.behavior !== manifest.contract.behavior ||
            p.policy.contract_sha256 !== manifest.fingerprints.contract_sha256 ||
            p.policy.scenario_sha256 !== manifest.fingerprints.scenario_sha256)
            throw new AtlasError('Generalist policy provenance does not match the current contract/scenarios.', 'INVALID_ARGUMENT');
        binary = safeRunnerBinary(workspace, p.policy.runner_binary);
        const bundle = safeFile(workspace, p.policy.bundle_path);
        safeFile(workspace, p.policy.onnx_path);
        args.push('--policy', p.file, '--bundle', bundle);
    } else {
        // A baseline needs a verified Unity runner, but not a policy bundle.
        // Prefer an explicit registered policy runner; fall back to a recorded generalist training build.
        let candidateBinary: string | undefined;
        for (const entry of generalistPolicies(workspace)) {
            if (!entry.compatible_metadata) continue;
            try { candidateBinary = safeRunnerBinary(workspace, policyFile(workspace, entry.id).policy.runner_binary); break; } catch {}
        }
        if (!candidateBinary) for (const run of listGeneralistRuns(workspace)) {
            if (typeof run.binary !== 'string') continue;
            try { candidateBinary = safeRunnerBinary(workspace, run.binary); break; } catch {}
        }
        if (!candidateBinary) throw new AtlasError('No recorded generalist runner is available for baseline execution.', 'DRIVER_UNAVAILABLE');
        binary = candidateBinary;
    }
    cmd.push(action, '--binary', binary, ...args);
    return launch(workspace, x.action, cmd, { scenario, policy_id: x.policyId ?? null, output });
}
