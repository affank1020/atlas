import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { AtlasError } from '@atlas/protocol/errors';
import path from 'node:path';
import type { Workspace } from '@atlas/protocol/workspace';

/** Link Atlas-owned launch receipts to actual trainer run IDs without conflating
 *  process existence with a finished or successful training result. */
function launchStates(workspace: Workspace): Map<string, string> {
    const states = new Map<string, string>();
    const root = path.join(workspace.rootPath, 'training-driver-runs', 'atlas-generalist-operations');
    if (!existsSync(root)) return states;
    for (const filename of readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(-500)) {
        try {
            const file = path.join(root, filename);
            if (statSync(file).size > 4096) continue;
            const receipt = JSON.parse(readFileSync(file, 'utf8'));
            if (receipt.action !== 'generalist_train' || typeof receipt.run_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(receipt.run_id)) continue;
            let active = false;
            try { process.kill(receipt.pid, 0); active = true; } catch {}
            let status = active ? 'running' : 'unknown';
            if (!active) {
                const out = file.slice(0, -5) + '.out';
                const err = file.slice(0, -5) + '.err';
                if (existsSync(out) && statSync(out).size < 2 * 1024 * 1024) {
                    try {
                        const last = readFileSync(out, 'utf8').trim().split('\n').at(-1);
                        const done = JSON.parse(last || '');
                        if (done.family === 'generalist' && done.completed === true && done.run_id === receipt.run_id) status = 'completed';
                    } catch {}
                }
                if (status !== 'completed' && existsSync(err) && statSync(err).size > 0) status = 'failed_or_stopped';
            }
            states.set(receipt.run_id, status);
        } catch {}
    }
    return states;
}
/** ML-Agents stores interim ONNX exports in <run>/<behavior>/, with a final
 *  export in <run>/. Walk only those two known levels; never follow symlinks. */
function checkpointInventory(workspace: Workspace, directory: string, runId: string) {
    const files: string[] = [];
    const root = realpathSync(workspace.rootPath);
    const runDir = path.join(directory, runId);
    for (const candidateDir of [runDir, path.join(runDir, 'FootballGeneralistV2')]) {
        try {
            if (lstatSync(candidateDir).isSymbolicLink() || !statSync(candidateDir).isDirectory()) continue;
            if (!realpathSync(candidateDir).startsWith(root + path.sep)) continue;
            for (const entry of readdirSync(candidateDir, { withFileTypes: true }).slice(0, 1000)) {
                if (!entry.isFile() || !entry.name.endsWith('.onnx')) continue;
                const file = path.join(candidateDir, entry.name);
                if (lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(root + path.sep)) continue;
                files.push(path.relative(workspace.rootPath, file));
            }
        } catch { /* Missing or inaccessible ML-Agents output is not an error. */ }
    }
    return { checkpoints: files.length, checkpoint_files: files.sort() };
}

/** Discover generalist experiments without relying on the legacy trainer index. */
export function listGeneralistRuns(workspace: Workspace) {
    const root = path.join(workspace.rootPath, 'training-driver-runs');
    if (!existsSync(root)) return [];
    const result: Record<string, unknown>[] = [];
    const states = launchStates(workspace);
    const visit = (directory: string, depth: number) => {
        if (depth > 3 || result.length >= 500) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (result.length >= 500) break;
            if (entry.isSymbolicLink()) continue;
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) { visit(full, depth + 1); continue; }
            if (!entry.isFile() || entry.name !== 'generalist-run.json') continue;
            try {
                if (statSync(full).size > 1024 * 1024) continue;
                const receipt = JSON.parse(readFileSync(full, 'utf8'));
                if (receipt.family !== 'generalist' || receipt.mode !== 'train' || !receipt.run_id) continue;
                const name = String(receipt.run_id);
                if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)) continue;
                const dir = path.dirname(full);
                let packaging: { status: string; policy_id?: string; error?: string } = { status: 'not_registered' };
                for (const file of ['policy-packaging.json', 'policy.json']) {
                    const candidate = path.join(dir, file);
                    if (!existsSync(candidate)) continue;
                    try {
                        if (lstatSync(candidate).isSymbolicLink() || statSync(candidate).size > 64 * 1024) continue;
                        const row = JSON.parse(readFileSync(candidate, 'utf8'));
                        if (file === 'policy.json' && row.family === 'generalist' && row.source_run_id === name)
                            packaging = { status: 'registered', policy_id: row.id };
                        else if (file !== 'policy.json' && typeof row.status === 'string')
                            packaging = { status: row.status, policy_id: row.policy_id, error: row.error };
                    } catch {}
                }
                result.push({
                    id: name, family: 'generalist', drill: 'generalist', scenario: receipt.scenario,
                    preset: receipt.preset ?? null, seed: receipt.seed, arenas: receipt.arenas,
                    num_envs: receipt.num_envs, contract_sha256: receipt.contract_sha256,
                    scenario_sha256: receipt.scenario_sha256, implementation_sha256: receipt.implementation_sha256,
                    binary: receipt.binary, packaging, output_dir: path.relative(workspace.rootPath, dir),
                    initialization: receipt.initialization ?? null,
                    training_config: receipt.training_config ?? null,
                    initialization_available: (() => {
                        const pt = path.join(dir, name, 'FootballGeneralistV2', 'checkpoint.pt');
                        try {
                            return !lstatSync(pt).isSymbolicLink() && statSync(pt).isFile() &&
                                realpathSync(pt).startsWith(realpathSync(workspace.rootPath) + path.sep);
                        } catch { return false; }
                    })(),
                    started_at: statSync(full).birthtime.toISOString(),
                    state: states.get(name) ?? 'unknown', // External runs remain unknown without a verified Atlas launch receipt.
                    ...checkpointInventory(workspace, dir, name),
                });
            } catch { /* malformed or inaccessible receipts are ignored */ }
        }
    };
    visit(root, 0);
    return result.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

