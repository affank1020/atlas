import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WorkspaceFiles, MAX_FILE_BYTES, git } from '../apps/node/src/capabilities/workspace-files/files.js';
import { UnityAdapter, UnityCliConnection, type Workspace, type UnityConnection } from '../apps/node/src/capabilities/unity/unity.js';
import { localWorkspaceService, localHttpServer } from './local-node-fixture.js';
import { workspaceSchemas } from '../apps/server/src/workspaces/contracts.js';
import { createAtlasHttpServer } from '../apps/server/src/server.js';
import { cleanupDatabases, databaseFixture } from './database.js';
const dirs: string[] = [];
after(async () => { await cleanupDatabases(); await Promise.all(dirs.map(x => fs.rm(x, { recursive: true, force: true }))); });
async function disk() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-workspaces-'))); dirs.push(root);
    const repo = path.join(root, 'repo'); await fs.mkdir(repo); return { root, repo, files: new WorkspaceFiles([root]) };
}

test('canonical allow-list, traversal, absolute, symlink, hardlink and protected-file defenses', async () => {
    const { root, repo, files } = await disk();
    await fs.writeFile(path.join(repo, 'safe.txt'), 'safe');
    assert.equal((await files.read(repo, 'safe.txt')).text, 'safe');
    for (const relative of ['../safe.txt', '/etc/passwd', '.git/config', '.env', 'x/../safe.txt', 'id_rsa', 'Library/data', 'a\\b']) await assert.rejects(files.read(repo, relative));
    const outside = await disk(); await assert.rejects(files.bind(outside.repo));
    await assert.rejects(new WorkspaceFiles([]).bind(repo));
    await fs.symlink(outside.repo, path.join(repo, 'link')); await assert.rejects(files.read(repo, 'link/test'));
    await fs.symlink(path.join(repo, 'safe.txt'), path.join(repo, 'alias')); await assert.rejects(files.read(repo, 'alias'));
    await fs.link(path.join(repo, 'safe.txt'), path.join(repo, 'hard')); await assert.rejects(files.read(repo, 'hard'));
    await fs.mkdir(path.join(root, '.git')); await assert.rejects(files.bind(path.join(root, '.git')));
    await fs.writeFile(path.join(repo, 'key.txt'), '-----BEGIN PRIVATE KEY-----\nsecret'); await assert.rejects(files.read(repo, 'key.txt'));
});

test('bounded UTF-8 reads reject oversized, invalid UTF-8 and binary files', async () => {
    const { repo, files } = await disk();
    for (const [name, contents] of [['large', Buffer.alloc(MAX_FILE_BYTES + 1, 65)], ['binary', Buffer.from([65, 0, 66])], ['invalid', Buffer.from([255])]] as const) {
        await fs.writeFile(path.join(repo, name), contents); await assert.rejects(files.read(repo, name));
    }
    await assert.rejects(files.create(repo, 'too-large', 'a'.repeat(MAX_FILE_BYTES + 1)));
    await assert.rejects(files.read(repo, ''));
});

test('deterministic list/search and exclusive create, patch conflicts, hash-guarded delete', async () => {
    const { repo, files } = await disk(); await fs.mkdir(path.join(repo, 'src')); await fs.mkdir(path.join(repo, 'Library'));
    await files.create(repo, 'src/Agent.cs', 'hello\nfootball\n'); await files.create(repo, 'z.txt', 'football');
    await fs.writeFile(path.join(repo, 'Library', 'cache'), 'football'); await fs.writeFile(path.join(repo, '.env'), 'football');
    const listing = await files.list(repo); assert.deepEqual(listing.entries.map(x => x.path), ['src', 'src/Agent.cs', 'z.txt']);
    assert.equal((await files.list(repo, '', 4, 1)).truncated, true);
    assert.deepEqual((await files.search(repo, 'football')).matches.map(x => [x.path, x.line]), [['src/Agent.cs', 2], ['z.txt', 1]]);
    assert.equal((await files.search(repo, 'football', '', 1)).truncated, true);
    await assert.rejects(files.create(repo, 'z.txt', 'overwrite'));
    const before = await files.read(repo, 'src/Agent.cs');
    await assert.rejects(files.patch(repo, before.path, before.sha256, 'missing', 'bad'));
    await files.patch(repo, before.path, before.sha256, 'football', 'goal');
    await assert.rejects(files.patch(repo, before.path, before.sha256, 'goal', 'stale'));
    await assert.rejects(files.delete(repo, before.path, before.sha256));
    await files.delete(repo, before.path, (await files.read(repo, before.path)).sha256);
    await assert.rejects(files.read(repo, before.path));
    const repeated = await files.create(repo, 'repeat.txt', 'aa aa'); await assert.rejects(files.patch(repo, 'repeat.txt', repeated.sha256, 'aa', 'bb'));
});

