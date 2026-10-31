import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretSearch, searchEverywhere } from '../apps/server/src/server/global-search.js';

const project = { id: '11111111-1111-4111-8111-111111111111', name: 'Portfolio', description: 'Personal website' };
const node = { id: '22222222-2222-4222-8222-222222222222', name: 'Affans-MacBook-Pro', platform: 'darwin', status: 'online', hostedWorkspaceCount: 1, capabilities: ['node.logs'] };
function dependencies() {
    return {
        listProjects: async () => [project],
        listStores: async () => [{ id: 's1', name: 'Documents', description: 'Notes and research' }],
        views: { listViews: async () => [{ id: 'v1', name: 'Portfolio dashboard', description: 'Publishing overview' }] },
        applications: { list: () => [{ name: 'Portfolio Editor', slug: 'portfolio', description: 'Edit portfolio', projectId: project.id }] },
        nodes: { call: async (name: string) => name === 'list_nodes' ? [node] : { workspaces: [{ id: 'ws1', projectId: project.id, name: 'Mac Development' }] } },
        retrieval: { search: async () => ({ results: [{ record: { id: 'r1', data: { title: 'Markov processes notes' } }, store: { id: 's1', name: 'Documents' }, project, snippet: 'Revision and solutions', score: .7 }] }) },
    } as any;
}

test('command search interprets user intents without forcing fixed literal keywords', () => {
    assert.deepEqual(interpretSearch('Open the portfolio app'), { term: 'portfolio', intent: 'application', nodeActivity: false, nodeLogs: false, logSource: 'stdout', logLines: 100 });
    assert.deepEqual(interpretSearch('check activity for my Mac node'), { term: 'mac', intent: 'node', nodeActivity: true, nodeLogs: false, logSource: 'stdout', logLines: 100 });
    assert.deepEqual(interpretSearch('Find Markov notes'), { term: 'markov notes', intent: null, nodeActivity: false, nodeLogs: false, logSource: 'stdout', logLines: 100 });
    assert.deepEqual(interpretSearch('show the last 100 error lines from my Mac node'), { term: 'mac', intent: 'node', nodeActivity: true, nodeLogs: true, logSource: 'stderr', logLines: 100 });
});

test('launch-app query resolves an application without being confused by command words', async () => {
    const result = await searchEverywhere(dependencies(), { query: 'I want to open the Portfolio app' });
    assert.equal(result.results[0]?.kind, 'application');
    assert.equal(result.results[0]?.title, 'Portfolio Editor');
    assert.equal(result.results[0]?.href, '#/projects/' + project.id + '/applications/portfolio');
    assert.ok(!result.results.some(item => item.kind === 'record'));
});

test('node-log intent deep-links to Monitoring without reading logs in search', async () => {
    const result = await searchEverywhere(dependencies(), { query: 'check logs for my Mac node' });
    assert.equal(result.results[0]?.kind, 'node');
    assert.match(result.results[0]?.title || '', /logs/);
    assert.equal(result.results[0]?.action, undefined);
    assert.equal(result.results[0]?.href, '#/monitoring?tab=logs&nodeId=' + node.id + '&source=stdout&lines=100');
    assert.match(result.results[0]?.description || '', /Latest 100 lines/);
    const stdout = await searchEverywhere(dependencies(), { query: 'show the last 37 stdout lines from my Mac node' });
    assert.equal(stdout.results[0]?.href, '#/monitoring?tab=logs&nodeId=' + node.id + '&source=stdout&lines=37');
    const errors = await searchEverywhere(dependencies(), { query: 'show the last 100 error lines from my Mac node' });
    assert.equal(errors.results[0]?.href, '#/monitoring?tab=logs&nodeId=' + node.id + '&source=stderr&lines=100');
});

test('record search uses indexed Fabric results and includes incomplete-source diagnostics', async () => {
    const deps = dependencies();
    deps.listStores = async () => { throw new Error('Store unavailable'); };
    const result = await searchEverywhere(deps, { query: 'Markov notes' });
    assert.ok(result.results.some(hit => hit.kind === 'record' && hit.title === 'Markov processes notes'));
    assert.ok(result.incomplete.includes('Stores · Portfolio'));
});

