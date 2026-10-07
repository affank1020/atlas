import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Nodes, WorkspaceHost } from './Nodes';
import { callTool } from './api';
vi.mock('./api', () => ({ callTool: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const node = { id: 'node', name: 'Development machine', status: 'online', capabilities: ['workspace.files', 'workspace.git', 'workspace.dev', 'unity'], hostedWorkspaceCount: 1, lastSeen: '2026-10-07T09:00:00Z', workspaces: [{ id: 'workspace', projectId: 'project', name: 'Football' }] };
it('renders real Node capabilities and hosted Workspace links, and refreshes presence', async () => {
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes' ? [node] : node);
    render(<Nodes />);
    expect(await screen.findByRole('heading', { name: 'Development machine' })).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    for (const label of ['Filesystem', 'Git', 'Development', 'Unity']) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Football' })).toHaveAttribute('href', '#/projects/project/workspaces');
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes' ? [node] : { ...node, status: 'offline' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Offline')).toBeInTheDocument();
});
it('handles empty registry and retries errors without fabricated data', async () => {
    vi.mocked(callTool).mockRejectedValue(new Error('Registry unavailable'));
    render(<Nodes />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Registry unavailable');
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
    vi.mocked(callTool).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('No Nodes registered.')).toBeInTheDocument();
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
    expect(await screen.findByText('No Nodes registered.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enrol Node' }));
    expect(await screen.findByText('temporary-code')).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('create_node_enrolment', {});
    expect(screen.queryByText(/ATLAS_NODE_CREDENTIAL/)).not.toBeInTheDocument();
});
