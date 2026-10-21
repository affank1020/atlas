import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Provider } from 'react-redux';
import { createAtlasStore } from './store';
import { callTool } from './api';
import { DataOverview } from './DataOverview';

vi.mock('./api', () => ({
    IS_MOCK_MODE: false, API_BASE: 'http://localhost:3000',
    callTool: vi.fn(), onToolMutation: vi.fn(() => () => {}),
}));

beforeEach(() => {
    vi.mocked(callTool).mockReset();
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        if (name === 'list_projects') return [
            { id: 'p', name: 'Research', metrics: { stores: 1 } },
            { id: 'q', name: 'Writing', metrics: { stores: 0 } },
        ];
        if (name === 'list_stores') return [{ id: 's', projectId: input?.projectId, name: 'Notes' }];
        if (name === 'get_atlas_status') return { product: 'Atlas', version: '2.0', storage: 'PostgreSQL', projects: 2, stores: 7, records: 138, schemaVersion: 16 };
        if (name === 'get_storage_usage') return {
            postgres: { state: 'ready', databaseBytes: 40_960, tableBytes: 10_240, indexBytes: 2_048, tableCount: 2,
                tables: [{ schema: 'public', name: 'records', tableBytes: 8_192, indexBytes: 2_048, totalBytes: 10_240 }] },
            r2: { state: 'ready', storageBytes: 4_096, objectCount: 2, classA: 10, classB: 20,
                otherOperations: 0, measuredAt: '2026-10-20T20:00:00Z', storageAllowanceBytes: 10_000_000_000,
                classAAllowance: 1_000_000, classBAllowance: 10_000_000 },
        };
        if (name === 'list_portfolio_media') return [
            { id: 'a', status: 'active', byteSize: 4096 },
            { id: 'b', status: 'archived', byteSize: 1024 },
        ];
        return [];
    });
});
afterEach(() => cleanup());

test('Data overview displays PostgreSQL sizes and real R2 metrics independently of Portfolio metadata', async () => {
    const { store } = createAtlasStore();
    render(<Provider store={store}><DataOverview /></Provider>);
    expect(screen.getByRole('heading', { name: 'Data' })).toBeInTheDocument();
    expect(await screen.findByText(/Last refreshed/)).toBeInTheDocument();
    expect(screen.queryByText(/Bucket measured/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Storage is a bucket snapshot/)).not.toBeInTheDocument();
    const postgres = screen.getByRole('region', { name: 'PostgreSQL' });
    expect(await within(postgres).findByText('138')).toBeInTheDocument();
    expect(within(postgres).getByText('7')).toBeInTheDocument();
    expect(within(postgres).getByText('40 KB')).toBeInTheDocument();
    expect(within(postgres).getAllByText('2 KB')).toHaveLength(2);
    const composition = within(postgres).getByRole('img', { name: 'Table data: 25%, Indexes: 5%, Other: 70%' });
    expect(composition).toBeInTheDocument();
    expect(within(postgres).getByText('28 KB')).toBeInTheDocument();
    expect(within(postgres).getByText('70%')).toBeInTheDocument();
    const objects = screen.getByRole('region', { name: 'Cloudflare R2' });
    expect(await within(objects).findByText('2')).toBeInTheDocument();
    expect(within(objects).getByText('4 KB')).toBeInTheDocument();
    expect(within(objects).getByText('10')).toBeInTheDocument();
    expect(within(objects).getByText('20')).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('public.records');
    expect(screen.getByRole('link', { name: /Portfolio media/ })).toHaveAttribute('href', '#/portfolio?tab=media');
    expect(callTool).not.toHaveBeenCalledWith('list_views', expect.anything(), expect.anything());
});

test('Data overview groups project stores behind expandable project rows', async () => {
    const { store } = createAtlasStore();
    render(<Provider store={store}><DataOverview /></Provider>);
    const research = await screen.findByRole('button', { name: /Research/ });
    expect(research).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Notes' })).not.toBeInTheDocument();
    fireEvent.click(research);
    expect(research).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('link', { name: 'Notes' })).toHaveAttribute('href', '#/projects/p/stores/s/records');
    expect(screen.queryByRole('link', { name: /Project data/ })).not.toBeInTheDocument();
    fireEvent.click(research);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Notes' })).not.toBeInTheDocument());
});

test('Data overview hides projects with no active stores', async () => {
    const { store } = createAtlasStore();
    render(<Provider store={store}><DataOverview /></Provider>);
    expect(await screen.findByRole('button', { name: /Research/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Writing/ })).not.toBeInTheDocument();
    expect(screen.getByText('1 project')).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('list_projects', { includeArchived: false, withMetrics: true }, expect.anything());
    expect(callTool).not.toHaveBeenCalledWith('list_stores', expect.objectContaining({ projectId: 'q' }), expect.anything());
});

test('Data overview shows the empty state when all projects have no stores', async () => {
    vi.mocked(callTool).mockImplementation(async name => name === 'list_projects'
        ? [{ id: 'p', name: 'Research', metrics: { stores: 0 } }]
        : []);
    const { store } = createAtlasStore();
    render(<Provider store={store}><DataOverview /></Provider>);
    expect(await screen.findByText('No project data yet.')).toBeInTheDocument();
    expect(screen.getByText('0 projects')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Research/ })).not.toBeInTheDocument();
    expect(callTool).not.toHaveBeenCalledWith('list_stores', expect.anything(), expect.anything());
});
