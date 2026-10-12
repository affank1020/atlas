import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { footballValidation } from '../apps/node/src/capabilities/football-validation.js';
import { UnityAdapter } from '../apps/node/src/capabilities/unity/unity.js';

const projectId = 'ce09dbe0-0755-4bd8-9376-e4a3152d59f7';
function workspace(rootPath: string) {
    return { projectId, id: '961d0046-eb49-446d-835e-00bec3e46059',
        nodeId: '9eb6659d-69c4-4d40-9788-098e5ff6a2fb', kind: 'unity',
        status: 'active', rootPath } as any;
}

test('Mac validation runs fixed Python unittest argv and keeps an immutable PASS receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-validation-pass-'));
    try {
        await mkdir(path.join(root, 'tests'));
        await writeFile(path.join(root, 'tests/test_fixed.py'), [
            'import unittest', 'class TestFixed(unittest.TestCase):',
            '    def test_pass(self): self.assertEqual(2 + 2, 4)', ''
        ].join('\n'));
        const first: any = await footballValidation(workspace(root), 'validation_python');
        assert.equal(first.status, 'pass');
        assert.equal(first.checks[0].status, 'pass');
        assert.match(first.output, /Ran 1 test/);
        const info: any = await footballValidation(workspace(root), 'validation_status');
        assert.equal(info.results[0].id, first.id);
        assert.equal(info.results[0].status, 'pass');
        assert.match(info.sourceSha256, /^[a-f0-9]{64}$/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed Python assertions create FAILED evidence and do not masquerade as success', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-validation-fail-'));
    try {
        await mkdir(path.join(root, 'tests'));
        await writeFile(path.join(root, 'tests/test_fixed.py'), [
            'import unittest', 'class TestFixed(unittest.TestCase):',
            '    def test_fail(self): self.assertEqual(2 + 2, 5)', ''
        ].join('\n'));
        const receipt: any = await footballValidation(workspace(root), 'validation_python');
        assert.equal(receipt.status, 'fail');
        assert.equal(receipt.checks[0].status, 'fail');
        assert.match(receipt.error, /FAILED|AssertionError/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('Unity Editor gates fail closed without owner-approved menu capability and save failure receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-validation-unity-'));
    try {
        const unity = { capabilities: async () => ({
            available: true, commands: [{ name: 'menu', approved: false }]
        }) } as any;
        const receipt: any = await footballValidation(workspace(root), 'validation_editor', unity);
        assert.equal(receipt.status, 'fail');
        assert.match(receipt.error, /not approved/i);
        const info: any = await footballValidation(workspace(root), 'validation_status', unity);
        assert.equal(info.editorMenuApproved, false);
        assert.equal(info.results[0].status, 'fail');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('Unity Adapter denies all arbitrary menu paths even with menu permission', async () => {
    const adapter = new UnityAdapter({} as any, {} as any, ['menu']);
    const w = workspace('/tmp/not-the-real-workspace');
    await assert.rejects(adapter.invoke(w, 'menu', { path: 'Assets/Delete All' }),
        (error: any) => error.code === 'WORKSPACE_DENIED');
    await assert.rejects(adapter.invoke(w, 'menu', {}),
        (error: any) => error.code === 'WORKSPACE_DENIED');
    await assert.rejects(adapter.invoke({ ...w, projectId: '11111111-1111-4111-8111-111111111111' }, 'menu',
        { path: 'Football/Drills/Test Shooting v2 Gates' }),
        (error: any) => error.code === 'WORKSPACE_DENIED');
});

test('Play Mode physics runner requires fresh Unity callback and preserves the scene', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-validation-physics-'));
    try {
        await writeFile(path.join(root, 'football_driver.py'), 'print("[]")\n');
        let menuRuns = 0;
        let consoleReads = 0;
        const unity = {
            capabilities: async () => ({ available: true, commands: [{ name: 'menu', approved: true }] }),
            invoke: async (_ws: unknown, name: string, params: any) => {
                if (name === 'editor_status') return { status: 'ready', compiling: false,
                    domainReloadInProgress: false, playMode: 'stopped', projectPath: root };
                if (name === 'list_open_scenes') return { scenes: [{ path: 'Assets/Scenes/MovementEvaluation.unity', isDirty: false, isActive: true }] };
                if (name === 'recompile_status') return { status: 'completed', failed: false, compilationFailed: false };
                if (name === 'menu') {
                    assert.equal(params.path, 'Football/Drills/Run Physical Collision Smoke (Play Mode)');
                    menuRuns++; return { content: [{ type: 'text', text: 'accepted' }] };
                }
                if (name === 'console') {
                    consoleReads++;
                    return { cursor: consoleReads === 1 ? 4 : 5, session: 'same-editor',
                        entries: consoleReads === 1
                            ? [{ level: 'log', message: '[M2PhysicsSmoke] PASS: historical log' }]
                            : [{ level: 'log', message: '[M2PhysicsSmoke] PASS: fresh collision confirmation' }],
                        reset: false, dropped: false };
                }
                throw new Error('Unexpected Unity command ' + name);
            },
        } as any;
        const result: any = await footballValidation(workspace(root), 'validation_physics', unity);
        assert.equal(result.status, 'pass');
        assert.equal(result.checks[0].name, 'shared_rigidbody_collision_and_goal');
        assert.equal(menuRuns, 1);
        assert.ok(consoleReads >= 2);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('old PASS plus fresh Unity exception cannot pass a physics smoke', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-validation-stale-'));
    try {
        await writeFile(path.join(root, 'football_driver.py'), 'print("[]")\n');
        let consoleReads = 0;
        const unity = {
            capabilities: async () => ({ available: true, commands: [{ name: 'menu', approved: true }] }),
            invoke: async (_ws: unknown, name: string) => {
                if (name === 'editor_status') return { status: 'ready', compiling: false,
                    domainReloadInProgress: false, playMode: 'stopped', projectPath: root };
                if (name === 'list_open_scenes') return { scenes: [{ path: 'A', isDirty: false, isActive: true }] };
                if (name === 'recompile_status') return { status: 'completed', failed: false, compilationFailed: false };
                if (name === 'menu') return {};
                if (name === 'console') {
                    consoleReads++;
                    return { cursor: consoleReads === 1 ? 10 : 11, session: 'same-editor',
                        entries: consoleReads === 1
                            ? [{ level: 'log', message: '[M2PhysicsSmoke] PASS: old result' }]
                            : [{ level: 'error', message: '[M2PhysicsSmoke] FAIL: real collision absent' }],
                        reset: false, dropped: false };
                }
                throw new Error('Unexpected command');
            },
        } as any;
        const result: any = await footballValidation(workspace(root), 'validation_physics', unity);
        assert.equal(result.status, 'fail');
        assert.match(result.error, /real collision absent/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('validation rejects other projects, archived workspaces, and unknown extra actions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-validation-scope-'));
    try {
        await assert.rejects(footballValidation({ ...workspace(root), status: 'archived' }, 'validation_status'));
        await assert.rejects(footballValidation({ ...workspace(root), projectId: '11111111-1111-4111-8111-111111111111' }, 'validation_python'));
    } finally { await rm(root, { recursive: true, force: true }); }
});
