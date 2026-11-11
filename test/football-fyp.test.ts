import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Workspace } from '../packages/protocol/src/workspace.js';
import { fypManifest, fypOperation } from '../apps/node/src/capabilities/football-fyp.js';
import { workspaceOperationSchemas } from '../packages/protocol/src/workspace-operations.js';

test('successor FYP contract is a separate 25/8 ABI and not a legacy generalist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-fyp-contract-'));
    const ws = { rootPath: root, name: 'FYP', kind: 'unity', status: 'active' } as Workspace;
    const write = async (filename: string, contents: string) => {
        const file = path.join(root, filename);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, contents);
    };
    try {
        await write('Training/atlas_contract.json', JSON.stringify({
            contract_id: 'fyp-football-v1', behavior: 'FootballV1',
            observations: { size: 25 }, actions: { continuous: 8 },
            trainer_kind: 'poca', source_project: 'affank1020/FYP',
            scene: 'Assets/Football/Scenes/OpenGoalClose.unity',
        }));
        await write('Assets/Football/Prefabs/Player.prefab',
            'VectorObservationSize: 25\nm_NumContinuousActions: 8\nm_BehaviorName: FootballV1');
        await write('Training/football_v1.yaml', 'behaviors:\n  FootballV1:\n    trainer_type: poca');
        await write('Assets/Football/Scenes/OpenGoalClose.unity', '%YAML 1.1');
        assert.equal((fypManifest(ws) as any).contract.behavior, 'FootballV1');
        assert.equal((fypManifest(ws) as any).contract.observations.size, 25);
        assert.equal((fypManifest(ws) as any).contract.actions.continuous, 8);
        await write('Training/atlas_contract.json', JSON.stringify({
            contract_id: 'football-generalist-v2', behavior: 'FootballGeneralistV2',
            observations: { size: 54 }, actions: { continuous: 5 },
            trainer_kind: 'ppo', source_project: 'affank1020/FYP',
            scene: 'Assets/Football/Scenes/OpenGoalClose.unity',
        }));
        assert.throws(() => fypManifest(ws), (err: any) => err.code === 'DRIVER_UNAVAILABLE');
        assert.throws(() => fypManifest({ ...ws, name: 'AI Football' } as Workspace),
            (err: any) => err.code === 'WORKSPACE_UNAVAILABLE');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('FYP operation refuses missing source bridge and unsafe training arguments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-fyp-operations-'));
    const ws = { rootPath: root, name: 'FYP', kind: 'unity', status: 'active' } as Workspace;
    try {
        const req = workspaceOperationSchemas.football_control.safeParse({
            workspaceId: '861c6a57-2259-400a-9d03-20bc72942b11',
            action: 'fyp_train', preset: 'pilot_100k', seed: 42, basePort: 5605,
        });
        assert.equal(req.success, true); // Node must still reject unknown presets on dispatch.
        await assert.rejects(fypOperation(ws, req.data!), (err: any) =>
            err.code === 'DRIVER_UNAVAILABLE');
        assert.equal(workspaceOperationSchemas.football_control.safeParse({
            workspaceId: '861c6a57-2259-400a-9d03-20bc72942b11',
            action: 'fyp_train', command: '/bin/sh',
        }).success, false);
    } finally { await rm(root, { recursive: true, force: true }); }
});
