import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ServerLifecycle } from '../apps/server/src/server/lifecycle.js';
import { loadServerConfig } from '../apps/server/src/server/config.js';
import { createMcpTransport } from '../apps/server/src/api/mcp/index.js';
import { ApplicationRegistry } from '../apps/server/src/apps/registry.js';
import { portfolioApplication } from '../apps/server/src/apps/portfolio-definition.js';
import { footballTrainingApplication } from '../apps/server/src/apps/football-training.js';
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

test('Node topology stacks before laptop shell widths cause server-card overlap', async () => {
    // Source-level guard: the real four-node layout still needs a browser visual check.
    const css = await readFile('apps/web/src/workspaces.css', 'utf8');
    const stackRule = css.match(/@media\s*\(max-width:\s*(\d+)px\)\s*\{\s*\.node-topology-layout\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.ok(stackRule, 'Expected a single-column topology media rule');
    assert.ok(Number(stackRule[1]) >= 1240, 'Topology must stack before the map becomes too narrow');
});

test('Atlas Control exposes Server, Node and Web as separate services with legacy aliases', async () => {
    const source = await readFile('scripts/atlas-control.mjs', 'utf8');
    assert.match(source, /server: \{ label: "Atlas Server"/);
    assert.match(source, /node: \{ label: "Local Dev Node"/);
    assert.match(source, /hostedNodeService = \{ label: "Hosted Atlas Node"/);
    assert.match(source, /web: \{ label: "Atlas Web"/);
    assert.match(source, /atlas: "server"/);
    assert.match(source, /observatory: "web"/);
    assert.match(source, /for \(const name of \["postgres", "server", "node", "web"/);
    assert.match(source, /if \(hosted\).*startHostedNode\(\)/s);
    assert.match(source, /args: \["run", "start:node"\]/);
    assert.match(source, /args: \["run", "dev:node"\]/);
    assert.match(source, /stopLocalNode\(\)/);
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
    const applications = new ApplicationRegistry([portfolioApplication({ portfolio: {} as any, media: {} as any, askPortfolio: {} as any, contentful: {} as any }), footballTrainingApplication({ call: async () => null } as any)]);
    const server = createMcpTransport({ portfolio: {}, media: {}, applications, dispatch: async () => null } as unknown as TransportServices);
    const client = new Client({ name: 'architecture-contract', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(a); await client.connect(b);
        const { tools } = await client.listTools();
        const v2 = ['create_node_enrolment', 'update_node', 'rotate_node_credential', 'revoke_node', 'assign_workspace_node',
            'list_node_share_approvals', 'update_node_share_approval'];
        const additivePortfolio = ['patch_portfolio_entry', 'preview_portfolio_entry', 'set_portfolio_media'];
        const gitWrites = ['workspace_git_create_branch', 'workspace_git_switch_branch', 'workspace_git_stage', 'workspace_git_commit', 'workspace_git_push_branch', 'workspace_git_open_pull_request'];
        // Checkout-aware tools now expose an additive checkoutId selector.
        // Keep the original frozen snapshot untouched for all other APIs;
        // the checkout layer has its own explicit compatibility assertions.
        const checkoutMigrated = (name: string) => ['get_workspace', 'update_workspace', 'archive_workspace'].includes(name) ||
            name.startsWith('workspace_') || name.startsWith('unity_');
        const stable = tools.filter(tool => !checkoutMigrated(tool.name) && !['list_nodes', 'get_node', 'workspace_list_dev_tasks', 'workspace_run_dev_task', 'list_applications', 'list_all_applications', 'get_application', ...v2, ...additivePortfolio, ...gitWrites, 'search_everything', 'read_node_logs', 'read_server_diagnostics', 'query_monitoring_activity', 'list_node_releases', 'plan_node_update', 'get_storage_usage', 'workspace_git_list_worktrees', 'workspace_git_clone_repository', 'workspace_git_create_worktree', 'workspace_git_remove_worktree', 'workspace_git_retirement_preflight', 'list_github_repositories', 'list_workspaces', 'list_logical_workspaces', 'attach_checkout_repository', 'link_workspace_project', 'unlink_workspace_project', 'link_logical_workspace_project', 'unlink_logical_workspace_project'].includes(tool.name) && !tool.name.startsWith('football_')).map(({ name, inputSchema }) => ({ name, inputSchema }));
        const create = stable.find(item => item.name === 'create_workspace');
        if (create) delete (create.inputSchema as any).properties.nodeId;
        const byName = (a: any, b: any) => String(a.name).localeCompare(String(b.name));
        // Workspace V2 makes projectId optional for legacy Workspace/Unity tools.
        // All previous parameters and their types remain compatible.
        for (const item of expected) {
            if (['create_workspace', 'get_workspace', 'update_workspace', 'archive_workspace'].includes(item.name) ||
                item.name.startsWith('workspace_') || item.name.startsWith('unity_')) {
                const required = item.inputSchema.required as string[] | undefined;
                if (required) item.inputSchema.required = required.filter(value => value !== 'projectId');
            }
        }
        assert.deepEqual(stable.sort(byName), expected.filter((item: any) =>
            !checkoutMigrated(item.name)).sort(byName));
        for (const name of ['get_workspace', 'workspace_read_file', 'workspace_git_status',
            'unity_status', 'workspace_git_remove_worktree']) {
            const tool = tools.find(item => item.name === name);
            assert.ok(tool, `Missing migrated checkout operation: ${name}`);
            assert.ok(tool.inputSchema.properties?.checkoutId, `${name} must advertise checkoutId`);
            assert.ok(tool.inputSchema.properties?.workspaceId, `${name} must keep legacy workspaceId`);
        }
        // Project link/unlink retain their required Project selector even though
        // the checkout selector can use either the old or new spelling.
        for (const name of ['link_workspace_project', 'unlink_workspace_project']) {
            const tool = tools.find(item => item.name === name);
            assert.ok(tool, `Missing Project association tool: ${name}`);
            assert.ok(tool.inputSchema.required?.includes('projectId'),
                `${name} must advertise projectId as required to MCP clients`);
            assert.ok(tool.inputSchema.properties?.checkoutId,
                `${name} must still advertise the explicit checkout selector`);
            assert.ok(tool.inputSchema.properties?.workspaceId,
                `${name} must still advertise legacy checkout selection`);
        }
        const retired = tools.find(item => item.name === 'workspace_git_remove_worktree');
        assert.ok(retired?.inputSchema.properties?.targetCheckoutId,
            'Destructive retirement must also advertise explicit targetCheckoutId');
        assert.ok(retired?.inputSchema.properties?.targetWorkspaceId,
            'Legacy targetWorkspaceId must remain available');
        assert.ok(!tools.some(tool => tool.name.startsWith('sessions_')));
        assert.ok(tools.some(tool => tool.name === 'search_everything'), 'Command search must be exposed by the shared MCP transport');
        const storageUsage = tools.find(tool => tool.name === 'get_storage_usage');
        assert.ok(storageUsage, 'Read-only storage metrics must be exposed by the MCP transport');
        assert.deepEqual(storageUsage.inputSchema.properties?.refresh, { type: 'boolean' });
        assert.deepEqual(tools.filter(tool => additivePortfolio.includes(tool.name)).map(tool => tool.name), additivePortfolio);
        assert.deepEqual(tools.filter(tool => ['list_applications', 'list_all_applications', 'get_application'].includes(tool.name)).map(tool => tool.name), ['list_applications', 'list_all_applications', 'get_application']);
        assert.deepEqual(tools.filter(tool => v2.includes(tool.name)).map(tool => tool.name).sort(), [...v2].sort());
        assert.deepEqual(tools.filter(tool => gitWrites.includes(tool.name)).map(tool => tool.name), gitWrites);
        assert.deepEqual(tools.filter(tool => ['list_nodes', 'get_node', 'read_node_logs', 'workspace_list_dev_tasks', 'workspace_run_dev_task'].includes(tool.name)).map(tool => tool.name), ['workspace_list_dev_tasks', 'workspace_run_dev_task', 'list_nodes', 'get_node', 'read_node_logs']);
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
