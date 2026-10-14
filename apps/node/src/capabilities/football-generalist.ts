import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { AtlasError } from '@atlas/protocol/errors';
import type { Workspace } from '@atlas/protocol/workspace';

const INPUTS = {
    contract: 'ml-agents/config/football_generalist_v2_contract.json',
    scenarios: 'Assets/Resources/Generalist/scenarios.json',
    curriculum: 'ml-agents/config/generalist_curriculum.json',
} as const;

function safeJson(workspace: Workspace, relative: string): { data: any; sha256: string } {
    const root = realpathSync(workspace.rootPath);
    const target = path.join(root, relative);
    const canonical = realpathSync(target);
    if (!canonical.startsWith(root + path.sep) || lstatSync(target).isSymbolicLink() || !statSync(canonical).isFile() || statSync(canonical).size > 128 * 1024)
        throw new AtlasError('Invalid generalist metadata source.', 'INVALID_ARGUMENT');
    const raw = readFileSync(canonical);
    return { data: JSON.parse(raw.toString('utf8')), sha256: createHash('sha256').update(raw).digest('hex') };
}

/** Inspect the canonical Unity project metadata. Does not execute Unity, Python or training. */
export function generalistManifest(workspace: Workspace) {
    if (workspace.kind !== 'unity' || workspace.status !== 'active')
        throw new AtlasError('Generalist metadata requires an active Unity Workspace.', 'WORKSPACE_UNAVAILABLE');
    try {
        const contract = safeJson(workspace, INPUTS.contract);
        const scenarios = safeJson(workspace, INPUTS.scenarios);
        const curriculum = safeJson(workspace, INPUTS.curriculum);
        const c = contract.data, s = scenarios.data, k = curriculum.data;
        if (c?.contract_id !== 'football-generalist-v2' || c?.observations?.size !== 54 ||
            c?.actions?.continuous !== 5 || c?.behavior !== 'FootballGeneralistV2' ||
            !Array.isArray(c?.observations?.fields) || !Array.isArray(c?.actions?.channels) ||
            !Array.isArray(s?.scenarios) || !Array.isArray(k?.stages) ||
            typeof s?.physicsVersion !== 'string' || typeof s?.sceneVersion !== 'string')
            throw new Error('Invalid generalist metadata schema');
        return {
            available: true,
            source: 'unity-workspace',
            contract: c, scenarios: s, curriculum: k,
            fingerprints: { contract_sha256: contract.sha256, scenario_sha256: scenarios.sha256, curriculum_sha256: curriculum.sha256 },
            // Implementation fingerprint must come from the canonical runner; these are source-file hashes only.
            provenance: 'working_tree_metadata_not_policy_validation',
        };
    } catch (error) {
        if (error instanceof AtlasError) throw error;
        throw new AtlasError('Generalist metadata is missing or not yet compatible with Atlas. ' +
            (error instanceof Error && error.message === 'Invalid generalist metadata schema' ? error.message : ''), 'DRIVER_UNAVAILABLE');
    }
}
