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
    expect(advanced.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(advanced);
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

test('Reset filters also clears search and technical edits that have not been applied', () => {
    location.hash = '#/monitoring?tab=activity';
    vi.mocked(callTool).mockResolvedValue(emptyActivity as never);
    render(<MonitoringPage />);
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
