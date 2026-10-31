import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Provider } from 'react-redux';
import { createAtlasStore } from './store';
import { callTool } from './api';
import { WorkspaceHome, WorkspaceLibrary, MonitoringOverview, DeveloperHub, WorkspaceSettings } from './Workspace';
import { readRecentWork, rememberWork, clearRecentWork } from './recentWork';
vi.mock('./api', () => ({ IS_MOCK_MODE: false, API_BASE: 'http://localhost:3000', callTool: vi.fn(), onToolMutation: vi.fn(() => () => {}) }));
const projects = [{ id: 'p', name: 'Research' }, { id: 'q', name: 'Writing' }];
beforeEach(() => { sessionStorage.clear(); vi.mocked(callTool).mockReset(); vi.mocked(callTool).mockImplementation(async (name, input) => {
    if (name === 'list_projects') return projects;
    if (name === 'list_views') return [{ id: 'v', projectId: input?.projectId, name: 'Reading list', slug: 'reading' }];
    if (name === 'list_stores') return [{ id: 's', projectId: input?.projectId, name: 'Notes' }];
    if (name === 'get_atlas_status') return { version: '2.0', storage: 'Postgres', projects: 2, stores: 7, records: 138, schemaVersion: 16 };
    if (name === 'list_nodes') return [{ id: 'linux-test-node', name: 'Atlas Linux VPS', platform: 'linux', status: 'online', hostedWorkspaceCount: 1, capabilities: [], lastSeen: null }];
    if (name === 'get_node') return { id: 'linux-test-node', workspaces: [{ id: 'ws', projectId: 'p', name: 'Research workspace', kind: 'generic' }] };
    return [];
}); });
test('global Views library starts with all projects and keeps cached results when filtered', async () => {
    const { store } = createAtlasStore();
    render(<Provider store={store}><WorkspaceLibrary kind="views" /></Provider>);
    const links = await screen.findAllByRole('link', { name: /Reading list/ });
    expect(links).toHaveLength(2);
    expect(links.map(link => link.getAttribute('href'))).toEqual([
        'http://localhost:3000/projects/p/views/reading',
        'http://localhost:3000/projects/q/views/reading',
    ]);
    expect(screen.getByLabelText('Project')).toHaveValue('');
    expect(callTool).not.toHaveBeenCalledWith('list_stores', expect.anything(), expect.anything());
    fireEvent.click(links[0]);
    expect(readRecentWork()[0]).toMatchObject({ name: 'Reading list', kind: 'View' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'q' } });
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Reading list/ })).toHaveLength(1));
    expect(screen.getByRole('link', { name: /Reading list/ })).toHaveAttribute('href', 'http://localhost:3000/projects/q/views/reading');
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '' } });
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Reading list/ })).toHaveLength(2));
    expect(vi.mocked(callTool).mock.calls.filter(([name]) => name === 'list_views')).toHaveLength(2);
});

test('global Data library includes stores from every project by default', async () => {
    const { store } = createAtlasStore();
    render(<Provider store={store}><WorkspaceLibrary kind="data" /></Provider>);
    const links = await screen.findAllByRole('link', { name: /Notes/ });
    expect(links.map(link => link.getAttribute('href'))).toEqual([
        '#/projects/p/stores/s/records', '#/projects/q/stores/s/records',
    ]);
    expect(callTool).not.toHaveBeenCalledWith('list_views', expect.anything(), expect.anything());
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'q' } });
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Notes/ })).toHaveLength(1));
});
test('Home combines recent applications and views in last-used order', async () => {
    rememberWork({ href: '#/projects/p', name: 'Research project', projectId: 'p', kind: 'Project' });
    rememberWork({ href: '#/projects/p/applications/studio', name: 'Studio', projectId: 'p', kind: 'Application' });
    rememberWork({ href: '#/projects/p/views/v', name: 'Reading list', projectId: 'p', kind: 'View', viewSlug: 'reading' });
    const { store } = createAtlasStore();
    render(<Provider store={store}><WorkspaceHome /></Provider>);
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByText('Projects, applications, data and infrastructure.')).not.toBeInTheDocument();
    expect(await within(screen.getByRole('region', { name: 'Projects overview' })).findByRole('link', { name: /Research/ })).toHaveAttribute('href', '#/projects/p');
    expect(screen.getByRole('link', { name: /Connected nodes/ })).toHaveAttribute('href', '#/nodes');
    const infrastructure = screen.getByRole('region', { name: 'System health' });
    expect(await within(infrastructure).findByText('Atlas Linux VPS')).toBeInTheDocument();
    expect(within(infrastructure).getByText('Connected')).toBeInTheDocument();
    expect(within(infrastructure).getByText('online')).toBeInTheDocument();
    expect(await within(screen.getByRole('region', { name: 'Hosted workspaces' })).findByRole('link', { name: /Research workspace/ })).toHaveAttribute('href', '#/workspaces?workspace=ws');
    const recentlyUsed = screen.getByRole('region', { name: 'Recently used' });
    expect(within(recentlyUsed).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual([
        'http://localhost:3000/projects/p/views/reading',
        '#/projects/p/applications/studio',
    ]);
    expect(within(recentlyUsed).getByText('View · Research')).toBeInTheDocument();
    expect(within(recentlyUsed).getByText('Application · Research')).toBeInTheDocument();
    const studio = within(recentlyUsed).getByRole('link', { name: /Studio/ });
    const readingList = within(recentlyUsed).getByRole('link', { name: /Reading list/ });
    expect(studio).toHaveAttribute('href', '#/projects/p/applications/studio');
    expect(studio).not.toHaveAttribute('target');
    expect(studio).not.toHaveAttribute('rel');
    expect(readingList).toHaveAttribute('href', 'http://localhost:3000/projects/p/views/reading');
    expect(readingList).toHaveAttribute('target', '_blank');
    expect(readingList).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(recentlyUsed).queryByText('Research project')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Attention needed' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled());
    clearRecentWork();
    await within(recentlyUsed).findByText('No applications or views opened in this browser session.');
});

