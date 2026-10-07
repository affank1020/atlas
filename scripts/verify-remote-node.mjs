#!/usr/bin/env node
/** A real child-process Node and WebSocket transport against an isolated schema. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { databaseFixture, cleanupDatabases } from '../test/database.ts';
import { composeServer } from '../apps/server/dist/server/composition.js';
import { loadServerConfig } from '../apps/server/dist/server/config.js';
import { createHttpTransport } from '../apps/server/dist/api/http/index.js';

const root = await mkdtemp(path.join(tmpdir(), 'atlas-node-verify-'));
let child;
let http;
let services;
try {
  const fixture = await databaseFixture();
  const nodeId = (await fixture.store.pool.query("SELECT id FROM nodes WHERE local_key='local'")).rows[0].id;
  await writeFile(path.join(root, 'marker.txt'), 'verified over remote Node\n');
  services = composeServer(loadServerConfig({ DATABASE_URL: fixture.databaseUrl, ATLAS_NODE_EXECUTION: 'remote', ATLAS_HOST: '127.0.0.1' }));
  const ticket = await services.identity.ticket(nodeId, true);
  const { credential: token } = await services.identity.enrol({ token: ticket.enrolmentToken, name: 'Verification Node', platform: process.platform });
  http = createHttpTransport(services);
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const port = http.address().port;
  const base = `http://127.0.0.1:${port}`;
  const nodeEnv = path.join(root, 'node.env');
  await writeFile(nodeEnv, `ATLAS_NODE_ID=${nodeId}\nATLAS_NODE_NAME=Verification Node\nATLAS_SERVER_URL=ws://127.0.0.1:${port}/node/connect\nATLAS_NODE_CREDENTIAL=${token}\nATLAS_WORKSPACE_ROOTS=${root}\n`, { mode: 0o600 });
  const call = async (tool, input) => {
    const response = await fetch(`${base}/api/tools/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return response.json();
  };
  const waitStatus = async wanted => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = await call('get_node', { nodeId });
      if (value.status === wanted) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Node did not become ${wanted}`);
  };
  const startNode = () => {
    const env = { ...process.env, ATLAS_NODE_ENV_FILE: nodeEnv };
    delete env.ATLAS_NODE_ID; delete env.ATLAS_NODE_CREDENTIAL; delete env.ATLAS_WORKSPACE_ROOTS; delete env.ATLAS_SERVER_URL;
    return spawn(process.execPath, ['apps/node/dist/platforms/desktop/main.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const stopNode = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Node did not stop')), 5000))]);
  };
  child = startNode(); await waitStatus('online');
  const project = await fixture.catalog.createProject({ name: 'Remote Node verification' });
  const workspace = await call('create_workspace', { projectId: project.id, name: 'Verification', rootPath: root });
  if (!workspace.id || workspace.nodeId !== nodeId) throw new Error(`Workspace binding failed: ${JSON.stringify(workspace)}`);
  const scope = { projectId: project.id, workspaceId: workspace.id };
  const read = await call('workspace_read_file', { ...scope, path: 'marker.txt' });
  if (read.text !== 'verified over remote Node\n') throw new Error('Remote file read failed');
  const search = await call('workspace_search_files', { ...scope, query: 'verified' });
  if (!JSON.stringify(search).includes('marker.txt')) throw new Error('Remote file search failed');
  const git = await call('workspace_git_status', scope);
  if (git.error) throw new Error(`Remote Git status failed: ${git.error}`);
  await fixture.store.pool.query('UPDATE workspaces SET dev_tasks=$2 WHERE id=$1', [workspace.id, { check: { executable: process.execPath, args: ['-e', 'process.stdout.write("verified task")'] } }]);
  const task = await call('workspace_run_dev_task', { ...scope, task: 'check' });
  if (!task.success || task.stdout !== 'verified task') throw new Error(`Remote dev task failed: ${JSON.stringify(task)}`);
  await stopNode(); await waitStatus('offline');
  const offline = await call('workspace_read_file', { ...scope, path: 'marker.txt' });
  if (offline.error !== 'NODE_OFFLINE') throw new Error(`Offline operation did not fail closed: ${JSON.stringify(offline)}`);
  child = startNode(); await waitStatus('online');
  const restored = await call('workspace_read_file', { ...scope, path: 'marker.txt' });
  if (restored.text !== read.text) throw new Error('Reconnect did not restore Workspace routing');
  console.log(`Remote Node verified: ${nodeId}; Workspace ${workspace.id}; files, Git, dev, offline and reconnect passed.`);
  await stopNode();
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (http) await new Promise(resolve => http.close(resolve));
  await services?.lifecycle.close().catch(() => undefined);
  await cleanupDatabases();
  await rm(root, { recursive: true, force: true });
}
