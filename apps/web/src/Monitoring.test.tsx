import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MonitoringPage, localDateTimeValue } from './Monitoring';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn(), IS_MOCK_MODE: false }));
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

test('Store Activity deep links retain both Store and Project filters in the safe server query', async () => {
    location.hash = '#/monitoring?tab=activity&projectId=project-abc&storeId=store-def';
    vi.mocked(callTool).mockResolvedValue({ items: [], total: 0, offset: 0, limit: 30 } as never);
    render(<MonitoringPage />);
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        projectId: 'project-abc', storeId: 'store-def',
        offset: 0, limit: 30, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal)));
    expect(screen.getByRole('textbox', { name: 'Store ID' })).toHaveValue('store-def');
    expect(screen.getByRole('textbox', { name: 'Project ID' })).toHaveValue('project-abc');
    expect(screen.getByText('No events match these filters.')).toBeInTheDocument();
});

test('activity uses correlated operation paging and counts attempts rather than audit rows', async () => {
    location.hash = '#/monitoring?tab=activity';
    const request = { id: 'request', occurredAt: '2026-10-22T08:00:00Z',
        client: 'chatgpt', projectId: 'project', workspaceId: 'workspace',
        operation: 'workspace.mutation_requested',
        resulting: { attemptId: 'same-attempt', operation: 'workspace.dev_invoked', task: 'test' } };
    const result = { id: 'result', occurredAt: '2026-10-22T08:01:00Z',
        client: 'chatgpt', projectId: 'project', workspaceId: 'workspace',
        operation: 'workspace.dev_invoked', resulting: { attemptId: 'same-attempt', outcome: 'completed', task: 'test' } };
    vi.mocked(callTool).mockResolvedValue({ items: [result, request], total: 1, offset: 0, limit: 30 });
    render(<MonitoringPage />);
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity',
        { offset: 0, limit: 30, groupOperations: true, safeDetails: true }, expect.any(AbortSignal)));
    expect(await screen.findByText(/1–1 of 1 operations/)).toBeInTheDocument();
    expect(screen.getByText('test · running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});


test('overview renders live Server/Node health and refreshes on demand', async () => {
    location.hash = '#/monitoring?tab=overview';
    vi.mocked(callTool).mockResolvedValue({
        checkedAt: '2026-10-22T12:00:00Z', overall: 'degraded',
        server: { status: 'healthy', startedAt: '2026-10-22T11:00:00Z', uptimeSeconds: 3600,
            database: { status: 'reachable', latencyMs: 24 } },
        nodes: { available: true, summary: { total: 2, healthy: 1, stale: 1, offline: 0,
            unavailable: 0, revoked: 0, unknown: 0 }, items: [
            { id: 'a', name: 'Node A', state: 'healthy', platform: 'linux', version: '2.0.0',
                lastSeen: '2026-10-22T11:59:50Z', ageSeconds: 10 },
            { id: 'b', name: 'Node B', state: 'stale', platform: 'darwin', version: null,
                lastSeen: '2026-10-22T11:56:00Z', ageSeconds: 240 },
        ] },
    } as never);
    render(<MonitoringPage />);
    const region = await screen.findByRole('region', { name: 'Live operational health' });
    expect(region).toHaveTextContent('degraded');
    expect(region).toHaveTextContent('Database query succeeded · 24 ms');
    expect(region).toHaveTextContent('1 healthy · 2 registered Nodes');
    expect(region).toHaveTextContent('Node B');
    expect(region).toHaveTextContent('stale');
    expect(callTool).toHaveBeenCalledWith('get_monitoring_health', {}, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh health' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
});

test('overview fails closed when health cannot be checked instead of retaining a healthy snapshot', async () => {
    location.hash = '#/monitoring?tab=overview';
    vi.mocked(callTool).mockRejectedValue(new Error('Health endpoint unavailable'));
    render(<MonitoringPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Health snapshot unavailable');
    expect(screen.queryByText('reachable')).not.toBeInTheDocument();
});

test('overview distinguishes unavailable Node registry from zero healthy Nodes', async () => {
    location.hash = '#/monitoring?tab=overview';
    vi.mocked(callTool).mockResolvedValue({
        checkedAt: '2026-10-22T12:00:00Z', overall: 'unknown',
        server: { status: 'healthy', startedAt: '2026-10-22T11:00:00Z', uptimeSeconds: 3600,
            database: { status: 'reachable', latencyMs: 1 } },
        nodes: { available: false, summary: { total: 0, healthy: 0, stale: 0,
            offline: 0, unavailable: 0, revoked: 0, unknown: 0 }, items: [] },
    } as never);
    render(<MonitoringPage />);
    expect(await screen.findByText(/Node registry could not be checked/)).toBeInTheDocument();
    expect(screen.queryByText(/No Nodes registered/)).not.toBeInTheDocument();
});

test('Monitoring activity requests safe projection and links only known scoped IDs', async () => {
    location.hash = '#/monitoring?tab=activity&projectId=22222222-2222-4222-8222-222222222222';
    vi.mocked(callTool).mockResolvedValue({
        offset: 0, total: 1, limit: 30,
        items: [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            client: 'Atlas Web', operation: 'workspace.mutation_failed',
            occurredAt: '2026-10-22T12:00:00Z',
            projectId: '22222222-2222-4222-8222-222222222222',
            workspaceId: '33333333-3333-4333-8333-333333333333',
            resulting: { attemptId: 'operation-1', operation: 'workspace.file_patched',
                outcome: 'failed', nodeId: '44444444-4444-4444-8444-444444444444' },
        }],
    } as never);
    render(<MonitoringPage />);
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity',
        expect.objectContaining({ groupOperations: true, safeDetails: true }), expect.any(AbortSignal)));
    const row = await screen.findByText('The operation failed; inspect the details or client response.');
    expect(row).toBeInTheDocument();
    const summary = row.closest('summary');
    expect(summary).not.toBeNull();
    fireEvent.click(summary!);
    expect(screen.getByRole('link', { name: 'Project activity' })).toHaveAttribute('href',
        '#/monitoring?tab=activity&projectId=22222222-2222-4222-8222-222222222222');
    expect(screen.getByRole('link', { name: 'Workspace activity' })).toHaveAttribute('href',
        '#/monitoring?tab=activity&workspaceId=33333333-3333-4333-8333-333333333333');
    expect(screen.getByRole('link', { name: 'Node activity' })).toHaveAttribute('href',
        '#/monitoring?tab=activity&nodeId=44444444-4444-4444-8444-444444444444');
});

test('safe-projected Workspace event keeps a stable identity without exposing an audit display name', async () => {
    location.hash = '#/monitoring?tab=activity';
    const workspaceId = '33333333-3333-4333-8333-333333333333';
    vi.mocked(callTool).mockResolvedValue({
        items: [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', occurredAt: '2026-10-22T12:00:00Z',
            client: 'Atlas Web', operation: 'workspace.dev_invoked', workspaceId,
            resulting: { attemptId: 'safe-projected', task: 'test', durationMs: 150 },
        }], total: 1, offset: 0, limit: 30,
    } as never);
    render(<MonitoringPage />);
    const title = await screen.findByText('test · 0.1s');
    const summary = title.closest('summary');
    expect(summary).not.toBeNull();
    expect(summary).toHaveTextContent(`Workspace ${workspaceId}`);
    expect(summary).not.toHaveTextContent('Unknown workspace');
    fireEvent.click(summary!);
    expect(screen.getByText(workspaceId)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workspace activity' })).toHaveAttribute('href',
        `#/monitoring?tab=activity&workspaceId=${workspaceId}`);
});

