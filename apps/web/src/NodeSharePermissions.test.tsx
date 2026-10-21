import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeSharePermissions, type ShareApproval } from './NodeSharePermissions';
import { callTool } from './api';
vi.mock('./api', () => ({ callTool: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

const sender = { id: '00000000-0000-4000-8000-000000000001', name: 'Samsung Tablet',
    status: 'online' as const, credentialState: 'active', platform: 'android',
    capabilities: ['device.share.send'], lastSeen: null, hostedWorkspaceCount: 0 };
const mac = { id: '00000000-0000-4000-8000-000000000002', name: 'MacBook Pro',
    status: 'offline' as const, credentialState: 'active', platform: 'darwin',
    capabilities: [], lastSeen: null, hostedWorkspaceCount: 0 };

it('approves a directional peer and revokes it without changing the reverse pair', async () => {
    let rows: ShareApproval[] = [];
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        if (name === 'list_node_share_approvals') return structuredClone(rows) as never;
        if (name === 'update_node_share_approval') {
            const x = input as {sourceNodeId:string;targetNodeId:string;enabled:boolean};
            rows = x.enabled ? [{sourceNodeId:x.sourceNodeId,targetNodeId:x.targetNodeId,origin:'managed'}] : [];
            return {enabled:x.enabled} as never;
        }
        throw Error('Unexpected tool: '+name);
    });
    render(<NodeSharePermissions source={sender} nodes={[sender,mac]} />);
    fireEvent.click(await screen.findByRole('button', {name:'Approve sharing'}));
    await waitFor(() => expect(vi.mocked(callTool)).toHaveBeenCalledWith(
        'update_node_share_approval',{sourceNodeId:sender.id,targetNodeId:mac.id,enabled:true}));
    const revoke = await screen.findByRole('button',{name:'Revoke access'});
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
    fireEvent.click(revoke);
    await waitFor(() => expect(vi.mocked(callTool)).toHaveBeenCalledWith(
        'update_node_share_approval',{sourceNodeId:sender.id,targetNodeId:mac.id,enabled:false}));
    confirm.mockRestore();
    expect(within(screen.getByRole('region',{name:'Sharing permissions for Samsung Tablet'})).getByText(/Each approval is directional\./i)).toBeInTheDocument();
});

it('renders immutable environment grants without offering revoke', async () => {
    vi.mocked(callTool).mockImplementation(async name => name === 'list_node_share_approvals'
        ? [{sourceNodeId:sender.id,targetNodeId:mac.id,origin:'environment'}] : undefined as never);
    render(<NodeSharePermissions source={sender} nodes={[sender,mac]} />);
    expect(await screen.findByText('Managed by server environment')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Revoke access'})).not.toBeInTheDocument();
});

it('treats a rejected permissions read as unknown, never as a missing approval', async () => {
    let attempts = 0;
    vi.mocked(callTool).mockImplementation(async name => {
        if (name !== 'list_node_share_approvals') throw new Error('A write must not be offered');
        if (++attempts === 1) throw new Error('Temporary registry outage');
        return [{ sourceNodeId: sender.id, targetNodeId: mac.id, origin: 'managed' }] as never;
    });
    render(<NodeSharePermissions source={sender} nodes={[sender, mac]} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary registry outage');
    expect(screen.getByText(/Sharing approval state is unknown/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve sharing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke access' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh approvals' }));
    expect(await screen.findByText('Approved in Atlas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke access' })).toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.filter(([name]) => name === 'update_node_share_approval')).toHaveLength(0);
});
