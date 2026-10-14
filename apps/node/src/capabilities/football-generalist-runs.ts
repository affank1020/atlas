import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
                result.push({
                    id: name, family: 'generalist', drill: 'generalist', scenario: receipt.scenario,
                    preset: receipt.preset ?? null, seed: receipt.seed, arenas: receipt.arenas,
                    num_envs: receipt.num_envs, contract_sha256: receipt.contract_sha256,
                    scenario_sha256: receipt.scenario_sha256, implementation_sha256: receipt.implementation_sha256,
                    binary: receipt.binary, output_dir: path.relative(workspace.rootPath, dir),
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
