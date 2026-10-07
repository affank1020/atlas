import { NodeRouter } from '../src/nodes/router.js';
import { NodeService } from '../src/nodes/service.js';
import { PostgresNodeRepository } from '../src/infrastructure/database/nodes.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture, cleanupDatabases } from './database.js';
import { WorkspaceService } from '../src/workspaces/application.js';
import { PostgresWorkspaceRepository } from '../src/infrastructure/database/workspaces.js';
import type { ExecutionHost } from '../src/workspaces/runtime.js';
import type { WorkspaceRepository } from '../src/workspaces/repository.js';
after(cleanupDatabases);

test('Workspace service registers and executes an opaque host binding without server filesystem access', async () => {
    const { catalog, store } = await databaseFixture();
    const project = await catalog.createProject({ name: 'Hosted execution' });
    const events: string[] = [];
    const runtime: ExecutionHost = { getCapabilities: () => ['workspace.files', 'workspace.git', 'unity'],
        bind: async requested => { events.push(`bind:${requested}`); return 'host-owned-binding'; },
        execute: async (workspace, operation) => {
            assert.equal(workspace.rootPath, 'host-owned-binding');
            events.push(operation);
            const audit = await catalog.auditHistory({ workspaceId: workspace.id });
            assert.ok(audit.some(event => event.operation === 'workspace.mutation_requested'));
            return { path: 'created.txt', sha256: 'host-result' };
        },
    };
    const service = new WorkspaceService(catalog, new PostgresWorkspaceRepository(store.pool), new NodeRouter(new NodeService(new PostgresNodeRepository(store.pool), runtime, 'Test Node')));
    const workspace: any = await service.call('create_workspace', { projectId: project.id, name: 'Host workspace', rootPath: '/unavailable-on-server', kind: 'generic', client: 'host-test' });
    const result = await service.call('workspace_create_file', { projectId: project.id, workspaceId: workspace.id, path: 'created.txt', text: 'content', client: 'host-test' });
    assert.deepEqual(result, { path: 'created.txt', sha256: 'host-result' });
    assert.deepEqual(events, ['bind:/unavailable-on-server', 'workspace_create_file']);
    const audit = await catalog.auditHistory({ workspaceId: workspace.id });
    assert.ok(audit.some(event => event.operation === 'workspace.file_created' && (event.resulting as any).outcome === 'completed'));
    const other = await catalog.createProject({ name: 'Other project' });
    await assert.rejects(service.call('workspace_read_file', { projectId: other.id, workspaceId: workspace.id, path: 'created.txt' }), /not found/);
    assert.equal(events.length, 2);
});

test('execution success followed by audit failure reports uncertainty and retains durable intent', async () => {
    const { catalog, store } = await databaseFixture();
    const project = await catalog.createProject({ name: 'Uncertain execution' });
    const repository = new PostgresWorkspaceRepository(store.pool);
    let calls = 0;
    const runtime: ExecutionHost = { getCapabilities: () => ['workspace.files', 'workspace.git', 'unity'], bind: async path => path, execute: async () => { calls++; return { changed: true }; } };
    const service = new WorkspaceService(catalog, repository, new NodeRouter(new NodeService(new PostgresNodeRepository(store.pool), runtime, 'Test Node')));
    const workspace: any = await service.call('create_workspace', { projectId: project.id, name: 'Workspace', rootPath: '/host-binding', kind: 'generic' });
    const failing: WorkspaceRepository = {
        get: (...args) => repository.get(...args), list: (...args) => repository.list(...args), audit: (...args) => repository.audit(...args),
        connect: async () => {
            const transaction = await repository.connect();
            const audit = transaction.audit.bind(transaction);
            transaction.audit = async (...args) => { if (args[1] === 'workspace.file_created') throw new Error('audit unavailable'); return audit(...args); };
            return transaction;
        },
    };
    const failingService = new WorkspaceService(catalog, failing, service.runtime);
    await assert.rejects(failingService.call('workspace_create_file', { projectId: project.id, workspaceId: workspace.id, path: 'created.txt', text: 'content' }), (error: any) => error.code === 'OUTCOME_UNCERTAIN');
    assert.equal(calls, 1);
    const operations = (await catalog.auditHistory({ workspaceId: workspace.id })).map(event => event.operation);
    assert.ok(operations.includes('workspace.mutation_requested'));
    assert.ok(operations.includes('workspace.mutation_failed'));
    assert.ok(!operations.includes('workspace.file_created'));
});
