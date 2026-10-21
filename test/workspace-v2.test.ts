import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture, cleanupDatabases } from './database.js';
import { WorkspaceService } from '../apps/server/src/workspaces/application.js';
import { PostgresWorkspaceRepository } from '../apps/server/src/infrastructure/database/workspaces.js';
import { PostgresNodeRepository } from '../apps/server/src/infrastructure/database/nodes.js';
import { NodeRouter } from '../apps/server/src/nodes/router.js';
import { NodeService } from '../apps/server/src/nodes/service.js';
import type { ExecutionHost } from '../apps/server/src/workspaces/runtime.js';
import { nodeRequestSchema, validateNodeOperation } from '../packages/protocol/src/node-protocol.js';

after(cleanupDatabases);

test('migration 019 backfills logical Workspace IDs without modifying legacy checkout identity', async () => {
    const { readFile } = await import('node:fs/promises');
    const { randomUUID } = await import('node:crypto');
    const { catalog, store } = await databaseFixture('018_atlas_files.sql');
    const project = await catalog.createProject({ name: 'Pre-migration project' });
    const node = (await store.pool.query("SELECT id FROM nodes WHERE local_key='local'")).rows[0].id;
    const checkoutId = randomUUID();
    await store.pool.query(
        `INSERT INTO workspaces(id,project_id,name,root_path,kind,adapter,node_id)
         VALUES($1,$2,'Portfolio Site','/old/portfolio','generic',NULL,$3)`,
        [checkoutId, project.id, node]);
    await store.pool.query(await readFile('apps/server/migrations/019_logical_workspaces.sql', 'utf8'));
    const repository = new PostgresWorkspaceRepository(store.pool);
    const checkout = await repository.getById(checkoutId);
    assert.equal(checkout.logicalWorkspaceId, checkoutId);
    assert.equal(checkout.rootPath, '/old/portfolio');
    assert.equal(checkout.nodeId, node);
    assert.equal(checkout.projectId, project.id);
    const logical = await repository.listLogical();
    assert.equal(logical.length, 1);
    assert.equal(logical[0].id, checkoutId);
    assert.equal(logical[0].checkouts[0].id, checkoutId);
});

