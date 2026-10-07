import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { databaseFixture, cleanupDatabases } from './database.js';
import { WorkspaceService } from '../apps/server/src/workspaces/application.js';
import { PostgresWorkspaceRepository } from '../apps/server/src/infrastructure/database/workspaces.js';
import { PostgresNodeRepository } from '../apps/server/src/infrastructure/database/nodes.js';
import { LocalNodeRuntime } from '../apps/node/src/platforms/desktop/runtime.js';
import { NodeService } from '../apps/server/src/nodes/service.js';
import { NodeRouter } from '../apps/server/src/nodes/router.js';
import type { DevTaskResult } from '../apps/server/src/workspaces/dev-tasks.js';
after(cleanupDatabases);
const folders: string[] = [];
after(async () => { await Promise.all(folders.map(folder => fs.rm(folder, { recursive: true, force: true }))); });
async function setup() {
    const { catalog, store } = await databaseFixture();
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-dev-')); folders.push(folder);
    const project = await catalog.createProject({ name: 'Development' });
    const nodes = new NodeService(new PostgresNodeRepository(store.pool), new LocalNodeRuntime([folder], new Map()), 'Test Node');
    const workspaces = new WorkspaceService(catalog, new PostgresWorkspaceRepository(store.pool), new NodeRouter(nodes));
    const workspace: any = await workspaces.call('create_workspace', { projectId: project.id, name: 'Dev', rootPath: folder });
    async function configure(tasks: Record<string, { executable: string; args: string[]; timeoutMs?: number; passEnvironment?: string[] }>) {
        await store.pool.query('UPDATE workspaces SET dev_tasks=$2 WHERE id=$1', [workspace.id, tasks]);
    }
    const scope = { projectId: project.id, workspaceId: workspace.id };
    const run = (task: string) => workspaces.call('workspace_run_dev_task', { ...scope, task, client: 'codex' }) as Promise<DevTaskResult>;
    return { catalog, store, folder, project, workspace, nodes, workspaces, configure, scope, run };
}
test('owner-configured argv runs in the bound root with structured success/failure and bounded output; activity omits output', async () => {
    const x = await setup();
    await fs.writeFile(path.join(x.folder, 'marker.txt'), 'root marker');
    await x.configure({
        test: { executable: process.execPath, args: ['-e', 'process.stdout.write(require("fs").readFileSync("marker.txt", "utf8"));process.stderr.write("warning")'] },
        fail: { executable: process.execPath, args: ['-e', 'process.stdout.write("failure detail");process.stderr.write("failed check");process.exit(7)'] },
        large: { executable: process.execPath, args: ['-e', 'process.stdout.write("X".repeat(200000)+"LAST_STDOUT");process.stderr.write("Y".repeat(200000)+"LAST_STDERR")'] },
    });
    const listed: any = await x.workspaces.call('workspace_list_dev_tasks', x.scope);
    assert.deepEqual(listed.map((task: any) => task.task).sort(), ['fail', 'large', 'test']);
    const ok = await x.run('test'); assert.equal(ok.success, true); assert.equal(ok.exitCode, 0);
    assert.equal(ok.stdout, 'root marker'); assert.equal(ok.stderr, 'warning'); assert.equal(ok.nodeId, x.workspace.nodeId);
    assert.ok(ok.startedAt <= ok.completedAt && ok.durationMs >= 0);
    const failed = await x.run('fail'); assert.equal(failed.success, false); assert.equal(failed.exitCode, 7);
    assert.equal(failed.stdout, 'failure detail'); assert.equal(failed.stderr, 'failed check');
    const large = await x.run('large'); assert.equal(large.success, true);
    assert.equal(large.stdoutTruncated, true); assert.equal(large.stderrTruncated, true);
    assert.ok(large.stdout.length <= 128 * 1024 && large.stdout.endsWith('LAST_STDOUT'));
    assert.ok(large.stderr.length <= 128 * 1024 && large.stderr.endsWith('LAST_STDERR'));
    const audit = await x.catalog.auditHistory({ workspaceId: x.workspace.id });
    const executions = audit.filter(event => event.operation === 'workspace.dev_invoked');
    assert.equal(executions.length, 3);
    assert.ok(executions.some(event => (event.resulting as any).outcome === 'failed' && (event.resulting as any).exitCode === 7));
    assert.ok(executions.every(event => (event.resulting as any).nodeId === x.workspace.nodeId && typeof (event.resulting as any).durationMs === 'number'));
    assert.ok(!JSON.stringify(executions).includes('failure detail') && !JSON.stringify(executions).includes('LAST_STDOUT'));
    await x.nodes.close();
});
test('task selection is strict: unknown task/workspace, caller command and cwd injection fail before execution', async () => {
    const x = await setup();
    await x.configure({ test: { executable: process.execPath, args: ['-e', 'process.stdout.write("ok")'] } });
    await assert.rejects(x.run('unknown'), (error: any) => error.code === 'TASK_UNAVAILABLE');
    await assert.rejects(x.workspaces.call('workspace_run_dev_task', { ...x.scope, task: 'test', command: 'rm -rf /' }), (error: any) => error.code === 'INVALID_REQUEST');
    await assert.rejects(x.workspaces.call('workspace_run_dev_task', { ...x.scope, task: 'test', cwd: '/' }), (error: any) => error.code === 'INVALID_REQUEST');
    await assert.rejects(x.workspaces.call('workspace_run_dev_task', { ...x.scope, task: 'test', env: { FOO: 'bar' } }), (error: any) => error.code === 'INVALID_REQUEST');
    await assert.rejects(x.workspaces.call('workspace_run_dev_task', { projectId: x.project.id, workspaceId: randomUUID(), task: 'test' }), (error: any) => error.code === 'NOT_FOUND');
    await assert.rejects(x.workspaces.call('create_workspace', { projectId: x.project.id, name: 'Other', rootPath: x.folder, devTasks: { test: { executable: 'sh', args: [] } } }), (error: any) => error.code === 'INVALID_REQUEST');
    assert.equal((await x.catalog.auditHistory({ workspaceId: x.workspace.id })).filter(event => event.operation === 'workspace.dev_invoked').length, 0);
    await x.nodes.close();
});
test('child environment is minimal unless the owner explicitly passes a variable', async () => {
    const x = await setup();
    const key = 'ATLAS_DEV_TEST_SECRET';
    process.env[key] = 'owner-selected-value';
    try {
        const script = `process.stdout.write(process.env.${key} ?? 'absent')`;
        await x.configure({ hidden: { executable: process.execPath, args: ['-e', script] }, selected: { executable: process.execPath, args: ['-e', script], passEnvironment: [key] } });
        assert.equal((await x.run('hidden')).stdout, 'absent');
        assert.equal((await x.run('selected')).stdout, 'owner-selected-value');
    } finally { delete process.env[key]; await x.nodes.close(); }
});
test('timeout returns a failed result; missing capability, offline or detached Node yields Atlas errors', async () => {
    const x = await setup();
    await x.configure({ hang: { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 150 } });
    const timed = await x.run('hang'); assert.equal(timed.success, false); assert.equal(timed.timedOut, true); assert.equal(timed.exitCode, null); assert.ok(timed.durationMs < 3000);
    await x.store.pool.query("UPDATE nodes SET capabilities=ARRAY['workspace.files'] WHERE id=$1", [x.workspace.nodeId]);
    await assert.rejects(x.run('hang'), (error: any) => error.code === 'CAPABILITY_UNAVAILABLE');
    await x.store.pool.query("UPDATE nodes SET status='offline' WHERE id=$1", [x.workspace.nodeId]);
    await assert.rejects(x.run('hang'), (error: any) => error.code === 'NODE_OFFLINE');
    await x.store.pool.query("UPDATE nodes SET status='online' WHERE id=$1", [x.workspace.nodeId]);
    x.nodes.runtimes.delete(x.workspace.nodeId);
    await assert.rejects(x.run('hang'), (error: any) => error.code === 'NODE_UNAVAILABLE');
    const audit = await x.catalog.auditHistory({ workspaceId: x.workspace.id });
    assert.ok(audit.some(event => event.operation === 'workspace.dev_invoked' && (event.resulting as any).timedOut));
    assert.equal(audit.filter(event => event.operation === 'workspace.mutation_failed').length, 3);
    await x.nodes.close();
});
