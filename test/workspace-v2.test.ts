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

test('draft PR publication rejects a workspace whose origin, branch, or HEAD does not match', async () => {
    const { catalog, store } = await databaseFixture();
    const expectedHead = 'a'.repeat(40);
    let gitStatus: Record<string, unknown> = {
        available: true, originRepository: 'affank1020/different-repository',
        branch: 'atlas/fix', head: expectedHead,
    };
    let brokerCalls = 0;
    const broker = {
        createDraftPullRequest: async () => {
            brokerCalls++;
            return { number: 19, draft: true };
        },
    } as any;
    const runtime: ExecutionHost = {
        getCapabilities: () => ['workspace.files', 'workspace.git'],
        bind: async root => root,
        execute: async (_workspace, operation) => {
            assert.equal(operation, 'workspace_git_status');
            return gitStatus;
        },
    };
    const svc = new WorkspaceService(catalog, new PostgresWorkspaceRepository(store.pool),
        new NodeRouter(new NodeService(new PostgresNodeRepository(store.pool), runtime, 'Test Node')), broker);
    const workspace: any = await svc.call('create_workspace',
        { name: 'Other repository', rootPath: '/host/pr-verify', kind: 'generic' });
    const input = {
        workspaceId: workspace.id, repository: 'affank1020/atlas',
        branch: 'atlas/fix', expectedHead, title: 'Verify origin and HEAD',
    };
    await assert.rejects(svc.call('workspace_git_open_pull_request', input), /checkout does not match/);
    gitStatus = { ...gitStatus, originRepository: 'affank1020/atlas', branch: 'atlas/other' };
    await assert.rejects(svc.call('workspace_git_open_pull_request', input), /checkout does not match/);
    gitStatus = { ...gitStatus, branch: 'atlas/fix', head: 'b'.repeat(40) };
    await assert.rejects(svc.call('workspace_git_open_pull_request', input), /checkout does not match/);
    gitStatus = { ...gitStatus, head: expectedHead, available: false };
    await assert.rejects(svc.call('workspace_git_open_pull_request', input), /checkout does not match/);
    assert.equal(brokerCalls, 0, 'The GitHub API must never be called for mismatched checkouts');

    gitStatus = { available: true, originRepository: 'AffanK1020/Atlas', branch: 'atlas/fix', head: expectedHead };
    const success = await svc.call('workspace_git_open_pull_request', input) as any;
    assert.equal(success.number, 19);
    assert.equal(brokerCalls, 1);
});
