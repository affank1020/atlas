import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { databaseFixture, cleanupDatabases } from './database.js';
import { PostgresNodeRepository } from '../apps/server/src/infrastructure/database/nodes.js';
import { PostgresWorkspaceRepository } from '../apps/server/src/infrastructure/database/workspaces.js';
import { LocalNodeRuntime } from '../apps/node/src/platforms/desktop/runtime.js';
import { WorkspaceService } from '../apps/server/src/workspaces/application.js';
import { NodeService } from '../apps/server/src/nodes/service.js';
import { NodeRouter } from '../apps/server/src/nodes/router.js';
import { requiredCapability, type NodeRuntime, type NodeOperation } from '../apps/server/src/nodes/runtime.js';
import type { NodeCapability } from '../apps/server/src/nodes/model.js';
after(cleanupDatabases);
const all: NodeCapability[] = ['workspace.files', 'workspace.git', 'workspace.dev', 'football.training', 'unity'];
function runtime(capabilities = all): NodeRuntime {
    return { getCapabilities: () => capabilities, bind: async binding => `node:${binding}`, execute: async (workspace, operation) => ({ nodeId: workspace.nodeId, operation }) };
}

test('migration preserves active/archived Workspace metadata and audit history, and enforces Node ownership', async () => {
    const { store, catalog } = await databaseFixture('011_workspaces.sql');
    const project = await catalog.createProject({ name: 'Migration' });
    for (const archived of [false, true]) {
        await store.pool.query(`INSERT INTO workspaces(id,project_id,name,root_path,kind,adapter,status,archived_at)
            VALUES($1,$2,'Existing','/opaque/binding','unity','unity',$3,$4)`, [randomUUID(), project.id, archived ? 'archived' : 'active', archived ? new Date('2025-01-01') : null]);
    }
    const before = (await store.pool.query('SELECT * FROM workspaces ORDER BY id')).rows;
    const audit = (await store.pool.query('SELECT * FROM audit_events ORDER BY id')).rows;
    await store.pool.query(await readFile('apps/server/migrations/012_nodes.sql', 'utf8'));
    const after = (await store.pool.query('SELECT * FROM workspaces ORDER BY id')).rows;
    assert.deepEqual(after.map(({ node_id, ...rest }) => rest), before);
    assert.equal(new Set(after.map(row => row.node_id)).size, 1);
    assert.ok(after[0].node_id);
    for (const event of audit) assert.deepEqual((await store.pool.query('SELECT * FROM audit_events WHERE id=$1', [event.id])).rows[0], event);
    await assert.rejects(store.pool.query('UPDATE workspaces SET node_id=NULL'), (error: any) => error.code === '23502');
    await assert.rejects(store.pool.query('UPDATE workspaces SET node_id=$1', [randomUUID()]), (error: any) => error.code === '23503');
});

test('local registration persists stable identity/name and capabilities, presence is quiet, list/get expose real hosted Workspaces', async () => {
    const { store, catalog } = await databaseFixture();
    const repository = new PostgresNodeRepository(store.pool);
    const first = new NodeService(repository, runtime(), 'Development machine');
    const ids = await Promise.all([first.registerLocalNode(), first.registerLocalNode()]);
    assert.equal(ids[0], ids[1]);
    const id = ids[0]!;
    const node = await first.get(id);
    assert.equal(node.status, 'online'); assert.deepEqual(node.capabilities, all); assert.ok(node.lastSeen);
    const project = await catalog.createProject({ name: 'Hosted' });
    const service = new WorkspaceService(catalog, new PostgresWorkspaceRepository(store.pool), new NodeRouter(first));
    const workspace: any = await service.call('create_workspace', { projectId: project.id, name: 'Resource', rootPath: '/not-on-server' });
    assert.equal(workspace.nodeId, id); assert.equal(workspace.rootPath, 'node:/not-on-server');
    const detail: any = await first.call('get_node', { nodeId: id });
    assert.equal(detail.hostedWorkspaceCount, 1); assert.equal(detail.workspaces[0].id, workspace.id);
    assert.equal((await first.call('list_nodes', {}) as any[])[0].id, id);
    await assert.rejects(first.call('get_node', { nodeId: randomUUID() }), (e: any) => e.code === 'NOT_FOUND');
    await assert.rejects(first.call('get_node', { nodeId: 'bad' }), (e: any) => e.code === 'INVALID_REQUEST');
    await first.close(); assert.equal((await repository.get(id)).status, 'offline');
    const second = new NodeService(repository, runtime(), 'Different hostname');
    assert.equal(await second.registerLocalNode(), id);
    assert.equal((await second.get(id)).name, 'Development machine');
    assert.equal((await repository.list()).length, 1);
    assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE operation LIKE 'node.%'")).rows[0].n, 1);
    await service.repository.get(project.id, workspace.id);
    await catalog.archiveProject(project.id);
    assert.equal((await second.get(id)).hostedWorkspaceCount, 0);
    await second.close();
});

