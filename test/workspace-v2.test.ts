import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture, cleanupDatabases } from './database.js';
import { WorkspaceService } from '../apps/server/src/workspaces/application.js';
import { PostgresWorkspaceRepository } from '../apps/server/src/infrastructure/database/workspaces.js';
import { PostgresNodeRepository } from '../apps/server/src/infrastructure/database/nodes.js';
import { NodeRouter } from '../apps/server/src/nodes/router.js';
import { NodeService } from '../apps/server/src/nodes/service.js';
import type { ExecutionHost } from '../apps/server/src/workspaces/runtime.js';

after(cleanupDatabases);

test('Workspace V2 supports Project-independent registration and multiple optional Project links', async () => {
    const { catalog, store } = await databaseFixture();
    const p1 = await catalog.createProject({ name: 'Research' });
    const p2 = await catalog.createProject({ name: 'Portfolio' });
    const runtime: ExecutionHost = {
        getCapabilities: () => ['workspace.files', 'workspace.git'],
        bind: async requested => requested,
        execute: async (_workspace, operation) => ({ operation, result: 'ok' }),
    };
    const repo = new PostgresWorkspaceRepository(store.pool);
    const svc = new WorkspaceService(catalog, repo, new NodeRouter(new NodeService(
        new PostgresNodeRepository(store.pool), runtime, 'Test Node')));

    // Node owns its Workspace independent of any Project.
    const ws: any = await svc.call('create_workspace', {
        name: 'Standalone checkout', rootPath: '/host/v2/repo', kind: 'generic' });
    assert.equal(ws.projectId, null);
    assert.equal((await svc.call('get_workspace', { workspaceId: ws.id }) as any).id, ws.id);
    assert.equal((await svc.call('list_workspaces', {}) as any[]).length, 1);
    assert.equal((await svc.call('list_project_workspaces', { projectId: p1.id }) as any[]).length, 0);

    // Workspace-scoped operations no longer need Project IDs.
    const result = await svc.call('workspace_read_file', { workspaceId: ws.id, path: 'README.md' });
    assert.deepEqual(result, { operation: 'workspace_read_file', result: 'ok' });

    // A workspace can appear in multiple Projects without changing its ID or Node.
    await svc.call('link_workspace_project', { projectId: p1.id, workspaceId: ws.id });
    await svc.call('link_workspace_project', { projectId: p2.id, workspaceId: ws.id });
    assert.equal((await svc.call('list_project_workspaces', { projectId: p1.id }) as any[])[0].id, ws.id);
    assert.equal((await svc.call('list_project_workspaces', { projectId: p2.id }) as any[])[0].id, ws.id);

    await svc.call('unlink_workspace_project', { projectId: p1.id, workspaceId: ws.id });
    assert.equal((await svc.call('list_project_workspaces', { projectId: p1.id }) as any[]).length, 0);
    assert.equal((await svc.call('list_project_workspaces', { projectId: p2.id }) as any[]).length, 1);
    assert.equal((await svc.call('get_workspace', { workspaceId: ws.id }) as any).projectId, p2.id);
});
