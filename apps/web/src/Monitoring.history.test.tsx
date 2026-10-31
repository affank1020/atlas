import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MonitoringPage } from './Monitoring';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn(), IS_MOCK_MODE: false }));
vi.mock('./Workspace', () => ({ MonitoringOverview: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); location.hash = '#/'; });

test('Server history is opt-in, bookmarkable and never reuses current-process rows', async () => {
    location.hash = '#/monitoring?tab=logs&target=server';
    vi.mocked(callTool).mockImplementation(async (name: string) => ({
        source: name === 'read_server_diagnostic_history' ? 'atlas-server-history' : 'atlas-server-process',
        available: true, startedAt: '2026-10-30T12:00:00.000Z',
        retention: name === 'read_server_diagnostic_history' ? 'best-effort' : 'current-process',
        events: name === 'read_server_diagnostic_history'
            ? [{ at: '2026-10-30T12:01:00Z', code: 'tool_request_failed', level: 'warning', message: 'Application operation failed' }]
            : [{ at: '2026-10-30T12:00:00Z', code: 'server_initialised', level: 'info', message: 'Server runtime initialised' }],
        truncated: false, droppedSinceStart: 1,
    }) as never);
    render(<MonitoringPage />);
    await waitFor(() => expect(screen.getByText(/Server runtime initialised/)).toBeInTheDocument());
    expect(callTool).toHaveBeenCalledWith('read_server_diagnostics', { limit: 30 }, expect.any(AbortSignal));
    fireEvent.change(screen.getByLabelText('Diagnostic source'), { target: { value: 'history' } });
    fireEvent(window, new Event('hashchange'));
    expect(location.hash).toContain('history=1');
    await waitFor(() => expect(screen.getByText(/Application operation failed/)).toBeInTheDocument());
    expect(callTool).toHaveBeenCalledWith('read_server_diagnostic_history', { limit: 30 }, expect.any(AbortSignal));
    expect(screen.queryByText(/Server runtime initialised/)).not.toBeInTheDocument();
    expect(screen.getByText(/coverage may be incomplete/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Diagnostic source'), { target: { value: 'process' } });
    fireEvent(window, new Event('hashchange'));
    await waitFor(() => expect(location.hash).not.toContain('history=1'));
});

test('missing diagnostic archive is not rendered as an empty, healthy history', async () => {
    location.hash = '#/monitoring?tab=logs&target=server&history=1';
    vi.mocked(callTool).mockResolvedValue({
        source: 'atlas-server-history', available: false, retention: 'best-effort',
        retentionDays: 14, coverage: 'incomplete-possible', events: [], truncated: false,
    } as never);
    render(<MonitoringPage />);
    await waitFor(() => expect(screen.getByText(/source unavailable or disabled/)).toBeInTheDocument());
    expect(screen.queryByText('(no diagnostic events)')).not.toBeInTheDocument();
});
