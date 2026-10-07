// Exercises the production MCP transport against an isolated PostgreSQL schema/repository.
// Run after npm run build. Does not bind or edit the user's actual repositories.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { databaseFixture, cleanupDatabases } from '../dist/test/database.js';
import { createAtlasHttpServer } from '../dist/src/server.js';
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'atlas-workspace-smoke-')));
process.env.ATLAS_WORKSPACE_ROOTS = root;
const fixture = await databaseFixture();
const server = createAtlasHttpServer({ databaseUrl: fixture.databaseUrl });
const client = new Client({ name: 'workspace-manual-verification', version: '1' });
try {
    execFileSync('/usr/bin/git', ['init', '-q', root]);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    const call = async (name, args) => {
        const response = await client.callTool({ name, arguments: args });
        assert.ok(!response.isError, JSON.stringify(response));
        console.log(`PASS ${name}`); return response.structuredContent.result;
    };
    const project = await call('create_project', { name: 'Workspace manual smoke' });
    const workspace = await call('create_workspace', { projectId: project.id, name: 'Football fixture', rootPath: root });
    const scope = { projectId: project.id, workspaceId: workspace.id };
    await call('workspace_create_file', { ...scope, path: 'FootballAgent.cs', text: 'class FootballAgent { int goals = 0; }\n', client: 'manual-smoke' });
    execFileSync('/usr/bin/git', ['-C', root, 'add', 'FootballAgent.cs']);
    await call('workspace_list_files', scope);
    await call('workspace_search_files', { ...scope, query: 'FootballAgent' });
    const read = await call('workspace_read_file', { ...scope, path: 'FootballAgent.cs' });
    await call('workspace_patch_file', { ...scope, path: read.path, expectedSha256: read.sha256, oldText: 'goals = 0', newText: 'goals = 1', client: 'manual-smoke' });
    assert.equal((await call('workspace_git_status', scope)).dirty, true);
    const diff = await call('workspace_git_diff', scope); assert.match(diff.diff, /goals = 1/);
    console.log(diff.diff);
    assert.equal((await call('unity_status', scope)).state, 'no_adapter');
    const history = await call('get_audit_history', { workspaceId: workspace.id });
    assert.ok(history.some(x => x.operation === 'workspace.file_patched'));
    await call('archive_workspace', scope);
    console.log('Workspace MCP smoke completed; fixture will be removed.');
} finally {
    await client.close(); await new Promise(resolve => server.close(resolve));
    await cleanupDatabases(); await rm(root, { recursive: true, force: true });
}