test('unexpected backend failures do not make search appear complete', async () => {
    const deps = dependencies();
    deps.listProjects = async () => { throw new Error('No catalogue'); };
    deps.retrieval.search = async () => { throw new Error('No index'); };
    deps.nodes.call = async () => { throw new Error('No nodes'); };
    const result = await searchEverywhere(deps, { query: 'Markov' });
    assert.equal(result.results.length, 0);
    assert.ok(result.incomplete.includes('Projects and applications'));
    assert.ok(result.incomplete.includes('Record contents'));
    assert.ok(result.incomplete.includes('Nodes and workspaces'));
});

test('Nodes without log capability fall back to activity, never a privileged read', async () => {
    const deps = dependencies();
    deps.nodes.call = async (name: string) => name === 'list_nodes'
        ? [{ ...node, capabilities: [] }]
        : { workspaces: [] };
    const result = await searchEverywhere(deps, { query: 'show Mac node logs' });
    assert.equal(result.results[0]?.action, undefined);
    assert.equal(result.results[0]?.href, '#/monitoring?tab=logs&nodeId=' + node.id + '&source=stdout&lines=100');
    assert.match(result.results[0]?.description || '', /raw logs unavailable/);
});

test('Linux log search selects the private service file while preserving requested count', async () => {
    const deps = dependencies();
    deps.nodes.call = async (name: string) => name === 'list_nodes'
        ? [{ ...node, platform: 'linux', name: 'Atlas Linux VPS' }]
        : { workspaces: [] };
    const result = await searchEverywhere(deps, { query: 'show the last 37 error lines from my Linux node' });
    const hit = result.results.find(item => item.kind === 'node');
    assert.equal(hit?.href, '#/monitoring?tab=logs&nodeId=' + node.id + '&source=service&lines=37');
    assert.match(hit?.description || '', /private Atlas Node output/);
});

test('journal and systemd search vocabulary resolves Linux Node links even without journal in the Node name', async () => {
    const deps = dependencies();
    deps.nodes.call = async (name: string) => name === 'list_nodes'
        ? [{ ...node, platform: 'linux', name: 'Atlas Linux VPS' }]
        : { workspaces: [] };
    for (const [phrase, count] of [
        ['show Linux node journal logs', 100],
        ['show the last 37 journal lines from my Linux node', 37],
        ['show Linux node systemd journal', 100],
        ['show the last 25 systemd lines from my Linux node', 25],
    ] as const) {
        const result = await searchEverywhere(deps, { query: phrase });
        const link = result.results.find(item => item.kind === 'node');
        assert.ok(link, phrase);
        assert.equal(link.href, '#/monitoring?tab=logs&nodeId=' + node.id + '&source=service&lines=' + count, phrase);
        assert.match(link.description, /private Atlas Node output/);
    }
});

test('unqualified journal document queries preserve Fabric and catalogue retrieval', async () => {
    const deps = dependencies();
    const retrieved: string[] = [];
    let catalogCalls = 0;
    deps.listProjects = async () => { catalogCalls++; return [project]; };
    deps.retrieval.search = async (input: { query: string }) => {
        retrieved.push(input.query);
        return { results: [{
            record: { id: 'journal-note', data: { title: 'Research journal 2026' } },
            store: { id: 'notes', name: 'Notes' },
            project, snippet: 'Research journal article notes', score: 0.8,
        }] };
    };
    for (const [query, lookup] of [
        ['Find my research journal', 'research journal'],
        ['journal article', 'journal article'],
        ['Find my systemd documentation', 'systemd documentation'],
        ['Find my systemd service configuration', 'systemd service configuration'],
        ['Find the systemd unit documentation', 'systemd unit documentation'],
        ['Find the systemd journal configuration', 'systemd journal configuration'],
    ]) {
        const intent = interpretSearch(query);
        assert.equal(intent.intent, null, query);
        assert.equal(intent.nodeLogs, false, query);
        assert.equal(intent.term, lookup, query);
        const results = await searchEverywhere(deps, { query });
        assert.ok(results.results.some(hit => hit.kind === 'record' && hit.id === 'journal-note'), query);
    }
    assert.deepEqual(retrieved, ['research journal', 'journal article', 'systemd documentation',
        'systemd service configuration', 'systemd unit documentation', 'systemd journal configuration']);
    assert.equal(catalogCalls, 6, 'Document searches must continue loading the project catalogue');
});
