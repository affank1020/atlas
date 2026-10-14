import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '@atlas/protocol/workspace';

/** Discover generalist experiments without relying on the legacy trainer index. */
export function listGeneralistRuns(workspace: Workspace) {
    const root = path.join(workspace.rootPath, 'training-driver-runs');
    if (!existsSync(root)) return [];
    const result: Record<string, unknown>[] = [];
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
                    state: 'unknown', // A receipt proves launch intent, never completion or live process health.
                    checkpoints: existsSync(path.join(dir, name)) ? readdirSync(path.join(dir, name)).filter(file => file.endsWith('.onnx')).length : 0,
                });
            } catch { /* malformed or inaccessible receipts are ignored */ }
        }
    };
    visit(root, 0);
    return result.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}