test('every filesystem/Git/Unity operation routes to the owning Node; failures never dispatch', async () => {
    const { store, catalog } = await databaseFixture();
    const invoked: string[] = [];
    const local = runtime();
    local.execute = async (workspace, operation) => { invoked.push(`${workspace.nodeId}:${operation}`); return { ok: true }; };
    const nodes = new NodeService(new PostgresNodeRepository(store.pool), local, 'Local');
    const router = new NodeRouter(nodes);
    const service = new WorkspaceService(catalog, new PostgresWorkspaceRepository(store.pool), router);
    const project = await catalog.createProject({ name: 'Routed' });
    const workspace: any = await service.call('create_workspace', { projectId: project.id, name: 'Opaque', rootPath: 'opaque', kind: 'unity' });
    await store.pool.query("UPDATE workspaces SET dev_tasks=$1 WHERE id=$2", [{ test: { executable: 'node', args: [], timeoutMs: 1000 } }, workspace.id]);
    const scope = { projectId: project.id, workspaceId: workspace.id };
    const inputs: Record<NodeOperation, object> = {
        workspace_list_files: {}, workspace_read_file: { path: 'a' }, workspace_search_files: { query: 'q' },
        workspace_create_file: { path: 'a', text: 'content' }, workspace_patch_file: { path: 'a', expectedSha256: 'a'.repeat(64), oldText: 'old', newText: 'new' },
        workspace_delete_file: { path: 'a', expectedSha256: 'a'.repeat(64) }, workspace_list_dev_tasks: {}, workspace_run_dev_task: { task: 'test' }, workspace_git_status: {}, workspace_git_diff: {},
        unity_status: {}, unity_list_commands: {}, unity_run_command: { command: 'editor_play', parameters: {} },
    };
    for (const operation of Object.keys(requiredCapability).filter(op => op !== 'football_control') as NodeOperation[]) await service.call(operation as any, { ...scope, ...inputs[operation] });
    assert.equal(invoked.length, 13);
    // Internal first-party Application commands reach the owning Node through NodeRouter,
    // but are intentionally not exposed by WorkspaceService's generic public API.
    await assert.rejects(service.call('football_control' as any, { ...scope, action: 'drills' }), (e: any) => e.code === 'INVALID_REQUEST');
    await router.execute(workspace, 'football_control', { ...scope, action: 'drills' });
    assert.equal(invoked.at(-1), `${workspace.nodeId}:football_control`);
    // A second registered runtime proves routing is by ownership, not a global local fallback.
    const otherId = randomUUID();
    await store.pool.query("INSERT INTO nodes(id,name,status,capabilities) VALUES($1,'Other','online',$2)", [otherId, all]);
    const other = runtime(); other.execute = async (_workspace, operation) => { invoked.push(`other:${operation}`); return {}; };
    nodes.runtimes.set(otherId, other);
    await store.pool.query('UPDATE workspaces SET node_id=$1 WHERE id=$2', [otherId, workspace.id]);
    await service.call('workspace_read_file', { ...scope, path: 'a' });
    assert.equal(invoked.at(-1), 'other:workspace_read_file');
    const count = invoked.length;
    await store.pool.query("UPDATE nodes SET capabilities=ARRAY['workspace.files'] WHERE id=$1", [otherId]);
    await assert.rejects(service.call('unity_run_command', { ...scope, command: 'editor_play' }), (e: any) => e.code === 'CAPABILITY_UNAVAILABLE');
    await store.pool.query("UPDATE nodes SET status='offline' WHERE id=$1", [otherId]);
    await assert.rejects(service.call('workspace_read_file', { ...scope, path: 'a' }), (e: any) => e.code === 'NODE_OFFLINE');
    await store.pool.query("UPDATE nodes SET status='online' WHERE id=$1", [otherId]); nodes.runtimes.delete(otherId);
    assert.equal((await nodes.get(otherId)).status, 'unavailable');
    await assert.rejects(service.call('workspace_read_file', { ...scope, path: 'a' }), (e: any) => e.code === 'NODE_UNAVAILABLE');
    assert.equal(invoked.length, count);
    await nodes.close();
});

test('LocalNodeRuntime advertises implemented capabilities without claiming a connected Editor', () => {
    assert.deepEqual(new LocalNodeRuntime([], new Map()).getCapabilities(), ['workspace.files', 'workspace.git', 'workspace.dev', 'football.training']);
    assert.deepEqual(new LocalNodeRuntime([]).getCapabilities(), all);
});
