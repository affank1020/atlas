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
