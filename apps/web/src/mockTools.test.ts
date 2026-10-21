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

test('demo nodes have inspectable workspace details and a simulated offline node', () => {
    const nodes = mockTool<Array<{ id: string; name: string; status: string }>>('list_nodes');
    expect(nodes).toHaveLength(2);
    expect(nodes.find(node => node.name === 'Demo Linux VPS')?.status).toBe('offline');
    expect(nodes.find(node => node.name === 'Demo MacBook')?.status).toBe('online');
    for (const node of nodes) {
        const detail = mockTool<{ workspaces: Array<{ nodeId: string }> }>('get_node', { nodeId: node.id });
        expect(detail.workspaces.length).toBeGreaterThan(0);
        expect(detail.workspaces.every(item => item.nodeId === node.id)).toBe(true);
    }
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
