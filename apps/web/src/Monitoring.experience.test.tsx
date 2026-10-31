import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MonitoringPage, ProjectActivityPanel } from './Monitoring';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn(), IS_MOCK_MODE: false }));
vi.mock('./Workspace', () => ({ MonitoringOverview: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); location.hash = '#/'; });

const emptyActivity = { items: [], total: 0, offset: 0, limit: 30 };

test('common Activity filters are visible; technical scopes remain accessible and count active values', async () => {
    location.hash = '#/monitoring?tab=activity&outcome=failed&nodeId=node-1';
    vi.mocked(callTool).mockResolvedValue(emptyActivity as never);
    render(<MonitoringPage />);
    expect(screen.getByLabelText('Search activity')).toBeInTheDocument();
    expect(screen.getByLabelText('Outcome')).toHaveValue('failed');
    const advanced = screen.getByText('Scope and time filters · 1 active');
    // A bookmarked Node scope opens its technical controls instead of hiding the active filter.
    expect(advanced.closest('details')).toHaveAttribute('open');
    expect(screen.getByLabelText('Node ID')).toHaveValue('node-1');
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'workspace.updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    const params = new URLSearchParams(location.hash.split('?')[1]);
    expect(params.get('operation')).toBe('workspace.updated');
    expect(params.get('nodeId')).toBe('node-1');
    expect(params.get('outcome')).toBe('failed');
    expect(params.has('offset')).toBe(false);
});

test('same-tab Activity scope links reopen advanced filters, but other filter edits preserve a manual collapse', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const nodeId = '22222222-2222-4222-8222-222222222222';
    location.hash = '#/monitoring?tab=activity';
    const event = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        occurredAt: '2026-10-31T12:00:00Z',
        operation: 'workspace.dev_invoked',
        client: 'Atlas Web',
        workspaceId,
        resulting: { operation: 'git_status', nodeId },
    };
    vi.mocked(callTool).mockResolvedValue({
        items: [event], total: 1, limit: 30, offset: 0,
    } as never);
    render(<MonitoringPage />);
    const section = screen.getByRole('region', { name: 'Monitoring activity' });
    const disclosure = screen.getByText('Scope and time filters').closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    await waitFor(() => expect(section.querySelector('.activity-item summary')).not.toBeNull());
    fireEvent.click(section.querySelector('.activity-item summary')!);
    fireEvent.click(screen.getByRole('link', { name: 'Workspace activity' }));
    // jsdom schedules default anchor navigation asynchronously. Wait for the
    // real hashchange rather than racing it with a synthetic event.
    await waitFor(() => expect(location.hash).toContain('workspaceId=' + workspaceId));
    await waitFor(() => expect(disclosure).toHaveAttribute('open'));
    expect(screen.getByLabelText('Workspace ID')).toHaveValue(workspaceId);

    // Once the new scope is visible, explicit collapse should survive changing
    // an unrelated outcome filter on the same in-page Activity route.
    fireEvent.click(screen.getByText('Scope and time filters · 1 active'));
    await waitFor(() => expect(disclosure).not.toHaveAttribute('open'));
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'failed' } });
    await waitFor(() => expect(location.hash).toContain('outcome=failed'));
    await waitFor(() => expect(screen.getByLabelText('Outcome')).toHaveValue('failed'));
    expect(disclosure).not.toHaveAttribute('open');

    // A different technical scope link is a genuine navigation and reopens it.
    await waitFor(() => expect(section.querySelector('.activity-item summary')).not.toBeNull());
    const eventRow = section.querySelector<HTMLDetailsElement>('details.activity-item')!;
    if (!eventRow.open) fireEvent.click(eventRow.querySelector('summary')!);
    fireEvent.click(await screen.findByRole('link', { name: 'Node activity' }));
    await waitFor(() => expect(location.hash).toContain('nodeId=' + nodeId));
    await waitFor(() => expect(disclosure).toHaveAttribute('open'));
    expect(screen.getByLabelText('Node ID')).toHaveValue(nodeId);
});

test('Reset filters also clears search and technical edits that have not been applied', () => {
    location.hash = '#/monitoring?tab=activity';
    vi.mocked(callTool).mockResolvedValue(emptyActivity as never);
    render(<MonitoringPage />);
    expect(screen.getByText('Scope and time filters').closest('details')).not.toHaveAttribute('open');
    const search = screen.getByLabelText('Search activity');
    fireEvent.change(search, { target: { value: 'draft search' } });
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(search).toHaveValue('');
    const params = new URLSearchParams(location.hash.split('?')[1]);
    expect(params.has('search')).toBe(false);
});

test('resetting Project Activity filters cannot escape the pinned Project boundary', async () => {
    location.hash = '#/projects/project-1/activity?outcome=failed&nodeId=node-1';
    vi.mocked(callTool).mockImplementation(async name =>
        name === 'list_project_workspaces' ? [] as never : emptyActivity as never);
    render(<ProjectActivityPanel projectId="project-1" />);
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(location.hash).toContain('#/projects/project-1/activity?');
    const params = new URLSearchParams(location.hash.split('?')[1]);
    expect(params.get('projectId')).toBe('project-1');
    expect(params.has('outcome')).toBe(false);
    expect(params.has('nodeId')).toBe(false);
    await waitFor(() => expect(callTool).toHaveBeenCalled());
});

test('health summary distinguishes known states and missing physical retention evidence', async () => {
    location.hash = '#/monitoring?tab=overview';
    vi.mocked(callTool).mockResolvedValue({
        checkedAt: '2026-10-31T10:40:00Z', overall: 'degraded',
        server: { status: 'healthy', startedAt: '2026-10-31T10:00:00Z',
            uptimeSeconds: 2400, database: { status: 'reachable', latencyMs: 2 } },
        diagnostics: { status: 'available', coverage: 'incomplete-possible',
            retentionDays: 14, droppedSinceStart: 0, queuedForWrite: 0, writePaused: false },
        nodes: { available: true,
            summary: { total: 2, healthy: 1, stale: 0, offline: 1,
                unavailable: 0, revoked: 0, unknown: 0 },
            items: [],
        },
    } as never);
    render(<MonitoringPage />);
    const summary = await screen.findByRole('group', { name: 'Health signal summary' });
    expect(within(summary).getByText('reachable')).toBeInTheDocument();
    expect(within(summary).getByText('available')).toBeInTheDocument();
    expect(within(summary).getByText('unknown')).toBeInTheDocument();
    expect(within(summary).getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Overall health')).toHaveTextContent('degraded');
});

test('Logs explains the bounded Node and Server evidence sources', async () => {
    location.hash = '#/monitoring?tab=logs&target=node';
    vi.mocked(callTool).mockResolvedValue([] as never);
    render(<MonitoringPage />);
    expect(screen.getByLabelText('Log target')).toHaveValue('node');
    const guide = screen.getByRole('group', { name: 'Log source boundaries' });
    expect(within(guide).getByText('Node tails')).toBeInTheDocument();
    expect(within(guide).getByText('Server signals')).toBeInTheDocument();
    expect(within(guide).getByText(/not Docker logs/)).toBeInTheDocument();
});
