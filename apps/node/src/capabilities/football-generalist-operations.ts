import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readCuration, writeCuration, deriveAssessments, type SavedAssessment } from './generalist-policy-profiles.js';
import { AtlasError } from '@atlas/protocol/errors';
import type { Workspace } from '@atlas/protocol/workspace';
import { generalistManifest } from './football-generalist.js';
import { generalistRunDetail, listGeneralistRuns } from './football-generalist-runs.js';

type Args = { displayName?: string; featured?: boolean; action: string; runId?: string; initializeFromRunId?: string; policyId?: string; scenario?: string; preset?: string; arenas?: number; basePort?: number; seed?: number; episodes?: number; offset?: number; limit?: number };
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
// Watch-only curated playlist; not a training/evaluation scenario or policy ABI change.
const showcaseScenario = 'dribbling_showcase_v1';
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
/** Inspect a historical runner's recorded metadata without executing it.
 * Final launch independently rechecks all file hashes in the Python runner.
 * This never broadens allowed policies for training or evaluation. */
function historicalWatchRunner(workspace: Workspace, policy: any) {
    try {
        const binary = safeRunnerBinary(workspace, policy.runner_binary);
        const stamp = readJson(path.join(path.dirname(path.dirname(binary)), 'generalist-build.json'));
        if (policy.family !== 'generalist' || stamp.family !== 'generalist' ||
            policy.behavior !== stamp.contract?.behavior ||
            !['contract_sha256','scenario_sha256','implementation_sha256'].every(key =>
                typeof policy[key] === 'string' && policy[key] === stamp[key]) ||
            typeof policy.view_scenario !== 'string' || !idPattern.test(policy.view_scenario) ||
            !Array.isArray(stamp.scenarios?.scenarios) ||
            !stamp.scenarios.scenarios.some((s: any) => s?.id === policy.view_scenario))
            return null;
        safeFile(workspace, policy.bundle_path);
        safeFile(workspace, policy.onnx_path);
        return { binary, scenario: policy.view_scenario };
    } catch { return null; }
}

