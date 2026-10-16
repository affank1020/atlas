import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const dribblingBenchmarks = [
    { id: 'close_control', label: 'Close control · 3m', scenario: 's1-dribble-3m-v1', skill: 'dribbling' },
    { id: 'directional', label: 'Sharp directional control', scenario: 's1-dribble-directional-challenge-v1', skill: 'dribbling' },
    { id: 'near_reversal', label: 'Near-reversal control', scenario: 's1-dribble-directional-reversal-v1', skill: 'dribbling' },
    { id: 'moving_ball', label: 'Moving-ball interception & control', scenario: 's1-dribble-moving-interception-v1', skill: 'receiving' },
] as const;

type Curated = { display_name?: string; featured?: boolean };
export type Curation = Record<string, Curated>;
export function readCuration(root: string): Curation {
    const file = path.join(root, 'validation', 'generalist', 'policy-curation.json');
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return {};
    try {
        const text = readFileSync(file, 'utf8');
        if (text.length > 65536) return {};
        const obj = JSON.parse(text);
        return obj && obj.schema_version === 1 && obj.policies &&
            typeof obj.policies === 'object' && !Array.isArray(obj.policies)
            ? obj.policies : {};
    } catch { return {}; }
}
export function writeCuration(root: string, policyId: string, update: Curated) {
    const file = path.join(root, 'validation', 'generalist', 'policy-curation.json');
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Unsafe policy-curation file.');
    const next = readCuration(root);
    const previous = next[policyId] ?? {};
    next[policyId] = { ...previous, ...update };
    // One small file, same directory, atomic replacement. No changes to policy.json,
    // ONNX, bundle, training or evaluation evidence.
    const tmp = path.join(path.dirname(file), '.policy-curation-' + randomUUID() + '.tmp');
    writeFileSync(tmp, JSON.stringify({ schema_version: 1, policies: next }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
    return next[policyId];
}

export type SavedAssessment = { ticket: string; policy_id: string; scenario: string;
    seed: number | null; episodes: Array<{ success: boolean; seed?: number }> };
export function deriveAssessments(policies: Array<{ id: string; source_policy_id?: string | null; onnx_sha256?: string | null }>,
    records: SavedAssessment[]) {
    const hashOf = new Map(policies.map(p => [p.id, p.onnx_sha256]));
    const source = new Map(policies.map(p => [p.id, p.source_policy_id ?? p.id]));
    return policies.map(policy => {
        const canonical = source.get(policy.id) ?? policy.id;
        const fingerprint = policy.onnx_sha256 ?? null;
        const matching = records.filter(r => {
            if (!hashOf.has(r.policy_id)) return false;
            return fingerprint && hashOf.get(r.policy_id) === fingerprint ||
                r.policy_id === policy.id || r.policy_id === canonical;
        });
        return { policy_id: policy.id, canonical_policy_id: canonical, model_sha256: fingerprint,
            suite_id: 'dribbling-assessment-v1',
            benchmarks: dribblingBenchmarks.map(b => {
                const subset = matching.filter(r => r.scenario === b.scenario);
                const seen = new Set<string>();
                const distinct = subset.filter(r => !seen.has(r.ticket) && !!seen.add(r.ticket));
                const episodes = distinct.flatMap(r => r.episodes);
                const total = episodes.length;
                const successes = episodes.filter(e => e.success).length;
                // Old Atlas receipts omitted their requested seed, but Unity persisted the
                // actual seed on each episode. Prefer observed episode seeds, falling back
                // to the receipt only for older reports without per-episode provenance.
                const isSeed = (seed: unknown): seed is number =>
                    typeof seed === 'number' && Number.isSafeInteger(seed) && seed >= 0 && seed <= 2147483647;
                const recordedSeeds = new Set<number>();
                for (const record of distinct) {
                    const episodeSeeds = record.episodes.map(e => e.seed).filter(isSeed);
                    if (episodeSeeds.length) episodeSeeds.forEach(seed => recordedSeeds.add(seed));
                    else if (isSeed(record.seed)) recordedSeeds.add(record.seed);
                }
                return { ...b, total, successes, rate: total ? successes / total : null,
                    ticketCount: distinct.length, seeds: [...recordedSeeds].sort((a, b) => a - b),
                    tickets: distinct.map(x => x.ticket),
                    // Historical drills have been used for development; do not automatically certify.
                    status: total > 0 ? 'provisional' as const : 'not_assessed' as const };
            }) };
    });
}