/** Bounded run diagnostics. Resolves IDs only through discovered generalist receipts. */
export function generalistRunDetail(workspace: Workspace, runId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId))
        throw new AtlasError('Invalid generalist run ID.', 'INVALID_ARGUMENT');
    const run = listGeneralistRuns(workspace).find(item => item.id === runId);
    if (!run) throw new AtlasError('Generalist run not found.', 'NOT_FOUND');
    const root = realpathSync(workspace.rootPath);
    const directory = realpathSync(path.join(root, String(run.output_dir)));
    if (!directory.startsWith(root + path.sep)) throw new AtlasError('Run directory is outside the workspace.', 'INVALID_ARGUMENT');
    const tail = (file: string, max = 64 * 1024) => {
        try {
            if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) return '';
            if (!realpathSync(file).startsWith(root + path.sep)) return '';
            const size = statSync(file).size;
            const fd = openSync(file, 'r');
            try {
                const buffer = Buffer.alloc(Math.min(size, max));
                readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
                return buffer.toString('utf8');
            } finally { closeSync(fd); }
        } catch { return ''; }
    };
    const receipts = path.join(root, 'training-driver-runs', 'atlas-generalist-operations');
    let logs = '', errors = '', logSource: string | null = null, ticket: string | null = null;
    if (existsSync(receipts)) for (const name of readdirSync(receipts).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).slice(-500)) {
        try {
            const file = path.join(receipts, name);
            if (statSync(file).size > 4096 || lstatSync(file).isSymbolicLink()) continue;
            const meta = JSON.parse(readFileSync(file, 'utf8'));
            if (meta.action !== 'generalist_train' || meta.run_id !== runId) continue;
            ticket = name.slice(0, -5);
            logs = tail(path.join(receipts, ticket + '.out'));
            errors = tail(path.join(receipts, ticket + '.err'));
            logSource = 'Atlas training launch';
            break;
        } catch {}
    }
    if (!logSource) for (const name of ['training.log', 'trainer.log', 'stdout.log', 'run.log']) {
        const file = path.join(directory, name);
        if (!existsSync(file)) continue;
        logs = tail(file); logSource = name; break;
    }
    let trainingStatus: unknown = null;
    const statusFile = path.join(directory, runId, 'run_logs', 'training_status.json');
    try {
        if (existsSync(statusFile) && !lstatSync(statusFile).isSymbolicLink() && statSync(statusFile).size < 256 * 1024)
            trainingStatus = JSON.parse(readFileSync(statusFile, 'utf8'));
    } catch {}
    // Historical and terminal-launched runs may have no captured stdout. The
    // ML-Agents status file independently persists observed steps and rewards.
    // Only use explicitly recorded measurements; never infer full completion
    // merely because a run has an exported policy or a planned step budget.
    const checkpointSamples: Array<{ step: number; reward: number }> = [];
    let checkpointSteps: number | null = null;
    if (trainingStatus && typeof trainingStatus === 'object' && !Array.isArray(trainingStatus)) {
        const behavior = (trainingStatus as Record<string, unknown>).FootballGeneralistV2;
        if (behavior && typeof behavior === 'object' && !Array.isArray(behavior)) {
            const data = behavior as { checkpoints?: unknown; final_checkpoint?: unknown };
            const records = [
                ...(Array.isArray(data.checkpoints) ? data.checkpoints.slice(-300) : []),
                data.final_checkpoint,
            ];
            for (const record of records) {
                if (!record || typeof record !== 'object') continue;
                const { steps, reward } = record as { steps?: unknown; reward?: unknown };
                if (typeof steps !== 'number' || !Number.isSafeInteger(steps) || steps < 0) continue;
                checkpointSteps = Math.max(checkpointSteps ?? 0, steps);
                if (typeof reward === 'number' && Number.isFinite(reward))
                    checkpointSamples.push({ step: steps, reward });
            }
        }
    }
    const uniqueSamples = [...new Map(checkpointSamples.map(sample => [sample.step, sample])).values()]
        .sort((a, b) => a.step - b.step);
    const savedConfiguration = tail(path.join(directory, runId, 'configuration.yaml'), 128 * 1024);
    const budgetMatch = /(?:^|\n)\s*max_steps:\s*(\d+)/.exec(savedConfiguration);
    const parsedBudget = budgetMatch ? Number(budgetMatch[1]) : null;
    const training_budget_steps = parsedBudget != null && Number.isSafeInteger(parsedBudget) && parsedBudget > 0 ? parsedBudget : null;
    return { run, ticket, logs, errors, log_source: logSource, training_status: trainingStatus, training_budget_steps,
        checkpoint_steps: checkpointSteps, checkpoint_samples: uniqueSamples,
        log_note: logSource ? 'Last 64 KiB per stream; refreshed on demand.' :
            'No saved trainer console log. Steps and rewards are recovered from ML-Agents checkpoint records when available.' };
}