test('fixed Git status and diff omit protected paths and disable external diff execution', async () => {
    const { repo, files } = await disk(); assert.equal((await git(repo, files)).available, false);
    const run = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8' });
    run('init', '-q'); run('config', 'user.email', 'test@example.invalid'); run('config', 'user.name', 'Workspace test');
    await fs.writeFile(path.join(repo, 'code.cs'), 'old\n'); await fs.writeFile(path.join(repo, '.env'), 'secret=old\n');
    run('add', '.'); run('commit', '-qm', 'fixture');
    await fs.writeFile(path.join(repo, 'code.cs'), 'new\n'); await fs.writeFile(path.join(repo, '.env'), 'secret=new\n');
    run('config', 'diff.external', '/does/not/exist');
    const status: any = await git(repo, files); assert.equal(status.dirty, true); assert.deepEqual(status.changes.map((x: any) => x.path), ['code.cs']);
    const diff: any = await git(repo, files, true); assert.match(diff.diff, /\+new/); assert.doesNotMatch(diff.diff, /secret/);
    run('add', 'code.cs'); assert.match((await git(repo, files, true) as any).stagedDiff, /\+new/);
    await fs.mkdir(path.join(repo, 'sub')); assert.equal((await git(path.join(repo, 'sub'), files)).available, false);
});

test('optional Unity CLI, package state, discovered capabilities, local approval and structured invocation', async () => {
    const { repo, files } = await disk();
    const workspace: Workspace = { id: 'test', nodeId: 'test-node', projectId: 'project', name: 'Unity', kind: 'unity', adapter: 'unity', status: 'active', devTasks: {}, rootPath: repo, createdAt: '', updatedAt: '' };
    assert.equal((await new UnityAdapter(files, new UnityCliConnection('/missing/unity')).status(workspace)).state, 'cli_unavailable');
    const called: unknown[] = [];
    const connection: UnityConnection = { version: async () => '1.0.0-beta.12', probe: async () => ({}), tools: async () => [{ name: 'custom.summary', inputSchema: { type: 'object' } }, { name: 'eval', inputSchema: {} }], call: async (root, name, parameters) => { called.push({ root, name, parameters }); return { ok: true }; } };
    const adapter = new UnityAdapter(files, connection, ['custom.summary', 'eval', 'missing']);
    assert.equal((await adapter.status(workspace)).state, 'pipeline_not_configured');
    await fs.mkdir(path.join(repo, 'Packages')); await files.create(repo, 'Packages/manifest.json', JSON.stringify({ dependencies: { 'com.unity.pipeline': '0.3.0' } }));
    assert.equal((await adapter.status(workspace)).available, true);
    assert.equal((await adapter.capabilities(workspace)).commands[0]?.approved, true);
    await assert.rejects(adapter.invoke(workspace, 'eval', {})); await assert.rejects(adapter.invoke(workspace, 'missing', {})); await assert.rejects(adapter.invoke(workspace, 'unapproved', {}));
    assert.deepEqual(await adapter.invoke(workspace, 'custom.summary', { limit: 4 }), { ok: true }); assert.deepEqual(called, [{ root: repo, name: 'custom.summary', parameters: { limit: 4 } }]);
    connection.probe = async () => { throw new Error('offline'); }; assert.equal((await adapter.status(workspace)).state, 'editor_unreachable'); await assert.rejects(adapter.invoke(workspace, 'custom.summary', {}));
});

