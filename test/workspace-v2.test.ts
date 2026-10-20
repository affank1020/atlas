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

test('managed worktree creation auto-registers an independent Workspace and removal archives it', async t => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { LocalNodeRuntime } = await import('../apps/node/src/platforms/desktop/runtime.js');
    const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-workspace-managed-')));
    const original = process.env.ATLAS_GIT_TRUSTED_ROOTS;
    process.env.ATLAS_GIT_TRUSTED_ROOTS = parent;
    t.after(() => {
        if (original === undefined) delete process.env.ATLAS_GIT_TRUSTED_ROOTS;
        else process.env.ATLAS_GIT_TRUSTED_ROOTS = original;
        rmSync(parent, { recursive: true, force: true });
    });
    const source = path.join(parent, 'source');
    mkdirSync(source);
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.test');
    writeFileSync(path.join(source, 'README.md'), 'initial');
    git('add', 'README.md'); git('commit', '-m', 'initial');

    const { catalog, store } = await databaseFixture();
    const runtime = new LocalNodeRuntime([parent], new Map(), 'linux');
    const svc = new WorkspaceService(catalog, new PostgresWorkspaceRepository(store.pool),
        new NodeRouter(new NodeService(new PostgresNodeRepository(store.pool), runtime, 'Test Node')));
    const originalWorkspace: any = await svc.call('create_workspace',
        { name: 'Main checkout', rootPath: source, kind: 'generic' });
    const dest = path.join(parent, 'feature-checkout');
    const created: any = await svc.call('workspace_git_create_worktree', {
        workspaceId: originalWorkspace.id, name: 'Feature checkout',
        branch: 'atlas/test-feature', targetPath: dest,
    });
    assert.equal(created.workspace.rootPath, dest);
    assert.equal(created.workspace.name, 'Feature checkout');
    assert.notEqual(created.workspace.id, originalWorkspace.id);
    const entries: any = await svc.call('workspace_git_list_worktrees', { workspaceId: originalWorkspace.id });
    assert.equal(entries.worktrees.length, 2);
    const registered: any[] = await svc.call('list_workspaces', {});
    assert.equal(registered.length, 2);

    const removed: any = await svc.call('workspace_git_remove_worktree', {
        workspaceId: originalWorkspace.id, targetWorkspaceId: created.workspace.id,
        expectedHead: created.head,
    });
    assert.equal(removed.preservedBranch, 'atlas/test-feature');
    assert.equal((await svc.call('list_workspaces', {}) as any[]).length, 1);
    assert.equal((await svc.call('list_workspaces', { includeArchived: true }) as any[]).length, 2);
    assert.equal(git('rev-parse', 'refs/heads/atlas/test-feature'), created.head);
});

test('authenticated repository cloning registers the new Workspace without exposing tokens', async () => {
    const { catalog, store } = await databaseFixture();
    const repository = 'affank1020/atlas';
    const credential = 'ghs_readonly_test_only_credential';
    let observedToken = '';
    const runtime: ExecutionHost = {
        getCapabilities: () => ['workspace.files', 'workspace.git'],
        bind: async root => root,
        execute: async (_workspace, operation, input) => {
            assert.equal(operation, 'workspace_git_clone_repository');
            observedToken = input.githubToken;
            return { rootPath: '/trusted/checkout', repository,
                head: 'a'.repeat(40), branch: 'main' };
        },
    };
    const broker = { repositoryReadToken: async (requested: string) => {
        assert.equal(requested, repository);
        return credential;
    } } as any;
    const svc = new WorkspaceService(catalog, new PostgresWorkspaceRepository(store.pool),
        new NodeRouter(new NodeService(new PostgresNodeRepository(store.pool), runtime, 'Test Node')), broker);
    const managerProject = await catalog.createProject({ name: 'Infrastructure manager' });
    const parent: any = await svc.call('create_workspace',
        { projectId: managerProject.id, name: 'Trusted development root', rootPath: '/trusted', kind: 'generic' });
    await assert.rejects(svc.call('workspace_git_clone_repository', {
        workspaceId: parent.id, repository, directoryName: 'checkout', githubToken: credential,
    }), /Unrecognized key/);
    const created: any = await svc.call('workspace_git_clone_repository', {
        workspaceId: parent.id, repository, directoryName: 'checkout', name: 'Atlas clone',
    });
    assert.equal(observedToken, credential);
    assert.equal(created.workspace.rootPath, '/trusted/checkout');
    assert.equal(created.workspace.name, 'Atlas clone');
    assert.equal(created.workspace.projectId, null, 'New repositories must not inherit their manager directory Project');
    assert.equal((await svc.call('list_project_workspaces', { projectId: managerProject.id }) as any[]).length, 1);
    assert.equal((await svc.call('list_workspaces', {}) as any[]).length, 2);
    const history = await catalog.auditHistory({ workspaceId: parent.id });
    assert.equal(JSON.stringify(history).includes(credential), false);
});
