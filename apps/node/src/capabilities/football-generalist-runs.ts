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
                    started_at: statSync(full).birthtime.toISOString(),
                    state: states.get(name) ?? 'unknown', // External runs remain unknown without a verified Atlas launch receipt.
                    checkpoints: existsSync(path.join(dir, name)) ? readdirSync(path.join(dir, name)).filter(file => file.endsWith('.onnx')).length : 0,
                    checkpoint_files: existsSync(path.join(dir, name)) ? readdirSync(path.join(dir, name))
                        .filter(file => file.endsWith('.onnx')).map(file => path.relative(workspace.rootPath, path.join(dir, name, file))) : [],
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
    const savedConfiguration = tail(path.join(directory, runId, 'configuration.yaml'), 128 * 1024);
    const budgetMatch = /(?:^|\n)\s*max_steps:\s*(\d+)/.exec(savedConfiguration);
    const parsedBudget = budgetMatch ? Number(budgetMatch[1]) : null;
    const training_budget_steps = parsedBudget != null && Number.isSafeInteger(parsedBudget) && parsedBudget > 0 ? parsedBudget : null;
    return { run, ticket, logs, errors, log_source: logSource, training_status: trainingStatus, training_budget_steps,
        log_note: logSource ? 'Last 64 KiB per stream; refreshed on demand.' :
            'No saved text trainer log is available for this run. Terminal-launched runs may not capture stdout.' };
}