test('Home reports status failures without inventing node or workspace availability', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_projects') return projects;
        throw new Error('Offline');
    });
    const { store } = createAtlasStore();
    render(<Provider store={store}><WorkspaceHome /></Provider>);
    const infrastructure = screen.getByRole('region', { name: 'System health' });
    expect(await within(infrastructure).findByText('Unavailable')).toBeInTheDocument();
    expect(await within(infrastructure).findByText('Node status unavailable.', { exact: false })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Hosted workspaces' })).getByText('Open the Nodes view to inspect assignments.')).toBeInTheDocument();
});
test('Home surfaces disconnected nodes without adding a permanent health card', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_projects') return projects;
        if (name === 'get_atlas_status') return { version: '2.0', storage: 'Postgres', stores: 7, records: 138 };
        if (name === 'list_nodes') return [{ id: 'offline-node', name: 'Remote Mac', status: 'offline', hostedWorkspaceCount: 0 }];
        if (name === 'get_node') return { id: 'offline-node', workspaces: [] };
        return [];
    });
    const { store } = createAtlasStore();
    render(<Provider store={store}><WorkspaceHome /></Provider>);
    const notice = await screen.findByRole('status', { name: 'Attention needed' });
    expect(notice).toHaveTextContent('Remote Mac is offline.');
    expect(within(notice).getByRole('link', { name: /Monitoring/ })).toHaveAttribute('href', '#/monitoring');
});

test('Home flags failed workspace detail lookups and clears the notice on recovery', async () => {
    let failDetails = true;
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_projects') return projects;
        if (name === 'get_atlas_status') return { version: '2.0', storage: 'Postgres', stores: 7, records: 138 };
        if (name === 'list_nodes') return [{ id: 'workspace-failure-node', name: 'Workspace Node', status: 'online', hostedWorkspaceCount: 1 }];
        if (name === 'get_node') {
            if (failDetails) throw new Error('Workspace details unavailable');
            return { id: 'workspace-failure-node', workspaces: [{ id: 'recovered', projectId: 'p', name: 'Recovered workspace' }] };
        }
        return [];
    });
    const { store } = createAtlasStore();
    render(<Provider store={store}><WorkspaceHome /></Provider>);
    expect(await screen.findByRole('status', { name: 'Attention needed' })).toHaveTextContent('Some workspace details could not be loaded.');
    failDetails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await within(screen.getByRole('region', { name: 'Hosted workspaces' })).findByRole('link', { name: /Recovered workspace/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Attention needed' })).not.toBeInTheDocument());
});

test('recent work tolerates invalid storage and remains bounded and deduplicated', () => {
    sessionStorage.setItem('atlas.recent-work.v1', '{}'); expect(readRecentWork()).toEqual([]);
    for (let i = 0; i < 12; i++) rememberWork({ href: `#/projects/${i}`, name: String(i), projectId: String(i), kind: 'Project' });
    expect(readRecentWork()).toHaveLength(8);
    rememberWork(readRecentWork()[3]); expect(readRecentWork()).toHaveLength(8);
});
test('Monitoring shows system connectivity and links into consolidated Activity', async () => {
    const { store } = createAtlasStore();
    render(<Provider store={store}><MonitoringOverview /></Provider>);
    expect(screen.getByRole('heading', { name: 'Monitoring' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Activity feed/ })).toHaveAttribute('href', '#/monitoring?tab=activity');
    expect(await screen.findByText('Atlas Linux VPS')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Manage nodes/ })).toHaveAttribute('href', '#/nodes');
});
test('Developer tools are discoverable through Settings, not the primary sidebar', () => {
    const { store } = createAtlasStore();
    render(<Provider store={store}><WorkspaceSettings /></Provider>);
    expect(screen.getByRole('link', { name: /Developer tools/ })).toHaveAttribute('href', '#/developer');
    cleanup();
    render(<DeveloperHub />);
    expect(screen.getByRole('link', { name: /Retrieval inspector/ })).toHaveAttribute('href', '#/fabric');
    expect(screen.getByRole('link', { name: /Ask Atlas/ })).toHaveAttribute('href', '#/ask-atlas');
});

afterEach(() => cleanup());
