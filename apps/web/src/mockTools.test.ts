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
    for (const [name, deviceType] of [['Demo Android Tablet', 'tablet'], ['Demo Android Phone', 'phone']]) {
        const mobile = nodes.find(node => node.name === name);
        expect(mobile).toMatchObject({ status: 'online', platform: 'android', deviceType, hostedWorkspaceCount: 0 });
    }
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
