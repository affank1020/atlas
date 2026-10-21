import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RecentActivityPreview } from './RecentActivityPreview';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test('project preview uses a bounded server-side scope and deep link', async () => {
    vi.mocked(callTool).mockResolvedValue({
        items: [{ id: 'a', occurredAt: '2026-10-21T10:00:00Z', client: 'chatgpt', operation: 'project.updated', projectId: 'project-one' }],
        total: 85, offset: 0, limit: 5,
    });
    render(<RecentActivityPreview title="Recent activity" filters={{ projectId: 'project-one' }} count={5} />);
    expect(await screen.findByText('Project updated')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View all/ })).toHaveAttribute('href', '#/monitoring?tab=activity&projectId=project-one');
    expect(callTool).toHaveBeenCalledWith('query_monitoring_activity',
        { projectId: 'project-one', limit: 5, offset: 0 }, expect.any(AbortSignal));
    expect(screen.queryByText('85')).not.toBeInTheDocument();
});

test('checkout preview does not leak stale activity from another scope', async () => {
    let finishFirst!: (value: unknown) => void;
    vi.mocked(callTool).mockImplementation((_name, params) => params.checkoutId === 'old'
        ? new Promise(resolve => { finishFirst = resolve; }) as never
        : Promise.resolve({ items: [], total: 0, limit: 4, offset: 0 }) as never);
    const { rerender } = render(<RecentActivityPreview title="Recent checkout activity" filters={{ checkoutId: 'old' }} count={4} />);
    rerender(<RecentActivityPreview title="Recent checkout activity" filters={{ checkoutId: 'new' }} count={4} />);
    await waitFor(() => expect(screen.getByText('No recorded activity for this scope.')).toBeInTheDocument());
    finishFirst({ items: [{ id: 'old-event', occurredAt: '2026-10-20T10:00:00Z', client: 'legacy', operation: 'workspace.file_patched' }], total: 1, limit: 4, offset: 0 });
    expect(screen.queryByText(/Old event/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View all/ })).toHaveAttribute('href', '#/monitoring?tab=activity&checkoutId=new');
});

test('failed preview reads show an error rather than an empty history', async () => {
    vi.mocked(callTool).mockRejectedValue(new Error('Source unavailable'));
    render(<RecentActivityPreview filters={{ nodeId: 'offline-node' }} compact />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Source unavailable');
    expect(screen.getByRole('link', { name: /View all/ })).toHaveAttribute('href', '#/monitoring?tab=activity&nodeId=offline-node');
});
