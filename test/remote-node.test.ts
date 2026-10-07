import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { databaseFixture, cleanupDatabases } from './database.js';
import { composeServer } from '../apps/server/src/server/composition.js';
import { loadServerConfig } from '../apps/server/src/server/config.js';
import { createHttpTransport } from '../apps/server/src/api/http/index.js';
import { LocalNodeRuntime } from '../apps/node/src/platforms/desktop/runtime.js';
import { StandaloneNode } from '../apps/node/src/core/connection/standalone.js';
import { RemoteNodeRuntime } from '../apps/server/src/infrastructure/nodes/remote-runtime.js';

after(cleanupDatabases);
const folders: string[] = [];
after(async () => { await Promise.all(folders.map(folder => rm(folder, { recursive: true, force: true }))); });

test('standalone Node serves Workspace calls, enforces auth, and fails closed through disconnect/reconnect', async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(tmpdir(), 'atlas-remote-node-')); folders.push(root);
    await writeFile(path.join(root, 'marker.txt'), 'remote marker');
    const config = loadServerConfig({ DATABASE_URL: fixture.databaseUrl, ATLAS_NODE_EXECUTION: 'remote', ATLAS_HOST: '127.0.0.1' });
    const services = composeServer(config);
    assert.equal(services.nodes.hasLocalRuntime, false);
    const http = createHttpTransport(services);
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const port = (http.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${port}/node/connect`;
    const base = `http://127.0.0.1:${port}`;
    const nodeId = (await services.nodes.repository.getDefault()).id;
    const ticket = await services.identity.ticket(nodeId, true);
    const { credential: token } = await services.identity.enrol({ token: ticket.enrolmentToken, name: 'Test Node', platform: 'test' });
    const makeNode = () => new StandaloneNode({ id: nodeId, name: 'Remote test Node', token, serverUrl: url, reconnectMinMs: 1000, reconnectMaxMs: 1000 }, new LocalNodeRuntime([root], new Map()));
    let node = makeNode();
    node.on('connectionError', message => console.error('Test Node connection:', message));
    const call = async (tool: string, input: unknown) => {
        const response = await fetch(`${base}/api/tools/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() as any };
    };
    try {
        const unauthorized = new WebSocket(url, { headers: { Authorization: 'Bearer wrong' } });
        await assert.rejects(once(unauthorized, 'open'));
        const online = once(node, 'online'); node.start(); await online;
        assert.equal(services.nodeGateway?.connectedCount, 1);
        assert.equal((await call('get_node', { nodeId })).body.status, 'online');
        const project = await fixture.catalog.createProject({ name: 'Remote transport' });
        const created = await call('create_workspace', { projectId: project.id, name: 'Remote', rootPath: root });
        assert.equal(created.status, 200, JSON.stringify(created.body));
        const workspaceId = created.body.id;
        assert.equal(created.body.nodeId, nodeId);
        const scope = { projectId: project.id, workspaceId };
        const read = await call('workspace_read_file', { ...scope, path: 'marker.txt' });
        assert.equal(read.body.text, 'remote marker');
        assert.equal((await call('workspace_list_files', scope)).status, 200);
        assert.equal((await call('workspace_git_status', scope)).status, 200);
        await fixture.store.pool.query('UPDATE workspaces SET dev_tasks=$2 WHERE id=$1', [workspaceId, {
            check: { executable: process.execPath, args: ['-e', 'process.stdout.write("remote task")'] },
            fail: { executable: process.execPath, args: ['-e', 'process.stderr.write("failed");process.exit(7)'] },
            hang: { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 30000 },
        }]);
        const task = await call('workspace_run_dev_task', { ...scope, task: 'check' });
        assert.equal(task.body.success, true, JSON.stringify(task.body));
        assert.equal(task.body.stdout, 'remote task');
        assert.equal((await call('workspace_run_dev_task', { ...scope, task: 'unknown' })).body.error, 'TASK_UNAVAILABLE');
        const failed = await call('workspace_run_dev_task', { ...scope, task: 'fail' });
        assert.equal(failed.body.success, false); assert.equal(failed.body.exitCode, 7); assert.equal(failed.body.stderr, 'failed');
        assert.equal((await call('workspace_read_file', { projectId: project.id, workspaceId: '00000000-0000-4000-8000-000000000001', path: 'marker.txt' })).body.error, 'NOT_FOUND');
        await fixture.store.pool.query("UPDATE nodes SET capabilities=ARRAY['workspace.files'] WHERE id=$1", [nodeId]);
        assert.equal((await call('workspace_git_status', scope)).body.error, 'CAPABILITY_UNAVAILABLE');
        await fixture.store.pool.query("UPDATE nodes SET capabilities=ARRAY['workspace.files','workspace.git','workspace.dev'] WHERE id=$1", [nodeId]);
        const running = call('workspace_run_dev_task', { ...scope, task: 'hang' });
        await new Promise(resolve => setTimeout(resolve, 100));
        await node.stop();
        assert.equal((await running).body.error, 'NODE_DISCONNECTED');
        for (let i = 0; i < 50 && (await services.nodes.get(nodeId)).status === 'online'; i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal((await services.nodes.get(nodeId)).status, 'offline');
        assert.equal((await call('workspace_read_file', { ...scope, path: 'marker.txt' })).body.error, 'NODE_OFFLINE');
        node = makeNode(); const reconnected = once(node, 'online'); node.start(); await reconnected;
        assert.equal((await call('workspace_read_file', { ...scope, path: 'marker.txt' })).body.text, 'remote marker');
        assert.equal((await call('get_node', { nodeId })).body.hostedWorkspaceCount, 1);
        const replacement = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
        await once(replacement, 'open');
        const ack = once(replacement, 'message');
        replacement.send(JSON.stringify({ type: 'register', protocol: 2, nodeId, name: 'Replacement', platform: 'test', capabilities: ['workspace.files'] }));
        assert.equal(JSON.parse(String((await ack)[0])).type, 'registered');
        await node.stop();
        assert.equal((await call('get_node', { nodeId })).body.status, 'online');
        assert.equal((await call('workspace_git_status', scope)).body.error, 'CAPABILITY_UNAVAILABLE');
        replacement.close();
        for (let i = 0; i < 50 && (await services.nodes.get(nodeId)).status === 'online'; i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal((await services.nodes.get(nodeId)).status, 'offline');
    } finally {
        await node.stop();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await services.lifecycle.close();
    }
});

test('failed registration after persistence clears stale online presence', async () => {
    const fixture = await databaseFixture();
    const services = composeServer(loadServerConfig({ DATABASE_URL: fixture.databaseUrl, ATLAS_NODE_EXECUTION: 'remote', ATLAS_HOST: '127.0.0.1' }));
    const http = createHttpTransport(services);
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const nodeId = (await services.nodes.repository.getDefault()).id;
    const ticket = await services.identity.ticket(nodeId, true);
    const { credential } = await services.identity.enrol({ token: ticket.enrolmentToken, name: 'Fenced Node', platform: 'test' });
    const originalAuthenticate = services.identity.authenticate.bind(services.identity);
    let authenticationCount = 0;
    services.identity.authenticate = async (id, token) => {
        authenticationCount += 1;
        if (authenticationCount === 2) throw new Error('Credential changed during registration');
        return originalAuthenticate(id, token);
    };
    const socket = new WebSocket(`ws://127.0.0.1:${(http.address() as { port: number }).port}/node/connect`, { headers: { Authorization: `Bearer ${credential}` } });
    try {
        await once(socket, 'open');
        const closed = once(socket, 'close');
        socket.send(JSON.stringify({ type: 'register', protocol: 2, nodeId, name: 'Fenced Node', platform: 'test', capabilities: ['workspace.files'] }));
        await closed;
        assert.equal(services.nodeGateway!.connectedCount, 0);
        assert.equal((await services.nodes.get(nodeId)).status, 'offline');
    } finally {
        socket.terminate();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await services.lifecycle.close();
    }
});

test('remote request deadlines remove pending calls without interpreting silence as task failure', async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
        await once(socket, 'open');
        const runtime = new RemoteNodeRuntime(socket, ['workspace.files'], 25);
        await assert.rejects(runtime.bind('/some/root'), (error: any) => error.code === 'NODE_TIMEOUT');
        assert.equal(runtime.pendingCount, 0);
        runtime.dispose();
    } finally {
        socket.terminate(); sockets.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

test('standalone Node reconnects after Atlas Server restart with the same Workspace identity', async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(tmpdir(), 'atlas-remote-restart-')); folders.push(root);
    await writeFile(path.join(root, 'marker.txt'), 'after restart');
    const config = loadServerConfig({ DATABASE_URL: fixture.databaseUrl, ATLAS_NODE_EXECUTION: 'remote', ATLAS_HOST: '127.0.0.1' });
    let services = composeServer(config);
    let http = createHttpTransport(services);
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const port = (http.address() as { port: number }).port;
    const nodeId = (await services.nodes.repository.getDefault()).id;
    const ticket = await services.identity.ticket(nodeId, true);
    const { credential: token } = await services.identity.enrol({ token: ticket.enrolmentToken, name: 'Test Node', platform: 'test' });
    const node = new StandaloneNode({ id: nodeId, name: 'Restart test', token, serverUrl: `ws://127.0.0.1:${port}/node/connect`, reconnectMinMs: 20, reconnectMaxMs: 100 }, new LocalNodeRuntime([root], new Map()));
    try {
        const online = once(node, 'online'); node.start(); await online;
        const project = await fixture.catalog.createProject({ name: 'Restart' });
        const workspace: any = await services.workspaces.call('create_workspace', { projectId: project.id, name: 'Restart', rootPath: root });
        await services.nodeGateway!.close();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await services.lifecycle.close();
        services = composeServer(config); http = createHttpTransport(services);
        const restored = once(node, 'online');
        http.listen(port, '127.0.0.1'); await once(http, 'listening');
        await restored;
        const read: any = await services.workspaces.call('workspace_read_file', { projectId: project.id, workspaceId: workspace.id, path: 'marker.txt' });
        assert.equal(read.text, 'after restart');
        assert.equal((await services.nodes.get(nodeId)).status, 'online');
        assert.equal((await services.nodes.get(nodeId)).hostedWorkspaceCount, 1);
    } finally {
        await node.stop();
        await services.nodeGateway?.close();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await services.lifecycle.close();
    }
});

