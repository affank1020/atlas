import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Nodes, WorkspaceHost } from './Nodes';
import { callTool } from './api';
import { mockTool } from './mockTools';
vi.mock('./api', () => ({ callTool: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const node = { id: 'node', name: 'Development machine', status: 'online', capabilities: ['workspace.files', 'workspace.git', 'workspace.dev', 'unity'], hostedWorkspaceCount: 1, lastSeen: '2026-10-07T09:00:00Z', workspaces: [{ id: 'workspace', projectId: 'project', name: 'Football' }] };
it('shows node health before selection and keeps the map compact', async () => {
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes' ? [node] : name === 'query_monitoring_activity' ? { items: [], total: 0, limit: 5, offset: 0 } : node);
    const { container } = render(<Nodes />);
    expect(screen.getByRole('heading', { name: 'Nodes', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Map' })).toBeInTheDocument();
    expect(screen.queryByText('Node network')).not.toBeInTheDocument();
    expect(screen.queryByText('Network overview')).not.toBeInTheDocument();
    expect(screen.queryByText('CONTROL PLANE')).not.toBeInTheDocument();
    expect(screen.queryByText('Central server')).not.toBeInTheDocument();
    expect(container.querySelector('.node-orbit')).not.toBeInTheDocument();
    const health = screen.getByRole('complementary', { name: 'Node health overview' });
    expect(await within(health).findByRole('heading', { name: 'All nodes online' })).toBeInTheDocument();
    expect(within(health).getByText('Online')).toBeInTheDocument();
    expect(within(health).getByText('Offline / unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Selected node details' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Manage node' })).not.toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.filter(([name]) => name === 'get_node')).toHaveLength(0);
    const mapNode = screen.getByRole('button', { name: 'Inspect Development machine' });
    expect(mapNode).not.toHaveTextContent('workspaces');
});

it('shows node details below the map and refreshes selected presence', async () => {
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes' ? [node] : name === 'query_monitoring_activity' ? { items: [], total: 0, limit: 5, offset: 0 } : node);
    render(<Nodes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect Development machine' }));
    const summary = await screen.findByRole('complementary', { name: 'Selected node' });
    expect(within(summary).getByRole('heading', { name: 'Development machine' })).toBeInTheDocument();
    expect(within(summary).getByText('Online', { selector: '.badge' })).toBeInTheDocument();
    expect(within(summary).getByText('Workspaces')).toBeInTheDocument();
    expect(within(summary).getByText('1')).toBeInTheDocument();
    expect(within(summary).getByText('Last seen')).toBeInTheDocument();
    expect(within(summary).getByRole('heading', { name: 'Capabilities' })).toBeInTheDocument();
    expect(within(summary).getByRole('region', { name: 'Capabilities' })).toBeInTheDocument();
    const manage = within(summary).getByRole('region', { name: 'Manage node' });
    for (const label of ['Rename', 'Rotate credential', 'Revoke']) expect(within(manage).getByRole('button', { name: label })).toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'Selected node details' });
    expect(details).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('get_node', { nodeId: node.id });
    for (const label of ['Filesystem', 'Git', 'Development', 'Unity']) expect(within(summary).getByText(label)).toBeInTheDocument();
    expect(within(details).queryByRole('heading', { name: 'Capabilities' })).not.toBeInTheDocument();
    expect(within(summary).queryByText('Capabilities, workspaces and management options are shown below the map.')).not.toBeInTheDocument();
    expect(await within(details).findByRole('link', { name: 'Football' })).toHaveAttribute('href', '#/workspaces?workspace=workspace');
    expect(within(details).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(details).queryByRole('button', { name: /Move|Assign/ })).not.toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'assign_workspace_node')).toBe(false);
    expect(within(details).queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        nodeId: node.id, offset: 0, limit: 5, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal));
    const activity = within(details).getByRole('region', { name: 'Recent activity' });
    const activityCard = activity.closest('.node-detail-card');
    expect(activityCard).toHaveClass('node-detail-activity');
    expect(activityCard?.querySelectorAll('.activity-preview')).toHaveLength(1);
    expect(within(activity).getByRole('button', { name: 'Refresh activity' })).toBeInTheDocument();
    expect(within(activity).getByRole('link', { name: 'View all activity →' }))
        .toHaveAttribute('href', '#/monitoring?tab=activity&nodeId=' + node.id);
    expect(within(details).queryByRole('list', { name: 'Legacy recent activity' })).not.toBeInTheDocument();
    for (const title of ['Hosted workspaces', 'Recent activity', 'Technical details']) {
        expect(within(details).getByRole('heading', { name: new RegExp(title) })).toBeInTheDocument();
    }
    expect(within(details).queryByText('Changes here affect this runtime and its assigned workspaces.')).not.toBeInTheDocument();
    expect(within(details).queryByRole('region', { name: 'Manage node' })).not.toBeInTheDocument();
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes' ? [{ ...node, status: 'offline' }] : name === 'query_monitoring_activity' ? { items: [], total: 0, limit: 5, offset: 0 } : { ...node, status: 'offline' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await within(summary).findByText('Offline')).toBeInTheDocument();
    fireEvent.click(within(summary).getByRole('button', { name: 'Clear node selection' }));
    expect(screen.getByRole('complementary', { name: 'Node health overview' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Selected node details' })).not.toBeInTheDocument();
});
it('keeps node management actions functional in the selected node panel', async () => {
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes' ? [node] : name === 'query_monitoring_activity' ? { items: [], total: 0, limit: 5, offset: 0 } : node);
    render(<Nodes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect Development machine' }));
    const manage = await within(screen.getByRole('complementary', { name: 'Selected node' })).findByRole('region', { name: 'Manage node' });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Development Machine');
    fireEvent.click(within(manage).getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('Node renamed.')).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('update_node', { nodeId: node.id, name: 'Renamed Development Machine' });
    prompt.mockRestore();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(within(manage).getByRole('button', { name: 'Rotate credential' }));
    fireEvent.click(within(manage).getByRole('button', { name: 'Revoke' }));
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'rotate_node_credential' || name === 'revoke_node')).toBe(false);
    confirm.mockRestore();
});

it('shows the Android tablet and phone on the four-node mock topology', async () => {
    vi.mocked(callTool).mockImplementation(async (name, input) => mockTool(name, input));
    render(<Nodes />);
    expect(await screen.findAllByRole('button', { name: /^Inspect / })).toHaveLength(4);
    const tablet = screen.getByRole('button', { name: 'Inspect Demo Android Tablet' });
    expect(tablet).toHaveTextContent('Android tablet');
    fireEvent.click(tablet);
    const summary = await screen.findByRole('complementary', { name: 'Selected node' });
    expect(within(summary).getByRole('heading', { name: 'Demo Android Tablet' })).toBeInTheDocument();
    expect(within(summary).getByText('Filesystem')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Demo Android Phone' }));
    expect(await within(summary).findByRole('heading', { name: 'Demo Android Phone' })).toBeInTheDocument();
    expect(within(summary).getByText('Android phone')).toBeInTheDocument();
});

it('handles empty registry and retries errors without fabricated data', async () => {
    vi.mocked(callTool).mockRejectedValue(new Error('Registry unavailable'));
    render(<Nodes />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Registry unavailable');
    const health = screen.getByRole('complementary', { name: 'Node health overview' });
    expect(within(health).getByRole('heading', { name: 'Status unavailable' })).toBeInTheDocument();
    expect(within(health).getAllByText('—')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Inspect / })).not.toBeInTheDocument();
    vi.mocked(callTool).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('No nodes registered')).toBeInTheDocument();
});
it('shows unavailable hosts and clears stale host details when ownership changes', async () => {
    vi.mocked(callTool).mockResolvedValue({ ...node, status: 'unavailable' });
    const view = render(<WorkspaceHost nodeId="node" />);
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    vi.mocked(callTool).mockRejectedValue(new Error('Node not found'));
    view.rerender(<WorkspaceHost nodeId="missing" />);
    expect(await screen.findByText('Host unavailable: Node not found')).toBeInTheDocument();
    expect(screen.queryByText('Development machine')).not.toBeInTheDocument();
});
it('issues a one-time enrolment code without displaying a Node credential', async () => {
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes' ? [] : name === 'create_node_enrolment' ? { enrolmentToken: 'temporary-code', expiresAt: '2026-10-07T10:00:00Z', nodeId: null } : null);
    render(<Nodes />);
    expect(await screen.findByText('No nodes registered')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Enrol node/ }));
    expect(await screen.findByText('temporary-code')).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('create_node_enrolment', {});
    expect(screen.queryByText(/ATLAS_NODE_CREDENTIAL/)).not.toBeInTheDocument();
});

it('shows installed/latest software and update state inside the selected Node inspector', async () => {
    const installed = { ...node, platform: 'linux', version: '1.9.0' };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [installed];
        if (name === 'get_node') return installed;
        if (name === 'query_monitoring_activity') return { items: [], total: 0, limit: 5, offset: 0 };
        if (name === 'list_node_releases') return {
            state: 'ready',
            checkedAt: '2026-10-21T19:00:00Z',
            releases: [{
                component: 'desktop-node', platform: 'linux', version: '2.0.0',
                commit: 'abc123abc123', protocol: 2, channel: 'stable', architecture: 'any',
                minimumNodeJs: 20, provenance: 'unverified',
                publishedAt: '2026-10-21T19:00:00Z', notes: '',
            }],
        };
        throw new Error('Unexpected tool: ' + name);
    });
    render(<Nodes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect Development machine' }));
    const details = await screen.findByRole('region', { name: 'Selected node details' });
    const software = within(details).getByRole('region', { name: 'Node software' });
    expect(within(software).getByText('1.9.0')).toBeInTheDocument();
    expect(await within(software).findByText('2.0.0+abc123abc123')).toBeInTheDocument();
    expect(within(software).getByText('Newer release available')).toBeInTheDocument();
    expect(within(software).getByText('Not enabled for this Node')).toBeInTheDocument();
    expect(within(software).getByRole('link', { name: /Open software management and downloads/ }))
        .toHaveAttribute('href', '#/nodes/software?node=' + encodeURIComponent(installed.id));
});
