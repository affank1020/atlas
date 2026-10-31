import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NodeSoftwareFleet } from './NodeSoftwareFleet';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
const linux = {
    id: '11111111-1111-4111-8111-111111111111', name: 'Linux host',
    platform: 'linux', status: 'online' as const, version: '2.0.0',
    capabilities: [], lastSeen: null, hostedWorkspaceCount: 0,
};
beforeEach(() => { vi.resetAllMocks(); location.hash = '/nodes/software'; });
afterEach(() => { cleanup(); location.hash = ''; });

test('cold fleet load reserves metric, card and inspector geometry without fake controls', async () => {
    let resolve!: (nodes: typeof linux[]) => void;
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes'
        ? await new Promise<typeof linux[]>(done => { resolve = done; }) as never
        : [] as never);
    const { container } = render(<NodeSoftwareFleet catalogue={undefined} catalogueLoading={true} refreshGeneration={0} />);
    expect(screen.getByRole('status', { name: 'Loading registered Nodes' })).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.node-software-node-skeleton')).toHaveLength(3);
    expect(container.querySelectorAll('.node-software-metrics .atlas-load-skeleton')).toHaveLength(4);
    expect(screen.queryByText('No Nodes are registered yet.')).not.toBeInTheDocument();
    expect(container.querySelector('.node-software-fleet-layout[role="status"] button')).toBeNull();

    await act(async () => { resolve([linux]); });
    expect(await screen.findByRole('button', { name: /Linux host/ })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading registered Nodes' })).not.toBeInTheDocument();
});

test('Linux history has inert row placeholders until an authoritative response arrives', async () => {
    let resolve!: (records: []) => void;
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') return [linux] as never;
        if (name === 'list_node_update_intents') return await new Promise<[]>(done => { resolve = done; }) as never;
        throw new Error('Unexpected tool ' + name);
    });
    const { container } = render(<NodeSoftwareFleet catalogue={undefined} catalogueLoading={false} refreshGeneration={0} />);
    const history = await screen.findByRole('status', { name: 'Loading update history' });
    expect(history).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.node-software-history-skeleton')).toHaveLength(2);
    expect(screen.queryByText('No update requests recorded.')).not.toBeInTheDocument();
    await act(async () => { resolve([]); });
    expect(await screen.findByText('No update requests recorded.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading update history' })).not.toBeInTheDocument();
});

test('refresh keeps known nodes visible, but a failed inventory read does not claim zero nodes', async () => {
    let reject!: (error: Error) => void;
    let calls = 0;
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'list_nodes') {
            calls++;
            if (calls === 1) return [linux] as never;
            return await new Promise<typeof linux[]>((_done, fail) => { reject = fail; }) as never;
        }
        if (name === 'list_node_update_intents') return [] as never;
        throw new Error('Unexpected tool ' + name);
    });
    const view = render(<NodeSoftwareFleet catalogue={undefined} catalogueLoading={false} refreshGeneration={0} />);
    expect(await screen.findByRole('button', { name: /Linux host/ })).toBeInTheDocument();
    view.rerender(<NodeSoftwareFleet catalogue={undefined} catalogueLoading={false} refreshGeneration={1} />);
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByRole('button', { name: /Linux host/ })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading registered Nodes' })).not.toBeInTheDocument();
    await act(async () => { reject(new Error('Registry unavailable')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Registry unavailable');
    expect(screen.queryByRole('button', { name: /Linux host/ })).not.toBeInTheDocument();
    expect(screen.queryByText('No Nodes are registered yet.')).not.toBeInTheDocument();
});
