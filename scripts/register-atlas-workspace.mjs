#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
loadEnv({ path: new URL('../apps/server/.env', import.meta.url), quiet: true });
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadServerConfig } from '../apps/server/dist/server/config.js';
import { configureDevTasks, readDevTasks } from './lib/workspace-dev.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = loadServerConfig();
const tasks = await readDevTasks(new URL('../config/atlas-dev-tasks.json', import.meta.url));
// Atlas Node validates this root over the authenticated connection.
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const base = `http://${config.host}:${config.port}`;
async function call(name, input = {}) {
    const response = await fetch(`${base}/api/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-client': 'atlas-local-admin' }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${name}: ${result.message ?? result.error}`);
    return result;
}
async function register(catalog, workspaces) {
    const matching = (await catalog.listProjects()).filter(project => project.name === 'Atlas');
    if (matching.length > 1) throw new Error('More than one active Atlas project; choose one explicitly.');
    const project = matching[0] ?? await catalog.createProject({ name: 'Atlas', description: 'Atlas Server development workspace', client: 'atlas-local-admin' });
    const existing = await workspaces.call('list_project_workspaces', { projectId: project.id });
    if (existing.length > 1) throw new Error('Atlas Project has multiple active Workspaces.');
    const previous = existing[0];
    if (previous && previous.rootPath !== root) {
        const expected = '/Users/affankhan/Documents/GitRepos/atlas';
        if (previous.rootPath !== expected) throw new Error('Atlas Project has an unexpected Workspace root.');
        const node = await workspaces.call('get_node', { nodeId: previous.nodeId });
        if (node.status !== 'online') throw new Error('Existing Atlas Node must be online before Workspace migration.');
        await workspaces.call('archive_workspace', { projectId: project.id, workspaceId: previous.id, client: 'atlas-local-admin' });
    }
    const workspace = previous?.rootPath === root ? previous : await workspaces.call('create_workspace', { projectId: project.id, name: 'Atlas', rootPath: root, nodeId: previous?.nodeId, kind: 'generic', client: 'atlas-local-admin' });
    await configureDevTasks(pool, workspace.id, tasks);
    console.log(JSON.stringify({ projectId: project.id, workspaceId: workspace.id, nodeId: workspace.nodeId, tasks: Object.keys(tasks) }, null, 2));
}
try {
    // A running Server owns the local Node's presence. Use its normal Workspace API
    // rather than briefly registering a competing local runtime and marking it offline.
    let serverAvailable = false;
    try { const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }); serverAvailable = response.ok; } catch { /* No running Server. */ }
    if (!serverAvailable) throw new Error('Start Atlas Server and Atlas Node before registering this Workspace.');
    await register({ listProjects: () => call('list_projects'), createProject: input => call('create_project', input) }, { call });

} finally { await pool.end(); }
