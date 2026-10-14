import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { footballControl } from '../apps/node/src/capabilities/football.js';

const input = { projectId: 'ce09dbe0-0755-4bd8-9376-e4a3152d59f7', workspaceId: '09bd8b0b-41be-4b78-a649-a71ce5f08520' };
const ws = (rootPath: string) => ({ ...input, nodeId: '9eb6659d-69c4-4d40-9788-098e5ff6a2fb', id: input.workspaceId, kind: 'unity', status: 'active', rootPath }) as any;

test('generalist run discovery indexes receipts independently from legacy driver', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-generalist-'));
    try {
        const dir = path.join(root, 'training-driver-runs', 'external-generalist');
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'generalist-run.json'), JSON.stringify({
            family: 'generalist', mode: 'train', run_id: 'external-run-42',
            scenario: 's0-contact-easy-v1', seed: 42, num_envs: 2, contract_sha256: 'abc',
        }));
        const result = await footballControl(ws(root), { ...input, action: 'generalist_runs' }) as any[];
        assert.equal(result.length, 1);
        assert.equal(result[0].id, 'external-run-42');
        assert.equal(result[0].num_envs, 2);
        assert.equal(result[0].state, 'unknown');
        assert.equal(result[0].family, 'generalist');
        await writeFile(path.join(dir, 'another.json'), JSON.stringify({ family: 'legacy' }));
        assert.equal((await footballControl(ws(root), { ...input, action: 'generalist_runs' }) as any[]).length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('generalist operations fail closed for missing scripts, invalid scenarios and invalid receipt identifiers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-generalist-'));
    try {
        await mkdir(path.join(root, 'ml-agents/config'), { recursive: true });
        await mkdir(path.join(root, 'Assets/Resources/Generalist'), { recursive: true });
        await writeFile(path.join(root, 'ml-agents/config/football_generalist_v2_contract.json'), JSON.stringify({
            contract_id: 'football-generalist-v2', behavior: 'FootballGeneralistV2',
            observations: { size: 54, fields: [] }, actions: { continuous: 5, channels: [] },
        }));
        await writeFile(path.join(root, 'Assets/Resources/Generalist/scenarios.json'), JSON.stringify({
            sceneVersion: 's2', physicsVersion: 'p2', scenarios: [{ id: 's0-contact-easy-v1' }],
        }));
        await writeFile(path.join(root, 'ml-agents/config/generalist_curriculum.json'), JSON.stringify({
            stages: [{ id: 'S0' }], held_out_seeds: [515],
        }));
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_train', scenario: 'bogus', preset: 'smoke', seed: 42 }), (e: any) => e.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_train', scenario: 'mix', preset: 'smoke', seed: 515 }), (e: any) => e.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_train', scenario: 'mix', preset: 'smoke', seed: 42 }));
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_status', runId: '../secret' }));
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_watch', policyId: 'legacy-policy', scenario: 'mix' }));
    } finally { await rm(root, { recursive: true, force: true }); }
});
