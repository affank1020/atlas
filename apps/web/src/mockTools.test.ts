import { afterEach, expect, test, vi } from 'vitest';
import { mockProjects, mockTool } from './mockTools';
import type { AtlasRecord, Page, Store } from './types';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test('mock catalogue supports linked projects, stores and paginated records', () => {
    const projects = mockTool<typeof mockProjects>('list_projects');
    expect(projects).toHaveLength(4);
    const stores = mockTool<Store[]>('list_stores', { projectId: projects[0].id });
    expect(stores.length).toBeGreaterThan(0);
    const first = mockTool<Page<AtlasRecord>>('list_records', { projectId: projects[0].id, storeId: stores[0].id, limit: 1, offset: 0 });
    expect(first.items).toHaveLength(1);
    expect(first.total).toBeGreaterThan(1);
    expect(first.items[0].storeId).toBe(stores[0].id);
    expect(mockTool<Page<AtlasRecord>>('list_records', { projectId: projects[0].id, storeId: stores[0].id, limit: 1, offset: 1 }).items[0].id).not.toBe(first.items[0].id);
});

test('demo nodes include inspectable desktop and Android mobile fixtures', () => {
    const nodes = mockTool<Array<{ id: string; name: string; status: string; platform: string; deviceType?: string; hostedWorkspaceCount: number }>>('list_nodes');
    expect(nodes).toHaveLength(4);
    expect(nodes.find(node => node.name === 'Demo Linux VPS')?.status).toBe('offline');
    expect(nodes.find(node => node.name === 'Demo MacBook')?.status).toBe('online');
    // The tablet previews an online mobile Node and the phone previews
    // its offline counterpart; both remain discoverable in mock mode.
    expect(nodes.find(node => node.name === 'Demo Android Tablet')).toMatchObject({
        status: 'online', platform: 'android', deviceType: 'tablet', hostedWorkspaceCount: 0,
    });
    expect(nodes.find(node => node.name === 'Demo Android Phone')).toMatchObject({
        status: 'offline', platform: 'android', deviceType: 'phone', hostedWorkspaceCount: 0,
    });
    for (const node of nodes) {
        const detail = mockTool<{ workspaces: Array<{ nodeId: string }> }>('get_node', { nodeId: node.id });
        expect(detail.workspaces).toHaveLength(node.hostedWorkspaceCount);
        expect(detail.workspaces.every(item => item.nodeId === node.id)).toBe(true);
    }
});

test('mock Workspace lookups accept explicit checkoutId and the legacy selector', () => {
    const projects = mockTool<typeof mockProjects>('list_projects');
    const linked = projects.flatMap(project =>
        mockTool<Array<{ id: string; name: string }>>('list_project_workspaces', { projectId: project.id })
            .map(checkout => ({ ...checkout, projectId: project.id })));
    expect(linked.length).toBeGreaterThan(0);
    const chosen = linked[0];
    const viaCheckout = mockTool<{ id: string; name: string }>('get_workspace', {
        projectId: chosen.projectId, checkoutId: chosen.id,
    });
    const viaLegacy = mockTool<{ id: string; name: string }>('get_workspace', {
        projectId: chosen.projectId, workspaceId: chosen.id,
    });
    expect(viaCheckout.id).toBe(chosen.id);
    expect(viaCheckout).toEqual(viaLegacy);
});

test('search understands portfolio requests and supplies explicitly simulated log actions', () => {
    const portfolio = mockTool<{ results: Array<{ title: string }> }>('search_everything', { query: 'Open the portfolio app' });
    expect(portfolio.results.some(result => result.title === 'Portfolio')).toBe(true);
    const logs = mockTool<{ results: Array<{ action?: { type: string } }> }>('search_everything', { query: 'Show my node logs' });
    expect(logs.results.some(result => result.action?.type === 'read_node_logs')).toBe(true);
    expect(mockTool<{ lines: string[] }>('read_node_logs', {}).lines.every(line => line.includes('[demo]'))).toBe(true);
});

test('mock records are copies, and mutations never pretend to persist', () => {
    const projects = mockTool<typeof mockProjects>('list_projects');
    projects[0].name = 'Changed locally';
    expect(mockTool<typeof mockProjects>('list_projects')[0].name).toBe('Atlas Demo');
    expect(() => mockTool('create_project', { name: 'Should fail' })).toThrow(/unavailable in local mock mode/);
    expect(() => mockTool('publish_portfolio_entry', { recordId: 'demo' })).toThrow(/unavailable in local mock mode/);
});