test('workspace persistence, project isolation, audit intents/outcomes, concurrent edits and archival', async () => {
    const { catalog, store } = await databaseFixture(); const { root, repo } = await disk();
    const project = await catalog.createProject({ name: 'Workspaces' }); const other = await catalog.createProject({ name: 'Other' });
    const service = localWorkspaceService(catalog, store.pool, [root]);
    const workspace: any = await service.call('create_workspace', { projectId: project.id, name: 'Repo', rootPath: repo });
    const scope = { projectId: project.id, workspaceId: workspace.id };
    await assert.rejects(service.call('get_workspace', { ...scope, projectId: other.id }));
    await assert.rejects(service.call('create_workspace', { projectId: project.id, name: 'Duplicate', rootPath: repo }));
    assert.deepEqual(await service.call('unity_status', scope), { available: false, state: 'no_adapter' });
    await service.call('workspace_create_file', { ...scope, path: 'file.txt', text: 'one', client: 'test-client' });
    const read: any = await service.call('workspace_read_file', { ...scope, path: 'file.txt', client: 'codex' });
    await service.call('workspace_list_files', { ...scope, client: 'codex' });
    await service.call('workspace_search_files', { ...scope, query: 'one', client: 'codex' });
    await service.call('workspace_git_status', { ...scope, client: 'codex' });
    await service.call('workspace_git_diff', { ...scope, client: 'codex' });
    await service.call('unity_list_commands', { ...scope, client: 'codex' });
    await assert.rejects(service.call('workspace_read_file', { ...scope, path: '.env', client: 'codex' }));
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => `new-${i}`).map(newText => service.call('workspace_patch_file', { ...scope, path: 'file.txt', expectedSha256: read.sha256, oldText: 'one', newText })));
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    const audits = await catalog.auditHistory({ projectId: project.id });
    assert.ok(audits.some(x => x.operation === 'workspace.file_created' && x.workspaceId === workspace.id && x.client === 'test-client'));
    assert.ok(audits.some(x => x.operation === 'workspace.mutation_failed' && (x.resulting as any).error));
    for (const operation of ['file_read', 'file_listed', 'files_searched', 'git_status', 'git_diff', 'unity_commands']) {
        assert.ok(audits.some(x => x.operation === `workspace.${operation}` && x.client === 'codex' && (x.resulting as any).activityKind === 'inspection'));
    }
    const failedRead = audits.find(x => x.operation === 'workspace.file_read' && (x.resulting as any).outcome === 'failed');
    assert.equal((failedRead?.resulting as any).error, 'Protected or invalid workspace path.');
    assert.ok(audits.every(x => !x.operation.startsWith('workspace.') || (x.resulting as any).workspaceName === 'Repo'));
    const scoped = await catalog.auditHistory({ projectId: project.id, workspaceId: workspace.id });
    assert.ok(scoped.length > 0 && scoped.every(x => x.workspaceId === workspace.id));
    assert.equal((await catalog.auditHistory({ projectId: other.id, workspaceId: workspace.id })).length, 0);
    assert.ok(!JSON.stringify(audits).includes('"query":"one"'));
    assert.ok(!JSON.stringify(audits).includes('"text":"one"'));
    const renamed: any = await service.call('update_workspace', { ...scope, name: 'Renamed' }); assert.equal(renamed.name, 'Renamed');
    await service.call('archive_workspace', scope); await assert.rejects(service.call('workspace_read_file', { ...scope, path: 'file.txt' }));
    assert.ok(await fs.stat(path.join(repo, 'file.txt')));
    await service.call('create_workspace', { projectId: project.id, name: 'Rebound', rootPath: repo });
    await catalog.archiveProject(project.id); await assert.rejects(service.call('list_project_workspaces', { projectId: project.id }));
    assert.equal((await catalog.getProject(other.id)).name, 'Other');
});

test('Unity result and failed attempts retain client, command, workspace and pairing metadata', async () => {
    const { catalog, store } = await databaseFixture(); const { root, repo } = await disk();
    const project = await catalog.createProject({ name: 'Unity activity' });
    const adapter = { status: async () => ({}), capabilities: async () => ({}), invoke: async (_workspace: Workspace, command: string) => ({ isError: command === 'editor_stop' }) };
    const service = localWorkspaceService(catalog, store.pool, [root], new Map([['unity', adapter]]));
    const workspace: any = await service.call('create_workspace', { projectId: project.id, name: 'AI Football', rootPath: repo, kind: 'unity' });
    for (const command of ['editor_play', 'editor_stop', 'console', 'get_component_properties', 'capture_game_view']) {
        await service.call('unity_run_command', { projectId: project.id, workspaceId: workspace.id, command, client: 'chatgpt' });
    }
    const events = await catalog.auditHistory({ projectId: project.id, workspaceId: workspace.id });
    const results = events.filter(e => e.operation === 'workspace.unity_invoked');
    assert.equal(results.length, 5);
    for (const event of results) {
        const data = event.resulting as any;
        assert.equal(event.client, 'chatgpt'); assert.equal(data.workspaceName, 'AI Football');
        assert.ok(events.some(e => e.operation === 'workspace.mutation_requested' && (e.resulting as any).attemptId === data.attemptId));
        assert.equal(data.outcome, data.command === 'editor_stop' ? 'editor_error' : 'completed');
    }
});

