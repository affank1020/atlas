import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ActivityPreview } from './ActivityPreview';
import { ProjectOverview } from './ProjectOverview';
import type { Project } from './types';
import { callTool } from './api';
import type { AuditEvent } from './types';

vi.mock('./api', () => ({ callTool: vi.fn() }));
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.resetAllMocks();
});

const projectA = '11111111-1111-4111-8111-111111111111';
const projectB = '22222222-2222-4222-8222-222222222222';
const event = (id: string, projectId = projectA): AuditEvent => ({
    id, occurredAt: '2026-10-23T09:00:00Z', projectId,
    operation: 'record.created', client: 'Atlas Web', resulting: {},
});
const page = (ids: string[], projectId = projectA, total = ids.length) => ({
    items: ids.map(id => event(id, projectId)), total, offset: 0, limit: 5,
});

test('project preview uses five safe server-filtered operations and links to full Monitoring history', async () => {
    vi.mocked(callTool).mockResolvedValue(page(['a', 'b', 'c', 'd', 'e'], projectA, 17) as never);
    render(<ActivityPreview projectId={projectA} />);
    expect(await screen.findAllByText('Record created')).toHaveLength(5);
    expect(screen.getByRole('link', { name: 'View all activity →' })).toHaveAttribute('href',
        '#/monitoring?tab=activity&projectId=' + projectA);
    expect(screen.getByText(/17 operations in this scope/)).toBeInTheDocument();
    expect(screen.getByText(/Showing up to 5 latest/)).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        projectId: projectA, offset: 0, limit: 5, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal));
    expect(vi.mocked(callTool).mock.calls.every(([name]) => name !== 'get_recent_activity')).toBe(true);
});

test('preview is manual-only, supports refreshVersion, and keeps settled results while refreshing', async () => {
    vi.mocked(callTool).mockResolvedValueOnce(page(['first']) as never);
    let complete!: (value: unknown) => void;
    vi.mocked(callTool).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }) as never);
    const mounted = render(<ActivityPreview projectId={projectA} />);
    expect(await screen.findByText('Record created')).toBeInTheDocument();

    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(callTool).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Record created')).toBeInTheDocument();
    expect(screen.getByText('Refreshing recent activity…')).toBeInTheDocument();

    await act(async () => { complete(page(['refreshed', 'extra'])); });
    expect(screen.getAllByText('Record created')).toHaveLength(2);
    vi.mocked(callTool).mockResolvedValue(page(['versioned']) as never);
    mounted.rerender(<ActivityPreview projectId={projectA} refreshVersion={1} />);
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/1 operation in this scope/)).toBeInTheDocument();
});

test('changing preview scope never presents old project results or lets stale responses leak', async () => {
    let finishA!: (value: unknown) => void;
    vi.mocked(callTool).mockImplementation((_name, input) => input?.projectId === projectA
        ? new Promise(resolve => { finishA = resolve; }) as never
        : Promise.resolve(page(['other'], projectB)) as never);
    const mounted = render(<ActivityPreview projectId={projectA} />);
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    const oldSignal = vi.mocked(callTool).mock.calls[0]![2]!;
    mounted.rerender(<ActivityPreview projectId={projectB} />);
    expect(oldSignal.aborted).toBe(true);
    expect(screen.getByRole('link', { name: 'View all activity →' }))
        .toHaveAttribute('href', '#/monitoring?tab=activity&projectId=' + projectB);
    expect(await screen.findByText('Record created')).toBeInTheDocument();
    await act(async () => { finishA(page(['stale'], projectA)); });
    expect(screen.getAllByText('Record created')).toHaveLength(1);
    expect(screen.getByText('Record created').closest('[data-activity-id]'))
        .toHaveAttribute('data-activity-id', 'other');
});

test('preview failure is explicit, permits retry and preserves prior valid rows', async () => {
    vi.mocked(callTool).mockRejectedValueOnce(new Error('preview is unavailable'))
        .mockResolvedValueOnce(page(['good']) as never)
        .mockRejectedValueOnce(new Error('network interruption'));
    render(<ActivityPreview projectId={projectA} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('preview is unavailable');
    expect(screen.queryByText('Record created')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity' }));
    expect(await screen.findByText('Record created')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('network interruption');
    expect(screen.getByText('Record created')).toBeInTheDocument();
});

test('Project Overview renders the bounded preview instead of the legacy auto-polling ActivityFeed', async () => {
    const project: Project = {
        id: projectA, name: 'Preview Project', description: '', createdAt: '2026-10-22T09:00:00Z',
        updatedAt: '2026-10-23T09:00:00Z',
    };
    vi.mocked(callTool).mockResolvedValue(page(['one']) as never);
    render(<ProjectOverview project={project} views={[]} viewsBusy={false} />);
    expect(await screen.findByText('Record created')).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('query_monitoring_activity', {
        projectId: projectA, offset: 0, limit: 5, groupOperations: true, safeDetails: true,
    }, expect.any(AbortSignal));
    expect(screen.queryByText('Auto-refresh')).not.toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.map(call => call[0])).toEqual(['query_monitoring_activity']);
});