test('Workspace V2 supports Project-independent registration and multiple optional Project links', async () => {
    const { catalog, store } = await databaseFixture();
    const p1 = await catalog.createProject({ name: 'Research' });
    const p2 = await catalog.createProject({ name: 'Portfolio' });
    const runtime: ExecutionHost = {
        getCapabilities: () => ['workspace.files', 'workspace.git'],
        bind: async requested => requested,
        execute: async (checkout, operation) => {
            assert.equal(Object.hasOwn(checkout, 'logicalWorkspaceId'), false,
                'Node v2 must not receive the new server-side logical ID');
            return { operation, result: 'ok' };
        },
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

test('renaming a single-checkout local Workspace updates its logical browser name', async () => {
    const { catalog, store } = await databaseFixture();
    const runtime: ExecutionHost = {
        getCapabilities: () => ['workspace.files', 'workspace.git'],
        bind: async root => root,
        execute: async () => ({ available: false }),
    };
    const svc = new WorkspaceService(catalog, new PostgresWorkspaceRepository(store.pool),
        new NodeRouter(new NodeService(new PostgresNodeRepository(store.pool), runtime, 'Test Node')));
    const ws: any = await svc.call('create_workspace', {
        name: 'Old name', rootPath: '/trusted/rename-test', kind: 'generic',
    });
    assert.equal((await svc.call('list_logical_workspaces', {}) as any[])[0].name, 'Old name');
    const updated: any = await svc.call('update_workspace', { workspaceId: ws.id, name: 'New name' });
    assert.equal(updated.name, 'New name');
    const groups = await svc.call('list_logical_workspaces', {}) as any[];
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, 'New name');
    assert.equal(groups[0].checkouts[0].name, 'New name');
    assert.equal(groups[0].id, ws.logicalWorkspaceId);
    assert.equal((await svc.call('get_workspace', { workspaceId: ws.id }) as any).name, 'New name');
});

test('local logical rename follows visible singleton when other checkouts were archived', async () => {
    const { catalog, store } = await databaseFixture();
    const repository = new PostgresWorkspaceRepository(store.pool);
    const runtime: ExecutionHost = {
        getCapabilities: () => ['workspace.files', 'workspace.git'],
        bind: async root => root,
        execute: async () => ({ available: false }),
    };
    const svc = new WorkspaceService(catalog, repository,
        new NodeRouter(new NodeService(new PostgresNodeRepository(store.pool), runtime, 'Test Node')));
    const source: any = await svc.call('create_workspace', {
        name: 'Original', rootPath: '/trusted/archive-rename/source', kind: 'generic',
    });
    const db = await repository.connect();
    let feature: any;
    try {
        await db.begin();
        feature = await db.insert({
            nodeId: source.nodeId, logicalWorkspaceId: source.logicalWorkspaceId,
            name: 'Feature checkout', rootPath: '/trusted/archive-rename/feature', kind: 'generic',
        });
        await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
    await svc.call('update_workspace', { workspaceId: source.id, name: 'Checkout renamed' });
    assert.equal((await svc.call('list_logical_workspaces', {}) as any[])[0].name, 'Original',
        'Renaming one of two ACTIVE local checkouts must not rename the logical group');
    await svc.call('archive_workspace', { workspaceId: feature.id });
    let groups = await svc.call('list_logical_workspaces', {}) as any[];
    assert.equal(groups[0].checkouts.length, 1, 'Archived siblings are hidden by default');
    await svc.call('update_workspace', { workspaceId: source.id, name: 'Visible singleton' });
    groups = await svc.call('list_logical_workspaces', {}) as any[];
    assert.equal(groups[0].name, 'Visible singleton');
    assert.deepEqual(groups[0].checkouts.map((checkout: any) => checkout.id), [source.id]);
    const history = await svc.call('list_logical_workspaces', { includeArchived: true }) as any[];
    assert.equal(history[0].name, 'Visible singleton');
    assert.deepEqual(history[0].checkouts.map((checkout: any) => checkout.id).sort(),
        [source.id, feature.id].sort(), 'Archived checkout history must remain intact');
});

test('simultaneous recognition of sibling checkouts serialises without PostgreSQL deadlock', async () => {
    const { catalog, store } = await databaseFixture();
    const repository = new PostgresWorkspaceRepository(store.pool);
    let inspectCount = 0;
    let releaseInspections!: () => void;
    const bothInspected = new Promise<void>(resolve => { releaseInspections = resolve; });
    const runtime: ExecutionHost = {
        getCapabilities: () => ['workspace.files', 'workspace.git'],
        bind: async root => root,
        execute: async (_checkout, operation) => {
            assert.equal(operation, 'workspace_git_status');
            if (++inspectCount === 2) releaseInspections();
            await bothInspected; // Both callers have captured the same old logical ID.
            return { available: true, originRepository: 'affank1020/atlas' };
        },
    };
    const svc = new WorkspaceService(catalog, repository,
        new NodeRouter(new NodeService(new PostgresNodeRepository(store.pool), runtime, 'Test Node')));
    const source: any = await svc.call('create_workspace', {
        name: 'Main checkout', rootPath: '/trusted/concurrent/source', kind: 'generic',
    });
    const db = await repository.connect();
    let sibling: any;
    try {
        await db.begin();
        sibling = await db.insert({
            nodeId: source.nodeId, logicalWorkspaceId: source.logicalWorkspaceId,
            name: 'Managed sibling', rootPath: '/trusted/concurrent/feature', kind: 'generic',
        });
        await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }

    const attempts = await Promise.allSettled([
        svc.call('attach_checkout_repository', { workspaceId: source.id }),
        svc.call('attach_checkout_repository', { workspaceId: sibling.id }),
    ]);
    assert.equal(inspectCount, 2);
    assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1,
        'One caller wins the group migration; the other should receive a retryable stale-ID conflict');
    const rejected = attempts.find(x => x.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejected.reason), /Checkout binding or repository assignment changed/);
    assert.doesNotMatch(String(rejected.reason), /deadlock|40P01/i);
    // Explicit retry is safe and must be idempotent; the group is already unified.
    await svc.call('attach_checkout_repository', {
        workspaceId: attempts[0].status === 'rejected' ? source.id : sibling.id,
    });
    const logical = await svc.call('list_logical_workspaces', {}) as any[];
    assert.equal(logical.length, 1);
    assert.equal(logical[0].repository, 'affank1020/atlas');
    assert.deepEqual(logical[0].checkouts.map((x: any) => x.id).sort(),
        [source.id, sibling.id].sort());
});

test('verified Git origins unify distinct checkout bindings without changing their IDs or Node paths', async () => {
    const { catalog, store } = await databaseFixture();
    const runtime: ExecutionHost = {
        getCapabilities: () => ['workspace.files', 'workspace.git'],
        bind: async requested => requested,
        execute: async (checkout, operation) => {
            assert.equal(operation, 'workspace_git_status');
            return { available: true, originRepository: checkout.rootPath.includes('unrelated')
                ? 'affank1020/another-repo' : 'affank1020/portfolio-site' };
        },
    };
    const vpsNodeId = '00000000-0000-4000-8000-000000000099';
    await store.pool.query(
        "INSERT INTO nodes(id,name,status,capabilities,metadata) VALUES($1,'Linux VPS','online',ARRAY['workspace.files','workspace.git'],'{}'::jsonb)",
        [vpsNodeId]);
    const nodes = new NodeService(new PostgresNodeRepository(store.pool), runtime, 'MacBook');
    nodes.attachRemote(vpsNodeId, runtime);
    const svc = new WorkspaceService(catalog, new PostgresWorkspaceRepository(store.pool),
        new NodeRouter(nodes));
    const mac: any = await svc.call('create_workspace', {
        name: 'Portfolio Site', rootPath: '/mac/portfolio', kind: 'generic',
    });
    const linux: any = await svc.call('create_workspace', {
        name: 'Portfolio Site (VPS)', rootPath: '/linux/portfolio', nodeId: vpsNodeId, kind: 'generic',
    });
    const unrelated: any = await svc.call('create_workspace', {
        name: 'Unrelated', rootPath: '/mac/unrelated', kind: 'generic',
    });
    assert.equal((await svc.call('list_logical_workspaces', {}) as any[]).length, 3,
        'Do not deduplicate on similar labels before checking the origin');
    await assert.rejects(svc.call('attach_checkout_repository', {
        workspaceId: mac.id, repository: 'someone/forged',
    }), /Unrecognized key/);
    const linkedMac: any = await svc.call('attach_checkout_repository', { workspaceId: mac.id });
    const linkedVps: any = await svc.call('attach_checkout_repository', { workspaceId: linux.id });
    await svc.call('attach_checkout_repository', { workspaceId: unrelated.id });
    const logical = await svc.call('list_logical_workspaces', {}) as any[];
    assert.equal(logical.length, 2);
    const group = logical.find(x => x.repository === 'affank1020/portfolio-site');
    assert.ok(group);
    assert.deepEqual(group.checkouts.map((x: any) => x.id).sort(), [mac.id, linux.id].sort());
    assert.equal(linkedMac.logicalWorkspaceId, linkedVps.logicalWorkspaceId);
    assert.notEqual(mac.nodeId, linux.nodeId, 'Mac and VPS remain separate Node placements');
    assert.equal(group.checkouts.find((x: any) => x.id === linux.id).rootPath, '/linux/portfolio');
    assert.equal((await svc.call('get_workspace', { workspaceId: mac.id }) as any).rootPath, '/mac/portfolio');
    assert.equal((await svc.call('get_workspace', { workspaceId: linux.id }) as any).nodeId, linux.nodeId);
    // Repeating reconciliation must not create more logical records.
    await svc.call('attach_checkout_repository', { workspaceId: linux.id });
    assert.equal((await svc.call('list_logical_workspaces', {}) as any[]).length, 2);
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
        execute: async (currentWorkspace, operation, input) => {
            assert.equal(operation, 'workspace_git_status');
            assert.equal(input.workspaceId, currentWorkspace.id, 'Server must send the Workspace ID to the Node');
            assert.equal(validateNodeOperation(operation, input).success, true, 'Node-side Git status schema must accept server inspection');
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

test('Node protocol accepts a Project-independent Workspace without relaxing Git operation validation', () => {
    const id = '00000000-0000-4000-8000-000000000021';
    const nodeId = '00000000-0000-4000-8000-000000000022';
    const request = {
        type: 'request', kind: 'execute',
        requestId: '00000000-0000-4000-8000-000000000023',
        workspace: {
            id, nodeId, projectId: null, name: 'Independent Git checkout',
            rootPath: '/trusted/checkout', kind: 'generic', adapter: null,
            status: 'active', devTasks: {},
            createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
        },
        operation: 'workspace_git_status', input: { workspaceId: id },
    };
    assert.equal(nodeRequestSchema.safeParse(request).success, true,
        'The Node transport must accept independent Workspaces');
    assert.equal(validateNodeOperation('workspace_git_status', request.input).success, true);
    assert.equal(validateNodeOperation('workspace_git_status', {}).success, false,
        'Git status still requires an explicit Workspace ID');
    assert.equal(nodeRequestSchema.safeParse({
        ...request, workspace: { ...request.workspace, projectId: 'not-a-uuid' },
    }).success, false, 'Malformed Project associations still fail closed');
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
    git('remote', 'add', 'origin', 'https://github.com/affank1020/atlas.git');

    const { catalog, store } = await databaseFixture();
    const localNode = new LocalNodeRuntime([parent], new Map(), 'linux');
    const runtime: ExecutionHost = {
        getCapabilities: () => localNode.getCapabilities(),
        bind: root => localNode.bind(root),
        execute: async (checkout, operation, input) => {
            assert.equal(Object.hasOwn(checkout, 'logicalWorkspaceId'), false,
                'Every Node operation, including managed removal, must use Node v2 checkout fields');
            return localNode.execute(checkout, operation, input);
        },
    };
    let prMerged = false;
    let verified = 0;
    const broker = { verifyMergedPullRequest: async (repository: string, branch: string, head: string) => {
        verified++;
        assert.equal(repository, 'affank1020/atlas');
        assert.equal(branch, 'atlas/test-feature');
        assert.match(head, /^[a-f0-9]{40}$/);
        if (!prMerged) throw new Error('No merged PR matches this exact branch HEAD');
        return { number: 42, url: 'https://github.com/affank1020/atlas/pull/42' };
    } } as any;
    const svc = new WorkspaceService(catalog, new PostgresWorkspaceRepository(store.pool),
        new NodeRouter(new NodeService(new PostgresNodeRepository(store.pool), runtime, 'Test Node')), broker);
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

    // The source has not yet been recognised, so its new managed worktree
    // belongs to the same provisional local identity.
    const provisional = await svc.call('list_logical_workspaces', {}) as any[];
    assert.equal(provisional.length, 1);
    assert.deepEqual(provisional[0].checkouts.map((w: any) => w.id).sort(),
        [originalWorkspace.id, created.workspace.id].sort());
    const recognised: any = await svc.call('attach_checkout_repository', {
        workspaceId: originalWorkspace.id,
    });
    const logical = await svc.call('list_logical_workspaces', {}) as any[];
    assert.equal(logical.length, 1);
    assert.equal(logical[0].repository, 'affank1020/atlas');
    assert.equal(recognised.logicalWorkspaceId, logical[0].id);
    assert.deepEqual(logical[0].checkouts.map((w: any) => w.id).sort(),
        [originalWorkspace.id, created.workspace.id].sort(),
        'Recognising a source must also move its existing Atlas-managed worktrees');
    assert.equal((await svc.call('get_workspace', { workspaceId: created.workspace.id }) as any)
        .logicalWorkspaceId, recognised.logicalWorkspaceId);

    // Reject unmerged feature retirement BEFORE passing removal to the Node.
    await assert.rejects(svc.call('workspace_git_remove_worktree', {
        workspaceId: originalWorkspace.id, targetWorkspaceId: created.workspace.id,
        expectedHead: created.head,
    }), /No merged PR matches/);
    assert.equal(verified, 1);
    assert.equal((await svc.call('get_workspace', { workspaceId: created.workspace.id }) as any).status, 'active');
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(dest), true, 'Unmerged feature working directory must survive');
    prMerged = true;

    // Even a clean Atlas-created worktree cannot be deleted if its branch has
    // changed since registration. Preserve it and allow switching back.
    execFileSync('/usr/bin/git', ['-C', dest, 'switch', '-c', 'atlas/switched'], { encoding: 'utf8' });
    await assert.rejects(svc.call('workspace_git_remove_worktree', {
        workspaceId: originalWorkspace.id, targetWorkspaceId: created.workspace.id,
        expectedHead: created.head,
    }), /branch changed since Atlas created it/);
    execFileSync('/usr/bin/git', ['-C', dest, 'switch', 'atlas/test-feature'], { encoding: 'utf8' });

    const removed: any = await svc.call('workspace_git_remove_worktree', {
        workspaceId: originalWorkspace.id, targetWorkspaceId: created.workspace.id,
        expectedHead: created.head,
    });
    assert.equal(removed.preservedBranch, 'atlas/test-feature');
    assert.equal(removed.mergedPullRequest.number, 42);
    assert.ok(verified >= 2);
    assert.equal((await svc.call('list_workspaces', {}) as any[]).length, 1);
    assert.equal((await svc.call('list_workspaces', { includeArchived: true }) as any[]).length, 2);
    assert.equal(git('rev-parse', 'refs/heads/atlas/test-feature'), created.head);

    // Registering an existing clean atlas/* worktree does NOT make it managed.
    // A forged "created" Workspace lacks Atlas's server-owned lifecycle marker.
    const manualPath = path.join(parent, 'manually-created-worktree');
    git('worktree', 'add', '-b', 'atlas/manual', manualPath, 'HEAD');
    const manual: any = await svc.call('create_workspace', {
        name: 'Manual linked worktree', rootPath: manualPath, kind: 'generic',
    });
    await assert.rejects(svc.call('workspace_git_remove_worktree', {
        workspaceId: originalWorkspace.id, targetWorkspaceId: manual.id,
        expectedHead: created.head,
    }), (error: any) => error?.code === 'WORKSPACE_DENIED');
    assert.equal((await svc.call('get_workspace', { workspaceId: manual.id }) as any).status, 'active');
    assert.ok(git('worktree', 'list', '--porcelain').includes(manualPath));
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
