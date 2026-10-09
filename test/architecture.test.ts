import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ServerLifecycle } from '../apps/server/src/server/lifecycle.js';
import { loadServerConfig } from '../apps/server/src/server/config.js';
import { createMcpTransport } from '../apps/server/src/api/mcp/index.js';
import type { TransportServices } from '../apps/server/src/server/dispatch.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function sources(directory: string): Promise<string[]> {
    return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? sources(path.join(directory, entry.name)) : entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : []))).flat();
}
test('dependency boundaries hold transitively, including compatibility re-exports', async () => {
    const root = path.resolve('apps/server/src');
    const files = await sources(root);
    const graph = new Map<string, string[]>();
    for (const file of files) {
        const text = await readFile(file, 'utf8');
        const imports = [...text.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)].map(match => path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, '.ts')));
        graph.set(file, imports);
    }
    function reachable(start: string, seen = new Set<string>()): Set<string> {
        if (seen.has(start)) return seen;
        seen.add(start);
        for (const dependency of graph.get(start) ?? []) reachable(dependency, seen);
        return seen;
    }
    const rules: Array<[string, string[]]> = [
        ['core/', ['api/', 'ai/', 'retrieval/', 'fabric/', 'infrastructure/', 'views/', 'catalog.ts', 'server/']],
        ['views/', ['api/', 'ai/', 'fabric/', 'server/']],
        ['ai/', ['api/', 'fabric/', 'infrastructure/database/', 'server/composition.ts']],
        ['retrieval/', ['api/', 'ai/', 'fabric/']],
        ['infrastructure/', ['api/', 'server/composition.ts', 'catalog.ts']],
        ['nodes/', ['infrastructure/', 'api/', 'server/']],
        ['workspaces/application.ts', ['infrastructure/', 'api/', 'workspaces/service.ts', 'workspaces/adapter.ts', 'workspaces/files.ts']],
    ];
    for (const [boundary, forbidden] of rules) {
        for (const file of files.filter(file => path.relative(root, file).startsWith(boundary))) {
            for (const dependency of reachable(file)) {
                const relative = path.relative(root, dependency);
                assert.ok(!forbidden.some(prefix => relative.startsWith(prefix)), `${path.relative(root, file)} reaches forbidden ${relative}`);
            }
        }
    }
    for (const file of files.filter(file => path.relative(root, file).startsWith('nodes/') || path.relative(root, file) === 'workspaces/application.ts')) {
        assert.doesNotMatch(await readFile(file, 'utf8'), /(?:node:)?(?:fs|child_process|path|os)["']/);
    }
    for (const file of files.filter(file => path.relative(root, file).startsWith('api/'))) {
        const text = await readFile(file, 'utf8');
        assert.doesNotMatch(text, /process\.env|new (?:Pool|AtlasStore|CoreService|WorkspaceService|PortfolioService)|\.query\(/, file);
    }
});

test('Atlas Control exposes Server, Node and Web as separate services with legacy aliases', async () => {
    const source = await readFile('scripts/atlas-control.mjs', 'utf8');
    assert.match(source, /server: \{ label: "Atlas Server"/);
    assert.match(source, /node: \{ label: "Atlas Node"/);
    assert.match(source, /web: \{ label: "Atlas Web"/);
    assert.match(source, /atlas: "server"/);
    assert.match(source, /observatory: "web"/);
    assert.match(source, /\["postgres", "server", .*\["node"\].*"web"/s);
    assert.match(source, /\["tunnel", "ollama", "web", "node", "server"/);
    const help = spawnSync('./atlasctl', ['--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Services: postgres, server, node, web, tunnel, ollama/);
    assert.match(help.stdout, /Legacy aliases: atlas → server, observatory → web/);
    const status = spawnSync('./atlasctl', ['status'], { encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Atlas Server/);
    assert.match(status.stdout, /Atlas Node/);
    assert.match(status.stdout, /Atlas Web/);
});

test('MCP names and argument schemas match the complete pre-refactor contract', async () => {
    const expected = JSON.parse(await readFile('test/mcp-contract.json', 'utf8'));
    for (const item of expected.filter((tool: any) => ['get_audit_history', 'get_recent_activity'].includes(tool.name))) {
        const operations = item.inputSchema.properties.operation.enum as string[];
        const index = operations.indexOf('workspace.unity_invoked') + 1;
        operations.splice(index, 0, 'workspace.dev_invoked', 'workspace.dev_tasks_listed', 'workspace.dev_tasks_configured');
    }
    const server = createMcpTransport({ portfolio: {}, media: {}, dispatch: async () => null } as unknown as TransportServices);
    const client = new Client({ name: 'architecture-contract', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(a); await client.connect(b);
        const { tools } = await client.listTools();
        const v2 = ['create_node_enrolment', 'update_node', 'rotate_node_credential', 'revoke_node', 'assign_workspace_node'];
        const stable = tools.filter(tool => !['list_nodes', 'get_node', 'workspace_list_dev_tasks', 'workspace_run_dev_task', ...v2].includes(tool.name)).map(({ name, inputSchema }) => ({ name, inputSchema }));
        const create = stable.find(item => item.name === 'create_workspace');
        if (create) delete (create.inputSchema as any).properties.nodeId;
        assert.deepEqual(stable, expected);
        assert.deepEqual(tools.filter(tool => v2.includes(tool.name)).map(tool => tool.name), v2);
        assert.deepEqual(tools.filter(tool => ['list_nodes', 'get_node', 'workspace_list_dev_tasks', 'workspace_run_dev_task'].includes(tool.name)).map(tool => tool.name), ['workspace_list_dev_tasks', 'workspace_run_dev_task', 'list_nodes', 'get_node']);
    } finally { await client.close(); await server.close(); }
});

test('shutdown drains background work before closing every resource, and is idempotent', async () => {
    const events: string[] = [];
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const lifecycle = new ServerLifecycle([{ close: async () => { events.push('closed'); } }]);
    lifecycle.run('test', async () => { events.push('started'); await pending; events.push('finished'); });
    await Promise.resolve();
    const closing = lifecycle.close();
    assert.equal(lifecycle.close(), closing);
    assert.throws(() => lifecycle.run('late', async () => {}), /stopping/);
    assert.deepEqual(events, ['started']);
    finish(); await closing;
    assert.deepEqual(events, ['started', 'finished', 'closed']);
});

test('background failures do not leak error payloads and one close failure does not skip other resources', async () => {
    const messages: string[] = [];
    let closed = false;
    const lifecycle = new ServerLifecycle([
        { close: async () => { throw new Error('close failed'); } },
        { close: async () => { closed = true; } },
    ], message => messages.push(message));
    lifecycle.run('sync', async () => { throw new Error('secret-token'); });
    await assert.rejects(lifecycle.close(), AggregateError);
    assert.equal(closed, true);
    assert.deepEqual(messages, ['sync failed; inspect the integration status.']);
});

test('configuration validates listen port and captures independent execution/provider settings', () => {
    const env = { DATABASE_URL: 'postgresql://localhost/atlas', ATLAS_PORT: '1234', ATLAS_WORKSPACE_ROOTS: ' /one, /two ', ATLAS_UNITY_ALLOWED_COMMANDS: ' inspect ', OLLAMA_URL: 'http://local:11434' };
    const config = loadServerConfig(env);
    env.ATLAS_WORKSPACE_ROOTS = '/changed';
    assert.equal(config.port, 1234);
    assert.deepEqual(config.workspace.roots, ['/one', '/two']);
    assert.deepEqual(config.unity.approvedCommands, ['inspect']);
    assert.equal(config.ai.baseUrl, 'http://local:11434');
    assert.throws(() => loadServerConfig({ DATABASE_URL: env.DATABASE_URL, ATLAS_PORT: 'NaN' }), /ATLAS_PORT/);
    assert.throws(() => loadServerConfig({ DATABASE_URL: env.DATABASE_URL, ATLAS_HOST: '0.0.0.0' }), /ATLAS_TRUSTED_INGRESS/);
    assert.equal(loadServerConfig({ DATABASE_URL: env.DATABASE_URL, ATLAS_HOST: '0.0.0.0', ATLAS_TRUSTED_INGRESS: 'true' }).host, '0.0.0.0');
    assert.throws(() => loadServerConfig({}), /DATABASE_URL/);
});

test('monorepo application packages preserve independent deployment boundaries', async () => {
    const root = path.resolve('.');
    const applications = ['apps/server', 'apps/node', 'apps/web', 'packages/protocol', 'packages/view-runtime'];
    const manifests = new Map<string, any>();
    for (const application of applications) manifests.set(application, JSON.parse(await readFile(path.join(root, application, 'package.json'), 'utf8')));
    const dependencyNames = (application: string) => Object.keys(manifests.get(application).dependencies ?? {});
    assert.ok(dependencyNames('apps/server').includes('@atlas/protocol'));
    assert.ok(dependencyNames('apps/node').includes('@atlas/protocol'));
    assert.ok(!dependencyNames('apps/server').includes('@atlas/node'));
    assert.ok(!dependencyNames('apps/node').includes('@atlas/server'));
    assert.ok(!dependencyNames('apps/web').includes('@atlas/server'));
    assert.ok(!dependencyNames('apps/web').includes('@atlas/node'));
    assert.ok(!dependencyNames('packages/protocol').some((name: string) => name.startsWith('@atlas/')));
    const code = await Promise.all(applications.map(async application => {
        const files = await sources(path.join(root, application, 'src'));
        return [application, await Promise.all(files.map(async file => [file, await readFile(file, 'utf8')]))] as const;
    }));
    for (const [application, files] of code) for (const [file, source] of files) {
        const imports = [...source.matchAll(/(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g)].map(match => match[1]);
        for (const imported of imports) {
            assert.ok(!imported.includes('apps/server') && !imported.includes('apps/node'), `${file} imports application source`);
            if (imported.startsWith('.')) {
                const target = path.resolve(path.dirname(file), imported);
                assert.ok(target.startsWith(path.join(root, application) + path.sep), `${file} imports outside its package: ${imported}`);
            }
            if (application === 'apps/server') assert.ok(!imported.startsWith('@atlas/node'), `${file} imports Node`);
            if (application === 'apps/node') assert.ok(!imported.startsWith('@atlas/server'), `${file} imports Server`);
            if (application === 'packages/protocol') assert.ok(!imported.startsWith('@atlas/'), `${file} imports an application`);
        }
    }
    const serverSources = (code.find(([application]) => application === 'apps/server')?.[1] ?? []).map(([, source]) => source).join('\n');
    assert.doesNotMatch(serverSources, /(?:import|new)\s+(?:LocalNodeRuntime|StandaloneNode)|(?:node:)?child_process["']/ );
});