test('share audit rows provide separate source and recipient Node activity links', async () => {
    location.hash = '#/monitoring?tab=activity';
    const sourceNodeId = '11111111-1111-4111-8111-111111111111';
    const targetNodeId = '22222222-2222-4222-8222-222222222222';
    vi.mocked(callTool).mockResolvedValue({
        items: [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', occurredAt: '2026-10-22T12:00:00Z',
            client: 'Atlas Web', operation: 'node.share.approved',
            resulting: { sourceNodeId, targetNodeId },
        }], total: 1, offset: 0, limit: 30,
    } as never);
    render(<MonitoringPage />);
    const title = await screen.findByText('Node share approved');
    fireEvent.click(title.closest('summary')!);
    expect(screen.getByRole('link', { name: 'Source Node activity' })).toHaveAttribute('href',
        `#/monitoring?tab=activity&nodeId=${sourceNodeId}`);
    expect(screen.getByRole('link', { name: 'Target Node activity' })).toHaveAttribute('href',
        `#/monitoring?tab=activity&nodeId=${targetNodeId}`);
});

test('share audit navigation deduplicates equal source and target Node IDs', async () => {
    location.hash = '#/monitoring?tab=activity';
    const nodeId = '11111111-1111-4111-8111-111111111111';
    vi.mocked(callTool).mockResolvedValue({
        items: [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', occurredAt: '2026-10-22T12:00:00Z',
            client: 'Atlas Web', operation: 'node.share.revoked',
            resulting: { sourceNodeId: nodeId, targetNodeId: nodeId },
        }], total: 1, offset: 0, limit: 30,
    } as never);
    render(<MonitoringPage />);
    fireEvent.click((await screen.findByText('Node share revoked')).closest('summary')!);
    expect(screen.getByRole('link', { name: 'Source Node activity' })).toHaveAttribute('href',
        `#/monitoring?tab=activity&nodeId=${nodeId}`);
    expect(screen.queryByRole('link', { name: 'Target Node activity' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Node activity/i })).toHaveLength(1);
});

test('logical Workspace Activity deep links send server-side logical scope without widening it', async () => {
    const logicalWorkspaceId = '11111111-1111-4111-8111-111111111111';
    location.hash = '#/monitoring?tab=activity&logicalWorkspaceId=' + logicalWorkspaceId;
    vi.mocked(callTool).mockResolvedValue({ items: [], total: 0, offset: 0, limit: 30 } as never);
    render(<MonitoringPage />);
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('query_monitoring_activity',
        { logicalWorkspaceId, offset: 0, limit: 30, groupOperations: true, safeDetails: true },
        expect.any(AbortSignal)));
    expect(screen.getByRole('textbox', { name: 'Logical Workspace ID' })).toHaveValue(logicalWorkspaceId);
    expect(await screen.findByText(/0 operations · Filtered on the server/)).toBeInTheDocument();
});