test('opt-in mock transport never calls the network', async () => {
    vi.stubEnv('VITE_ATLAS_API_MODE', 'mock');
    vi.resetModules();
    const { callTool, IS_MOCK_MODE } = await import('./api');
    expect(IS_MOCK_MODE).toBe(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const nodes = await callTool<unknown[]>('list_nodes');
    expect(nodes.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(callTool('create_project', { name: 'No' })).rejects.toThrow(/unavailable in local mock mode/);
    vi.resetModules();
});

test('demo Linux Node reads empty update intents without permitting mutation', () => {
    const node = mockTool<Array<{ id: string; name: string }>>('list_nodes').find(item => item.name === 'Demo Linux VPS');
    expect(node).toBeDefined();
    expect(mockTool<unknown[]>('list_node_update_intents', { nodeId: node!.id, limit: 20 })).toEqual([]);
    expect(() => mockTool('prepare_node_update', { nodeId: node!.id })).toThrow(/unavailable in local mock mode/);
    expect(() => mockTool('cancel_node_update_intent', { nodeId: node!.id })).toThrow(/unavailable in local mock mode/);
});

test('mock Monitoring fails closed for unsupported logical Workspace scopes', () => {
    const unfiltered = mockTool<{ total: number }>('query_monitoring_activity', {});
    expect(unfiltered.total).toBeGreaterThan(0);
    for (const logicalWorkspaceId of [
        '11111111-1111-4111-8111-111111111111',
        '00000000-0000-4000-8000-002100000001',
    ]) {
        expect(() => mockTool('query_monitoring_activity', { logicalWorkspaceId }))
            .toThrow(/Logical Workspace activity is unavailable in local mock mode/);
    }
    expect(mockTool<{ total: number }>('query_monitoring_activity', {}).total)
        .toBe(unfiltered.total);
});

test('local demo exposes Code Reviews with paginated, internally consistent synthetic review data', () => {
    const atlasProject = mockProjects[0].id;
    const applications = mockTool<Array<{ projectId: string; slug: string }>>('list_all_applications');
    expect(applications.some(app => app.projectId === atlasProject && app.slug === 'code-reviews')).toBe(true);
    expect(mockTool<{ slug: string }>('get_application', { projectId: atlasProject, slug: 'code-reviews' }).slug)
        .toBe('code-reviews');

    const overview = mockTool<{ reviewRuns: number; findingObservations: number }>('code_reviews_overview');
    const firstPage = mockTool<Page<AtlasRecord>>('code_reviews_list_runs', { limit: 2, offset: 0 });
    const secondPage = mockTool<Page<AtlasRecord>>('code_reviews_list_runs', { limit: 2, offset: 2 });
    expect(firstPage.total).toBe(overview.reviewRuns);
    expect(firstPage.items).toHaveLength(2);
    expect(secondPage.items).toHaveLength(2);
    expect(new Set([...firstPage.items, ...secondPage.items].map(run => run.id)).size)
        .toBe(overview.reviewRuns);
    expect(firstPage.items[0].data.repository).toBe('example/atlas-demo');

    const findings = mockTool<Page<AtlasRecord>>('code_reviews_list_findings',
        { reviewRunId: firstPage.items[0].id, limit: 50 });
    expect(findings.total).toBeGreaterThan(0);
    expect(findings.items[0].data.reviewRunId).toBe(firstPage.items[0].id);
    const timeline = mockTool<{
        recordedRounds: number; rounds: Array<{ runId: string; totalFindingObservations: number }>;
        lineages: Array<{ key: string }>;
    }>('code_reviews_pr_timeline', { repository: 'example/atlas-demo', prNumber: 42, limit: 5, offset: 0 });
    expect(timeline.recordedRounds).toBe(2);
    expect(timeline.rounds).toHaveLength(2);
    expect(timeline.lineages.some(lineage => lineage.key === 'demo-token-expiry')).toBe(true);
});

test('Code Reviews demo never claims to have verified GitHub or published a review', () => {
    const summary = mockTool<{
        currentHead: { state: string }; latestReviewHead: string;
    }>('code_reviews_pr_summary', { repository: 'example/atlas-demo', prNumber: 42 });
    expect(summary.currentHead.state).toBe('unavailable');
    expect(summary.latestReviewHead).toBe('unknown');
    expect(() => mockTool('code_reviews_review_thread_state',
        { repository: 'example/atlas-demo', prNumber: 42 })).toThrow(/unavailable in local demo mode/);
    expect(() => mockTool('code_reviews_managed_summary_publish', { apply: true }))
        .toThrow(/unavailable in local mock mode/);
});