test('real MCP and HTTP workspace flow preserves Core and rejects browser origins', async () => {
    const fixture = await databaseFixture(); const { root, repo } = await disk();
    const oldRoots = process.env.ATLAS_WORKSPACE_ROOTS; process.env.ATLAS_WORKSPACE_ROOTS = root;
    const { http, services } = localHttpServer(fixture.databaseUrl, [root]); const client = new Client({ name: 'workspace-smoke', version: '1' });
    try {
        http.listen(0, '127.0.0.1'); await once(http, 'listening'); const address = http.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`;
        await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')));
        const names = (await client.listTools()).tools.map(x => x.name); for (const name of Object.keys(workspaceSchemas)) assert.ok(names.includes(name));
        const call = async (name: string, args: any) => { const response = await client.callTool({ name, arguments: args }); assert.ok(!response.isError, JSON.stringify(response)); return (response.structuredContent as any).result; };
        const project = await call('create_project', { name: 'MCP workspace test' });
        const workspace = await call('create_workspace', { projectId: project.id, name: 'Repository', rootPath: repo }); const scope = { projectId: project.id, workspaceId: workspace.id };
        const nodes = await call('list_nodes', {}); assert.equal(nodes.length, 1); assert.equal(workspace.nodeId, nodes[0].id);
        const node = await call('get_node', { nodeId: workspace.nodeId }); assert.equal(node.status, 'online'); assert.equal(node.workspaces[0].id, workspace.id);
        const nodeResponse = await fetch(url + '/api/tools/get_node', { method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-client': 'Atlas Web' }, body: JSON.stringify({ nodeId: workspace.nodeId }) });
        assert.equal(nodeResponse.status, 200); assert.equal((await nodeResponse.json()).id, workspace.nodeId);
        await fixture.store.pool.query('UPDATE workspaces SET dev_tasks=$2 WHERE id=$1', [workspace.id, { check: { executable: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'], timeoutMs: 5000 } }]);
        assert.equal((await call('workspace_list_dev_tasks', scope))[0].task, 'check');
        const dev = await call('workspace_run_dev_task', { ...scope, task: 'check' });
        assert.equal(dev.success, true); assert.equal(dev.stdout, repo); assert.equal(dev.nodeId, workspace.nodeId);
        assert.ok((await fixture.catalog.auditHistory({ workspaceId: workspace.id, operation: 'workspace.dev_invoked' })).some(event => (event.resulting as any).task === 'check'));
        await call('workspace_create_file', { ...scope, path: 'FootballAgent.cs', text: 'class FootballAgent {}' });
        const read = await call('workspace_read_file', { ...scope, path: 'FootballAgent.cs' });
        await call('workspace_patch_file', { ...scope, path: read.path, expectedSha256: read.sha256, oldText: '{}', newText: '{ /* goal */ }' });
        assert.equal((await call('workspace_search_files', { ...scope, query: 'goal' })).matches.length, 1);
        assert.equal((await call('workspace_list_files', scope)).entries.length, 1); await call('workspace_git_status', scope); await call('workspace_git_diff', scope);
        const bridge = await fetch(url + '/api/tools/get_workspace', { method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-client': 'Observatory' }, body: JSON.stringify(scope) }); assert.equal(bridge.status, 200);
        const inspection = await fetch(url + '/api/tools/workspace_read_file', { method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-client': 'Observatory' }, body: JSON.stringify({ ...scope, path: '.env' }) });
        assert.equal(inspection.status, 400);
        const readAudit = await fixture.catalog.auditHistory({ workspaceId: workspace.id, operation: 'workspace.file_read' });
        assert.ok(readAudit.some(e => e.client === 'Observatory' && (e.resulting as any).outcome === 'failed'));
        const denied = await fetch(url + '/api/tools/get_workspace', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.invalid' }, body: JSON.stringify(scope) }); assert.equal(denied.status, 403);
        assert.equal((await call('get_atlas_status', {})).version, '2.0.0');
        const latest = await call('workspace_read_file', { ...scope, path: read.path }); await call('workspace_delete_file', { ...scope, path: read.path, expectedSha256: latest.sha256 }); await call('archive_workspace', scope);
    } finally { await client.close(); await new Promise<void>(resolve => http.close(() => resolve())); await services.lifecycle.close(); if (oldRoots === undefined) delete process.env.ATLAS_WORKSPACE_ROOTS; else process.env.ATLAS_WORKSPACE_ROOTS = oldRoots; }
});