test('rotating a live Node credential immediately fences its old session', async () => {
    const fixture = await databaseFixture();
    const root = await mkdtemp(path.join(tmpdir(), 'atlas-rotate-node-')); folders.push(root);
    const services = composeServer(loadServerConfig({ DATABASE_URL: fixture.databaseUrl, ATLAS_NODE_EXECUTION: 'remote', ATLAS_HOST: '127.0.0.1' }));
    const http = createHttpTransport(services);
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const nodeId = (await services.nodes.repository.getDefault()).id;
    const ticket = await services.identity.ticket(nodeId, true);
    const { credential } = await services.identity.enrol({ token: ticket.enrolmentToken, name: 'Rotating Node', platform: 'test' });
    const node = new StandaloneNode({ id: nodeId, name: 'Rotating Node', token: credential, serverUrl: `ws://127.0.0.1:${(http.address() as {port:number}).port}/node/connect`, reconnectMinMs: 1000 }, new LocalNodeRuntime([root], new Map()));
    try {
        const online = once(node, 'online'); node.start(); await online;
        assert.equal(services.nodeGateway!.connectedCount, 1);
        const offline = once(node, 'offline');
        await services.identity.ticket(nodeId, true);
        await offline;
        assert.equal(services.nodeGateway!.connectedCount, 0);
        await assert.rejects(services.identity.authenticate(nodeId, credential), (error: any) => error.code === 'NODE_AUTH_INVALID');
    } finally {
        await node.stop();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await services.lifecycle.close();
    }
});