export function generalistPolicies(workspace: Workspace) {
    const curated = readCuration(workspace.rootPath);
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
            const featured = curated[policy.id]?.featured === true;
            const historicalRunner = featured && !compatibleMetadata ? historicalWatchRunner(workspace, policy) : null;
            found.push({ id: policy.id, display_name: curated[policy.id]?.display_name ?? (typeof policy.display_name === 'string' && policy.display_name.trim() ? policy.display_name.trim().slice(0, 80) : null),
                featured, historical_watch_available: !!historicalRunner, source_policy_id: typeof policy.source_policy_id === 'string' ? policy.source_policy_id : null,
                onnx_sha256: typeof policy.onnx_sha256 === 'string' ? policy.onnx_sha256 : null, family: 'generalist', behavior: policy.behavior, status: policy.status ?? 'unverified',
                source: path.relative(workspace.rootPath, file), compatible_metadata: compatibleMetadata,
                source_run_id: typeof (policy.source_run_id ?? policy.run_id) === 'string' && idPattern.test(policy.source_run_id ?? policy.run_id) ? (policy.source_run_id ?? policy.run_id) : null,
                contract_sha256: policy.contract_sha256, scenario_sha256: policy.scenario_sha256,
                implementation_sha256: policy.implementation_sha256,
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
function launch(workspace: Workspace, action: string, command: string[], fields: Record<string, unknown>, ticket = randomUUID()) {
    const directory = taskDir(workspace);
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
    if (Number.isSafeInteger(item.pid) && item.pid > 1) {
        try { process.kill(item.pid, 0); alive = true; } catch {}
    }
    let result: any;
    if (item.action === 'generalist_train') {
        // Only the bridge's explicit completion receipt can establish training command success.
        const line = output.trim().split('\n').at(-1);
        try { const parsed = JSON.parse(line || ''); if (parsed.completed === true && parsed.family === 'generalist') result = { run_id: parsed.run_id, completed: true }; } catch {}
    } else if (item.action === 'generalist_package') {
        try {
            const parsed = JSON.parse(output.trim().split('\n').at(-1) || '');
            if (parsed.status === 'registered' && typeof parsed.policy_id === 'string')
                result = { policy_id: parsed.policy_id, registered: true };
        } catch {}
    } else if (typeof item.output === 'string' && existsSync(item.output)) {
        try {
            const parsed = readJson(item.output);
            if (parsed.contract === 'football-generalist-v2' && Array.isArray(parsed.episodes)) {
                const counts: Record<string, number> = {};
                for (const episode of parsed.episodes) if (typeof episode.outcome === 'string') counts[episode.outcome] = (counts[episode.outcome] ?? 0) + 1;
                const measured = parsed.episodes.filter((ep: any) => typeof ep.success === 'boolean');
                result = { episodes: parsed.episodes.length, outcomes: counts,
                    success_rate: measured.length === parsed.episodes.length && measured.length > 0
                        ? measured.filter((ep: any) => ep.success).length / measured.length : null };
            }
        } catch {}
    }
    if (item.action === 'generalist_watch') {
        // Viewer receipts may outlive the Unity window. A live Python wrapper
        // proves neither a running player nor a visible macOS window.
        const fileName = typeof item.output === 'string' ? path.basename(item.output) : '';
        const safeOutput = /^[a-f0-9-]{36}\.result\.json$/.test(fileName) &&
            item.output === path.join(dir, fileName);
        const playerLog = safeOutput ? path.join(dir, fileName + '.player.log') : null;
        const launchFile = safeOutput ? path.join(dir, fileName + '.launch.json') : null;
        let launchMethod: 'launchservices' | 'direct' | 'unknown' = 'unknown';
        if (launchFile && existsSync(launchFile)) {
            try {
                const launchReceipt = readJson(launchFile);
                const command = launchReceipt.command;
                if (Array.isArray(command) && command[0] === 'open' && command.includes('-n') &&
                    command.includes('-a')) launchMethod = 'launchservices';
                else if (Array.isArray(command)) launchMethod = 'direct';
            } catch {}
        }
        let playerLogText = '';
        try {
            if (playerLog && existsSync(playerLog) && !lstatSync(playerLog).isSymbolicLink() &&
                statSync(playerLog).isFile()) {
                const size = statSync(playerLog).size;
                const fd = openSync(playerLog, 'r');
                try {
                    const buffer = Buffer.alloc(Math.min(size, 4096));
                    readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
                    playerLogText = buffer.toString('utf8');
                } finally { closeSync(fd); }
            }
        } catch {}
        const playerLogged = playerLogText.trim().length > 0;
        const failed = /Traceback \(most recent call last\)|subprocess\.CalledProcessError|open:.*(error|failed)/i.test(error + '\n' + output);
        const status = alive ? 'running' : failed ? 'failed_or_stopped' :
            playerLogged ? 'closed' : 'unverified_exit';
        return { ...item, status, result, output, error,
            viewer: {
                launcher_alive: alive, player_log_detected: playerLogged,
                launch_method: launchMethod,
                state: alive ? (playerLogged ? 'player_logging' : 'launching_unverified') :
                    failed ? 'launch_failed' : playerLogged ? 'closed' : 'unknown',
                log_tail: playerLogText,
                note: playerLogged
                    ? 'Unity wrote a player log; this does not prove a window is visible.'
                    : 'No Unity player log observed; a live launcher alone does not prove the viewer opened.',
            } };
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

/** Paginated generalist evaluation diagnostics, limited to Atlas-owned saved output. */
function generalistEvaluationDetail(workspace: Workspace, id: string, offset: number, limit: number) {
    const operation = receipt(workspace, id);
    if (!['generalist_evaluate', 'generalist_baseline'].includes(operation.action))
        throw new AtlasError('This receipt is not a generalist evaluation.', 'INVALID_ARGUMENT');
    // Older launches generated the result-file UUID separately from the receipt ticket.
    // Trust only a UUID-named file directly within our private operations directory.
    const directory = taskDir(workspace);
    // The public receipt's `output` is stdout, not the stored result-file path.
    const metadata = readJson(path.join(directory, id + '.json'));
    const recordedOutput = typeof metadata.output === 'string' ? path.resolve(metadata.output) : '';
    const file = recordedOutput && path.dirname(recordedOutput) === path.resolve(directory) &&
        /^[a-f0-9-]{36}\.result\.json$/.test(path.basename(recordedOutput))
        ? recordedOutput : path.join(directory, id + '.result.json');
    if (!existsSync(file)) return { operation, summary: null, episodes: [], pagination: { offset, total: 0, has_more: false },
        note: 'No completed evaluation result was saved for this operation.' };
    if (lstatSync(file).isSymbolicLink() || statSync(file).size > 4 * 1024 * 1024)
        throw new AtlasError('Evaluation result is unavailable or exceeds the safe read limit.', 'INVALID_ARGUMENT');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed.contract !== 'football-generalist-v2' || !Array.isArray(parsed.episodes))
        throw new AtlasError('This is not a generalist V2 evaluation report.', 'INVALID_ARGUMENT');
    const counts: Record<string, number> = {};
    let known = 0, successes = 0;
    for (const episode of parsed.episodes) {
        if (typeof episode?.outcome === 'string') counts[episode.outcome] = (counts[episode.outcome] ?? 0) + 1;
        if (typeof episode?.success === 'boolean') { known++; if (episode.success) successes++; }
    }
    const total = parsed.episodes.length;
    return {
        operation, summary: { total, outcomes: counts, success_rate: known === total && total ? successes / total : null,
            measured_success_episodes: known },
        episodes: parsed.episodes.slice(offset, offset + limit),
        pagination: { offset, total, has_more: offset + limit < total },
        note: known === total ? 'Success is measured from saved episode success flags.' :
            'Success rate is unavailable unless each saved episode explicitly records success; outcomes are shown separately.',
    };
}

export function generalistOperation(workspace: Workspace, x: Args): unknown {
    if (workspace.kind !== 'unity' || workspace.status !== 'active') throw new AtlasError('Active Unity workspace required.', 'WORKSPACE_UNAVAILABLE');
    if (x.action === 'generalist_runs') return listGeneralistRuns(workspace);
    if (x.action === 'generalist_run_detail') return generalistRunDetail(workspace, x.runId!);
    if (x.action === 'generalist_policies') return generalistPolicies(workspace);
    if (x.action === 'generalist_policy_update') {
        if (typeof x.policyId !== 'string' || !idPattern.test(x.policyId))
            throw new AtlasError('Invalid policy identifier.', 'INVALID_ARGUMENT');
        policyFile(workspace, x.policyId); // Existing explicit policy, not a fabricated identifier.
        const change: { display_name?: string; featured?: boolean } = {};
        if (x.displayName !== undefined) {
            if (typeof x.displayName !== 'string' || !/^[\\p{L}\\p{N}][\\p{L}\\p{N} ._'-]{0,63}$/u.test(x.displayName.trim()))
                throw new AtlasError('Display name must be 1–64 plain characters.', 'INVALID_ARGUMENT');
            change.display_name = x.displayName.trim();
        }
        if (x.featured !== undefined) {
            if (typeof x.featured !== 'boolean') throw new AtlasError('Invalid featured flag.', 'INVALID_ARGUMENT');
            if (x.featured) {
                const metadata = generalistPolicies(workspace).find(p => p.id === x.policyId);
                if (!metadata?.compatible_metadata || !metadata.onnx_available || !metadata.bundle_available)
                    throw new AtlasError('Only currently compatible bundled policies can be featured.', 'INVALID_ARGUMENT');
            }
            change.featured = x.featured;
        }
        if (!Object.keys(change).length) throw new AtlasError('No changes requested.', 'INVALID_ARGUMENT');
        return { policy_id: x.policyId, ...writeCuration(workspace.rootPath, x.policyId, change) };
    }
    if (x.action === 'generalist_assessments') {
        const entries: SavedAssessment[] = [];
        for (const item of reports(workspace)) {
            if (item.action !== 'generalist_evaluate' || item.status !== 'completed' ||
                typeof item.policy_id !== 'string' || typeof item.scenario !== 'string') continue;
            const file = path.join(taskDir(workspace), item.ticket + '.result.json');
            try {
                if (lstatSync(file).isSymbolicLink() || statSync(file).size > 4 * 1024 * 1024) continue;
                const parsed = JSON.parse(readFileSync(file, 'utf8'));
                if (parsed.contract !== 'football-generalist-v2' || !Array.isArray(parsed.episodes) ||
                    !parsed.episodes.length || parsed.episodes.some((e: any) => typeof e?.success !== 'boolean')) continue;
                entries.push({ ticket: item.ticket, policy_id: item.policy_id, scenario: item.scenario,
                    seed: Number.isSafeInteger(item.seed) ? item.seed : null, episodes: parsed.episodes });
            } catch { /* incomplete or older report cannot be trusted as performance */ }
        }
        return { suite: { id: 'dribbling-assessment-v1', status: 'provisional_historical',
            benchmarkEpisodes: 100, note: 'Historical benchmark evidence is descriptive, not certified; repeat on unused held-out seeds to certify.' },
            policies: deriveAssessments(generalistPolicies(workspace), entries) };
    }
    if (x.action === 'generalist_activity') return reports(workspace);
    if (x.action === 'generalist_status') return receipt(workspace, x.runId!);
    if (x.action === 'generalist_package') {
        if (typeof x.runId !== 'string' || !idPattern.test(x.runId))
            throw new AtlasError('Invalid generalist run ID.', 'INVALID_ARGUMENT');
        const run = listGeneralistRuns(workspace).find(candidate => candidate.id === x.runId);
        if (!run) throw new AtlasError('Generalist training run not found.', 'NOT_FOUND');
        const root = realpathSync(workspace.rootPath);
        const directory = realpathSync(path.join(root, String(run.output_dir)));
        if (!directory.startsWith(root + path.sep) || !statSync(directory).isDirectory())
            throw new AtlasError('Generalist training directory is outside the workspace.', 'INVALID_ARGUMENT');
        if (!existsSync(path.join(directory, x.runId, 'FootballGeneralistV2.onnx')))
            throw new AtlasError('The training run has no final exported ONNX model yet.', 'INVALID_ARGUMENT');
        const script = safeFile(workspace, path.join(root, 'football_generalist.py'));
        return launch(workspace, x.action, [script, 'package', '--output', directory],
            { run_id: x.runId, output_dir: String(run.output_dir) });
    }
    if (x.action === 'generalist_evaluation_detail') return generalistEvaluationDetail(workspace, x.runId!, x.offset ?? 0, x.limit ?? 100);
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
    const pinnedWatch = x.action === 'generalist_watch' ? policyFile(workspace, x.policyId!) : null;
    const currentWatch = pinnedWatch && pinnedWatch.policy.behavior === manifest.contract.behavior &&
        pinnedWatch.policy.contract_sha256 === manifest.fingerprints.contract_sha256 &&
        pinnedWatch.policy.scenario_sha256 === manifest.fingerprints.scenario_sha256;
    const historicalWatch = !!pinnedWatch && !currentWatch;
    const archivedRunner = historicalWatch ? historicalWatchRunner(workspace, pinnedWatch.policy) : null;
    if (historicalWatch && (!readCuration(workspace.rootPath)[pinnedWatch!.policy.id]?.featured || !archivedRunner))
        throw new AtlasError('Historical playback requires a featured policy with its exact saved Unity build and model artifacts.', 'INVALID_ARGUMENT');
    // Historical Watch is restricted to the recorded original scenario; arbitrary
    // current scenarios and the current showcase playlist are intentionally excluded.
    const scenario = historicalWatch ? archivedRunner!.scenario : x.scenario ?? 'mix';
    if (historicalWatch && x.scenario !== scenario)
        throw new AtlasError('Historical Watch must use the scenario saved with this policy.', 'INVALID_ARGUMENT');
    const scenarios = new Set(['mix', 's1_rehearsal', ...manifest.scenarios.scenarios.map((s: { id: string }) => s.id)]);
    // Training-only aliases must be present in the versioned curriculum. Never
    // permit phase aliases for evaluation/Watch, which require a real scenario.
    const phaseIds = new Set((manifest.curriculum.shooting_phases ?? [])
        .map((phase: { id: string }) => phase.id));
    if (x.action === 'generalist_train') for (const id of phaseIds) scenarios.add(id);
    if (x.action === 'generalist_watch') scenarios.add(showcaseScenario);
    if (!historicalWatch && !scenarios.has(scenario))
        throw new AtlasError('Scenario is not present in the generalist manifest.', 'INVALID_ARGUMENT');
    if (x.action === 'generalist_train') {
        if (manifest.curriculum.held_out_seeds?.includes(x.seed ?? 42)) throw new AtlasError('Held-out seeds are reserved for evaluation.', 'INVALID_ARGUMENT');
        if (x.preset === 'pilot_50k' && !['s2-score-basic-v1', 's2_phase_shoot_retention_v2', 's2_phase_interception_rehearsal_v3', 's2_phase_balanced_rehearsal_v4'].includes(scenario))
            throw new AtlasError('50k pilot is reserved for the versioned S2.2 curricula.', 'INVALID_ARGUMENT');
        const sourceId = x.initializeFromRunId;
        if ((scenario === 's1_rehearsal' || phaseIds.has(scenario)) && !sourceId)
            throw new AtlasError('Versioned curriculum training requires an explicit source checkpoint.', 'INVALID_ARGUMENT');
        if (sourceId) {
            if (!idPattern.test(sourceId)) throw new AtlasError('Invalid source run ID.', 'INVALID_ARGUMENT');
            const source = listGeneralistRuns(workspace).find(run => run.id === sourceId);
            if (!source || source.contract_sha256 !== manifest.fingerprints.contract_sha256)
                throw new AtlasError('Source run does not exist or has a different policy ABI.', 'INVALID_ARGUMENT');
            const checkpoint = path.join(workspace.rootPath, String(source.output_dir), sourceId,
                manifest.contract.behavior, 'checkpoint.pt');
            safeFile(workspace, checkpoint);
        }
        const script = safeFile(workspace, path.join(workspace.rootPath, 'atlas_generalist_launch.py'));
        const runId = 'atlas-generalist-' + randomUUID().replaceAll('-', '').slice(0, 12);
        const cmd = [script, '--run-id', runId, '--scenario', scenario, '--preset', x.preset ?? 'smoke',
            '--seed', String(x.seed ?? 42), '--base-port', String(x.basePort ?? 5605), '--arenas', String(x.arenas ?? 1),
            ...(sourceId ? ['--initialize-from-run', sourceId] : [])];
        return launch(workspace, x.action, cmd, { run_id: runId, scenario, preset: x.preset ?? 'smoke',
            initialization_source_run_id: sourceId ?? null });
    }
    const ticket = randomUUID();
    const output = path.join(taskDir(workspace), ticket + '.result.json');
    const runnerScenario = x.action === 'generalist_watch' && scenario === showcaseScenario ? 's0-contact-easy-v1' : scenario;
    const args = ['--scenario', runnerScenario, '--seed', String(x.seed ?? 515), '--arenas', String(x.arenas ?? 1), '--episodes', String(x.episodes ?? 10), '--output', output];
    const action = x.action === 'generalist_baseline' ? 'baseline' : x.action === 'generalist_evaluate' ? 'evaluate' : x.action === 'generalist_watch' ? 'watch' : null;
    if (!action) throw new AtlasError('Unsupported generalist action.', 'INVALID_ARGUMENT');
    if (action === 'watch' && scenario === showcaseScenario) args.push('--showcase');
    let binary: string;
    if (action !== 'baseline') {
        const p = policyFile(workspace, x.policyId!);
        if (!historicalWatch && (p.policy.behavior !== manifest.contract.behavior ||
            p.policy.contract_sha256 !== manifest.fingerprints.contract_sha256 ||
            p.policy.scenario_sha256 !== manifest.fingerprints.scenario_sha256))
            throw new AtlasError('Generalist policy provenance does not match the current contract/scenarios.', 'INVALID_ARGUMENT');
        binary = historicalWatch ? archivedRunner!.binary : safeRunnerBinary(workspace, p.policy.runner_binary);
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
    const script = safeFile(workspace, path.join(workspace.rootPath, 'football_generalist.py'));
    const cmd = [script, action, '--binary', binary, ...args,
        ...(historicalWatch ? ['--historical-watch'] : [])];
    return launch(workspace, x.action, cmd, { scenario, historical_watch: historicalWatch, policy_id: x.policyId ?? null, output,
        seed: x.seed ?? 515,
        ...(action !== 'watch' ? { requested_episodes: x.episodes ?? 10 } : {}) }, ticket);
}
