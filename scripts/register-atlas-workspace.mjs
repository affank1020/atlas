#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WorkspaceFiles } from '../dist/src/infrastructure/workspaces/files.js';
import { loadServerConfig } from '../dist/src/server/config.js';
import { composeServer } from '../dist/src/server/composition.js';
import { configureDevTasks, readDevTasks } from './lib/workspace-dev.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = loadServerConfig();
const tasks = await readDevTasks(new URL('../config/atlas-dev-tasks.json', import.meta.url));
// Validate the same local allow-list before creating any persistent Project.
await new WorkspaceFiles(config.workspace.roots).bind(root);
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
    if (existing.length && existing[0].rootPath !== root) throw new Error('Atlas project already has a different active Workspace.');
    const workspace = existing[0] ?? await workspaces.call('create_workspace', { projectId: project.id, name: 'Atlas', rootPath: root, kind: 'generic', client: 'atlas-local-admin' });
    await configureDevTasks(pool, workspace.id, tasks);
    console.log(JSON.stringify({ projectId: project.id, workspaceId: workspace.id, nodeId: workspace.nodeId, tasks: Object.keys(tasks) }, null, 2));
}
try {
    // A running Server owns the local Node's presence. Use its normal Workspace API
    // rather than briefly registering a competing local runtime and marking it offline.
    let serverAvailable = false;
    try { const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }); serverAvailable = response.ok; } catch { /* No running Server. */ }
    if (serverAvailable) {
        await register({ listProjects: () => call('list_projects'), createProject: input => call('create_project', input) }, { call });
    } else {
        const services = composeServer(config);
        try { await services.workspaces.runtime.bindLocal(root); await register(services.catalog, services.workspaces); }
        finally { await services.lifecycle.close(); }
    }
} finally { await pool.end(); }
