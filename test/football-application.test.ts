import assert from 'node:assert/strict';
import test from 'node:test';
import { footballTrainingApplication, FootballTrainingService, FOOTBALL_PROJECT_ID } from '../apps/server/src/apps/football-training.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';

const workspace = { id: '861c6a57-2259-400a-9d03-20bc72942b11', projectId: FOOTBALL_PROJECT_ID, kind: 'unity', status: 'active', nodeId: '330f7fa0-2aba-47ed-b33f-2933c29a43ac' };
function harness({ available = true, fail = false } = {}) {
    const invocations: any[] = [];
    const audits: any[] = [];
    const catalog = { getProject: async (id: string) => { assert.equal(id, FOOTBALL_PROJECT_ID); return { id }; } };
    const repository = { list: async (id: string) => { assert.equal(id, FOOTBALL_PROJECT_ID); return available ? [workspace] : []; },
        audit: async (_ws: unknown, action: string, _client: string, meta: unknown) => { audits.push([action, meta]); } };
    const router = { execute: async (...args: any[]) => { invocations.push(args); if (fail) throw new Error('Node unavailable'); return { ok: true }; } };
    const apps = new ApplicationRegistry([footballTrainingApplication(new FootballTrainingService(catalog as any, repository as any, router as any))]);
    return { apps, invocations, audits };
}
test('football is attached only to the FYP project and registers typed MCP actions', () => {
    const { apps } = harness();
    assert.equal(apps.list(FOOTBALL_PROJECT_ID)[0].slug, 'football-training');
    assert.deepEqual(apps.list('c099839d-2d82-4ce0-956d-b098743a331d'), []);
    assert.ok(apps.hasTool('football_launch_training'));
    assert.ok(apps.hasTool('football_get_job_logs'));
});
test('football commands execute only on the bound Unity Node and audit intent', async () => {
    const { apps, invocations, audits } = harness();
    assert.deepEqual(await apps.invoke('football_launch_training', { drill: 'movement_v1', preset: 'smoke', arenas: 2, basePort: 5005, seed: 42 }), { ok: true });
    assert.equal(invocations[0][0].id, workspace.id);
    assert.equal(invocations[0][1], 'football_control');
    assert.deepEqual(invocations[0][2], { projectId: FOOTBALL_PROJECT_ID, workspaceId: workspace.id, action: 'launch_headless', drill: 'movement_v1', preset: 'smoke', arenas: 2, basePort: 5005, seed: 42 });
    assert.equal(audits[0][0], 'application.football.requested');
    assert.equal(audits[1][0], 'application.football.completed');
    await assert.rejects(apps.invoke('football_launch_training', { drill: '../other.py' }));
    assert.equal(invocations.length, 1);
});
test('an unbound or unavailable Unity Workspace cannot be used for training', async () => {
    const absent = harness({ available: false });
    await assert.rejects(absent.apps.invoke('football_list_jobs', {}), /Connect an active Unity Workspace/);
    const failed = harness({ fail: true });
    await assert.rejects(failed.apps.invoke('football_launch_training', { drill: 'movement_v1' }), /Node unavailable/);
    assert.equal(failed.audits[failed.audits.length - 1][0], 'application.football.failed');
});
