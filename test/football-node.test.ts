import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { footballControl } from '../apps/node/src/capabilities/football.js';

function workspace(rootPath: string) {
    return { id: '09bd8b0b-41be-4b78-a649-a71ce5f08520',
        projectId: 'ce09dbe0-0755-4bd8-9376-e4a3152d59f7',
        nodeId: '9eb6659d-69c4-4d40-9788-098e5ff6a2fb',
        kind: 'unity', status: 'active', rootPath } as any;
}
const input = { projectId: 'ce09dbe0-0755-4bd8-9376-e4a3152d59f7',
    workspaceId: '09bd8b0b-41be-4b78-a649-a71ce5f08520' };
test('Node football bridge rejects unvalidated CLI arguments and unbound driver files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-football-'));
    try {
        await assert.rejects(footballControl(workspace(root), { ...input, action: 'jobs', command: 'rm -rf /' }));
        await assert.rejects(footballControl(workspace(root), { ...input, action: 'evaluation_detail', evaluationId: '../etc/passwd' }));
        await assert.rejects(footballControl(workspace(root), { ...input, action: 'evaluation_detail', evaluationId: 'eval_valid', offset: -1 }));
        await assert.rejects(footballControl(workspace(root), { ...input, action: 'evaluation_detail', evaluationId: 'eval_valid', limit: 201 }));
        await assert.rejects(footballControl(workspace(root), { ...input, action: 'evaluate_baseline', baselineMode: 'evil' }));
        await assert.rejects(footballControl(workspace(root), { ...input, action: 'evaluate_baseline', baselineMode: 'forward', replayEpisode: 5, episodes: 100 }), (e: any) => e.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(workspace(root), { ...input, action: 'evaluate', policyId: 'policy_valid', replayEpisode: 5, episodes: 100 }), (e: any) => e.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(workspace(root), { ...input, action: 'launch_headless', drill: '../escape' }));
        await assert.rejects(footballControl(workspace(root), { ...input, action: 'jobs' }), (e: any) => e.code === 'DRIVER_UNAVAILABLE');
        const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'atlas-football-script-'));
        try {
            await writeFile(path.join(elsewhere, 'python.py'), 'print("hello")');
            await symlink(path.join(elsewhere, 'python.py'), path.join(root, 'football_driver.py'));
            await assert.rejects(footballControl(workspace(root), { ...input, action: 'jobs' }), (e: any) => e.code === 'DRIVER_UNAVAILABLE');
        } finally { await rm(elsewhere, { recursive: true, force: true }); }
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('evaluation receipt parses a JSON result above the displayed output cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-football-evalreceipt-'));
    try {
        await writeFile(path.join(root, 'football_driver.py'), 'print("stub")\n');
        const evaluations = path.join(root, 'training-driver-runs', 'atlas-evaluation-launches');
        await mkdir(evaluations, { recursive: true });
        await writeFile(path.join(evaluations, 'longrun.json'), JSON.stringify({ pid: 9999999, startedAt: '2026-10-10T12:00:00Z' }));
        const results = { id: 'eval_20261010_long', results: { episode_results: Array.from({ length: 1500 }, (_, i) => ({ index: i, metadata: 'x'.repeat(100) })) } };
        await writeFile(path.join(evaluations, 'longrun.out'), JSON.stringify(results));
        const receipt: any = await footballControl(workspace(root), { ...input, action: 'evaluation_status', runId: 'longrun' });
        assert.equal(receipt.state, 'completed');
        assert.equal(receipt.run.id, results.id);
        assert.ok(receipt.output.length <= 5000);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('Node bridge reads launch receipts without requiring a running Unity or Python environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-football-receipt-'));
    try {
        await writeFile(path.join(root, 'football_driver.py'), 'print("stub")\n');
        const launches = path.join(root, 'training-driver-runs', 'atlas-launches');
        await mkdir(launches, { recursive: true });
        await writeFile(path.join(launches, 'example.json'), JSON.stringify({ pid: 9999999, drill: 'movement_v1', startedAt: '2026-10-09T20:00:00Z' }));
        await writeFile(path.join(launches, 'example.out'), JSON.stringify({ id: 'movement_v1_2026', state: 'running' }));
        await writeFile(path.join(launches, 'example.err'), '');
        const result: any = await footballControl(workspace(root), { ...input, action: 'launch_status', runId: 'example' });
        assert.equal(result.state, 'submitted');
        assert.equal(result.run.id, 'movement_v1_2026');
        await assert.rejects(footballControl(workspace(root), { ...input, action: 'launch_status', runId: '../config' }));
    } finally { await rm(root, { recursive: true, force: true }); }
});
