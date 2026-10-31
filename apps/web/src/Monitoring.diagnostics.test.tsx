import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MonitoringPage } from './Monitoring';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn(), IS_MOCK_MODE: false }));
vi.mock('./Workspace', () => ({ MonitoringOverview: () => null }));
afterEach(() => {
    cleanup(); vi.resetAllMocks(); location.hash = '#/';
});

const event = (message: string) => ({
    at: '2026-10-31T10:00:00Z', code: 'tool_request_failed',
    level: 'warning', message,
});
const history = (messages: string[], nextCursor?: string) => ({
    source: 'atlas-server-history', available: true, retention: 'best-effort',
    retentionDays: 14, coverage: 'incomplete-possible', droppedSinceStart: 0,
    truncated: Boolean(nextCursor), nextCursor, events: messages.map(event),
});

test('retained diagnostic history navigates using bounded cursors and returns to first page', async () => {
    location.hash = '#/monitoring?tab=logs&target=server&history=1';
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        expect(name).toBe('read_server_diagnostic_history');
        return ((input as { cursor?: string }).cursor
            ? history(['Second page older event'])
            : history(['First page recent event'], 'opaque-next-page')) as never;
    });
    render(<MonitoringPage />);
    expect(await screen.findByText(/First page recent event/)).toBeInTheDocument();
    expect(screen.getByText('History page 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Newer events' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Older events' }));
    expect(await screen.findByText(/Second page older event/)).toBeInTheDocument();
    expect(screen.queryByText(/First page recent event/)).not.toBeInTheDocument();
    expect(screen.getByText('History page 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Older events' })).toBeDisabled();
    expect(callTool).toHaveBeenCalledWith('read_server_diagnostic_history',
        { limit: 30, cursor: 'opaque-next-page' }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('button', { name: 'Newer events' }));
    expect(await screen.findByText(/First page recent event/)).toBeInTheDocument();
    expect(screen.getByText('History page 1')).toBeInTheDocument();
    expect(callTool).toHaveBeenLastCalledWith('read_server_diagnostic_history',
        { limit: 30 }, expect.any(AbortSignal));
});

test('changing page size or source clears a history cursor instead of leaking stale requests', async () => {
    location.hash = '#/monitoring?tab=logs&target=server&history=1';
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        if (name === 'read_server_diagnostics') return {
            source: 'atlas-server-process', available: true, retention: 'current-process',
            startedAt: '2026-10-31T10:00:00Z', truncated: false,
            events: [event('Process-only message')],
        } as never;
        const request = input as { cursor?: string; limit: number };
        return (request.cursor
            ? history(['Older page event'])
            : history(['Fresh history page'], 'page-cursor')) as never;
    });
    render(<MonitoringPage />);
    expect(await screen.findByText(/Fresh history page/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Older events' }));
    expect(await screen.findByText(/Older page event/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Diagnostic events'), { target: { value: '5' } });
    fireEvent(window, new Event('hashchange'));
    expect(await screen.findByText('History page 1')).toBeInTheDocument();
    await waitFor(() => expect(callTool).toHaveBeenLastCalledWith(
        'read_server_diagnostic_history', { limit: 5 }, expect.any(AbortSignal)));
    expect(screen.queryByText(/Older page event/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Diagnostic source'), { target: { value: 'process' } });
    fireEvent(window, new Event('hashchange'));
    expect(await screen.findByText(/Process-only message/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Older events' })).not.toBeInTheDocument();
    expect(callTool).toHaveBeenLastCalledWith('read_server_diagnostics',
        { limit: 5 }, expect.any(AbortSignal));
});

test('older Server versions cannot offer continuation controls they do not support', async () => {
    location.hash = '#/monitoring?tab=logs&target=server&history=1';
    vi.mocked(callTool).mockResolvedValue({
        ...history(['Older Server current page']), truncated: true,
        nextCursor: undefined,
    } as never);
    render(<MonitoringPage />);
    expect(await screen.findByText(/Older Server current page/)).toBeInTheDocument();
    expect(screen.getByText(/Older pages require an updated Atlas Server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Older events' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Newer events' })).toBeDisabled();
});

test('a stale older-page response cannot overwrite a subsequent source switch', async () => {
    location.hash = '#/monitoring?tab=logs&target=server&history=1';
    let finishOlder!: (response: unknown) => void;
    const pending = new Promise<unknown>(resolve => { finishOlder = resolve; });
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        if (name === 'read_server_diagnostics') return {
            source: 'atlas-server-process', available: true,
            startedAt: '2026-10-31T10:00:00Z', retention: 'current-process',
            truncated: false, events: [event('Live process text')],
        } as never;
        if ((input as { cursor?: string }).cursor) return pending as never;
        return history(['First page'], 'cursor') as never;
    });
    render(<MonitoringPage />);
    expect(await screen.findByText(/First page/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Older events' }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith(
        'read_server_diagnostic_history', { limit: 30, cursor: 'cursor' }, expect.any(AbortSignal)));
    fireEvent.change(screen.getByLabelText('Diagnostic source'), { target: { value: 'process' } });
    fireEvent(window, new Event('hashchange'));
    expect(await screen.findByText(/Live process text/)).toBeInTheDocument();
    finishOlder(history(['Stale historical message']));
    await Promise.resolve();
    expect(screen.queryByText(/Stale historical message/)).not.toBeInTheDocument();
    expect(screen.getByText(/Live process text/)).toBeInTheDocument();
});
