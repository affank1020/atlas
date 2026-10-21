import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MonitoringPage, localDateTimeValue } from './Monitoring';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
vi.mock('./Workspace', () => ({ MonitoringOverview: () => null }));
const nodes = [
    { id: 'node-A', name: 'Node A', status: 'online', capabilities: ['node.logs'] },
    { id: 'node-B', name: 'Node B', status: 'online', capabilities: ['node.logs'] },
];
afterEach(() => { cleanup(); vi.resetAllMocks(); location.hash = '#/'; });

test('UTC filter renders local wall-clock time without shifting the instant', () => {
    const local = new Date(2026, 9, 21, 13, 42);
    expect(localDateTimeValue(local.toISOString())).toBe('2026-10-21T13:42');
    expect(new Date(localDateTimeValue(local.toISOString())).toISOString()).toBe(local.toISOString());
});

test('log deep link honours requested source and bounded line count', async () => {
    location.hash = '#/monitoring?tab=logs&nodeId=node-A&source=stdout&lines=37';
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes' ? nodes as never :
        { source: 'stdout', available: true, truncated: false, lines: ['stdout-marker'] } as never);
    render(<MonitoringPage />);
    expect(await screen.findByRole('option', { name: /Node A/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Log stream' })).toHaveValue('stdout');
    expect(screen.getByRole('spinbutton', { name: 'Log lines' })).toHaveValue(37);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh logs' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('read_node_logs',
        { nodeId: 'node-A', source: 'stdout', lines: 37 }, expect.any(AbortSignal)));
    expect(await screen.findByText('stdout-marker')).toBeInTheDocument();
});

test('late log responses cannot cross Node and stream selection', async () => {
    location.hash = '#/monitoring?tab=logs&nodeId=node-A&source=stderr&lines=100';
    let resolveOld!: (result: unknown) => void;
    vi.mocked(callTool).mockImplementation((name, input) => {
        if (name === 'list_nodes') return Promise.resolve(nodes) as never;
        if (name === 'read_node_logs' && input?.nodeId === 'node-A')
            return new Promise(resolve => { resolveOld = resolve; }) as never;
        return Promise.resolve({ source: 'stdout', available: true, truncated: false, lines: ['new-node-output'] }) as never;
    });
    render(<MonitoringPage />);
    expect(await screen.findByRole('option', { name: /Node A/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh logs' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('read_node_logs',
        { nodeId: 'node-A', source: 'stderr', lines: 100 }, expect.any(AbortSignal)));
    fireEvent.change(screen.getByRole('combobox', { name: 'Node source' }), { target: { value: 'node-B' } });
    fireEvent(window, new Event('hashchange'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Log stream' }), { target: { value: 'stdout' } });
    fireEvent(window, new Event('hashchange'));
    await act(async () => { resolveOld({ source: 'stderr', available: true, truncated: false, lines: ['secret-old-node-output'] }); });
    expect(screen.queryByText('secret-old-node-output')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Node source' })).toHaveValue('node-B');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh logs' }));
    expect(await screen.findByText('new-node-output')).toBeInTheDocument();
});
