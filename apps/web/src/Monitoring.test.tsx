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

test('Linux Node only exposes the journal and requests the selected bounded tail', async () => {
    location.hash = '#/monitoring?tab=logs&nodeId=linux-node&source=stdout&lines=25';
    vi.mocked(callTool).mockImplementation(async name => name === 'list_nodes'
        ? [{ id: 'linux-node', name: 'Linux server', platform: 'linux', status: 'online', capabilities: ['node.logs'] }] as never
        : { source: 'journal', lines: ['2026-10-21T22:00:00Z atlas-node: healthy'], available: true, truncated: false } as never);
    render(<MonitoringPage />);
    expect(await screen.findByRole('option', { name: /Linux server/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Log stream' })).toHaveValue('journal');
    expect(screen.getByRole('combobox', { name: 'Log stream' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh logs' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('read_node_logs',
        { nodeId: 'linux-node', source: 'journal', lines: 25 }, expect.any(AbortSignal)));
    expect(await screen.findByText(/atlas-node: healthy/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded log lines' }), { target: { value: 'not-found' } });
    expect(screen.queryByText(/atlas-node: healthy/)).not.toBeInTheDocument();
});

test('Server diagnostics source is deep-linked and excludes Node log calls', async () => {
    location.hash = '#/monitoring?tab=logs&target=server&lines=12';
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'read_server_diagnostics') return {
            source: 'atlas-server-process', available: true, retention: 'current-process',
            startedAt: '2026-10-21T20:00:00Z', truncated: false,
            events: [{ at: '2026-10-21T20:00:01Z', level: 'warning',
                code: 'background_task_failed', message: 'Background startup operation failed' }],
        } as never;
        throw new Error('Unexpected tool ' + name);
    });
    render(<MonitoringPage />);
    expect(screen.getByRole('combobox', { name: 'Log target' })).toHaveValue('server');
    expect(await screen.findByText(/Background startup operation failed/)).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('read_server_diagnostics', { limit: 12 }, expect.any(AbortSignal));
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'list_nodes' || name === 'read_node_logs')).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search diagnostics' }), { target: { value: 'not-present' } });
    expect(screen.queryByText(/Background startup operation failed/)).not.toBeInTheDocument();
    expect(screen.getByText('(no matching events in loaded diagnostics)')).toBeInTheDocument();
});

test('Server diagnostic errors and disabled responses are explicit', async () => {
    location.hash = '#/monitoring?tab=logs&target=server';
    vi.mocked(callTool).mockResolvedValue({ source: 'atlas-server-process', available: false,
        retention: 'current-process', startedAt: '2026-10-21T20:00:00Z', events: [], truncated: false });
    render(<MonitoringPage />);
    expect(await screen.findByText(/Server diagnostics are disabled/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy visible diagnostics' })).not.toBeInTheDocument();
});

test('Switching away from server diagnostics discards late results', async () => {
    location.hash = '#/monitoring?tab=logs&target=server';
    let resolveOld!: (value: unknown) => void;
    vi.mocked(callTool).mockImplementation((name) => {
        if (name === 'read_server_diagnostics')
            return new Promise(resolve => { resolveOld = resolve; }) as never;
        if (name === 'list_nodes') return Promise.resolve(nodes) as never;
        return Promise.resolve(null) as never;
    });
    render(<MonitoringPage />);
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('read_server_diagnostics',
        { limit: 30 }, expect.any(AbortSignal)));
    fireEvent.change(screen.getByRole('combobox', { name: 'Log target' }), { target: { value: 'node' } });
    fireEvent(window, new Event('hashchange'));
    await act(async () => { resolveOld({ available: true, retention: 'current-process',
        startedAt: '2026-10-21T20:00:00Z', source: 'atlas-server-process',
        events: [{ at: '2026-10-21T20:00:00Z', code: 'tool_request_failed',
            level: 'warning', message: 'OLD_DIAGNOSTIC_SHOULD_NOT_RENDER' }], truncated: false }); });
    expect(screen.getByRole('combobox', { name: 'Log target' })).toHaveValue('node');
    expect(screen.queryByText(/OLD_DIAGNOSTIC_SHOULD_NOT_RENDER/)).not.toBeInTheDocument();
});
