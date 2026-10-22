import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MonitoringPage } from './Monitoring';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn(), IS_MOCK_MODE: false }));
vi.mock('./Workspace', () => ({ MonitoringOverview: () => null }));
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetAllMocks();
    location.hash = '#/';
});

const activity = (name: string) => ({
    items: [{ id: name, occurredAt: '2026-10-22T12:00:00Z', client: 'test',
        operation: 'record.created', resulting: {} }], total: 1, offset: 0, limit: 30,
});
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

test('Monitoring Activity defaults to manual-only reads, with no recurring refresh', async () => {
    vi.useFakeTimers();
    location.hash = '#/monitoring?tab=activity';
    vi.mocked(callTool).mockResolvedValue(activity('first') as never);
    render(<MonitoringPage />);
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Start live updates' })).toHaveAttribute('aria-pressed', 'false');
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(callTool).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect(callTool).toHaveBeenCalledTimes(2);
});

test('opt-in live mode schedules after completion and pauses completely in hidden tabs', async () => {
    vi.useFakeTimers();
    let visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    location.hash = '#/monitoring?tab=activity&client=codex&live=1';
    vi.mocked(callTool).mockResolvedValue(activity('live') as never);
    render(<MonitoringPage />);
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('query_monitoring_activity',
        { client: 'codex', offset: 0, limit: 30, groupOperations: true, safeDetails: true },
        expect.any(AbortSignal));
    expect(screen.getByRole('button', { name: 'Stop live updates' })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(callTool).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(callTool).toHaveBeenCalledTimes(2);

    visibility = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(callTool).toHaveBeenCalledTimes(2);

    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    await flush();
    expect(callTool).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Stop live updates' }));
    fireEvent(window, new Event('hashchange'));
    await flush();
    expect(screen.getByRole('button', { name: 'Start live updates' })).toHaveAttribute('aria-pressed', 'false');
    const disabledCount = vi.mocked(callTool).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(callTool).toHaveBeenCalledTimes(disabledCount);
});

test('in-flight polling never overlaps, even if a read runs longer than the interval', async () => {
    vi.useFakeTimers();
    location.hash = '#/monitoring?tab=activity&live=1';
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(accept => { resolve = accept; });
    vi.mocked(callTool).mockImplementation(() => pending as never);
    const view = render(<MonitoringPage />);
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(callTool).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(activity('long')); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(callTool).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(callTool).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(callTool).toHaveBeenCalledTimes(2);
});

test('late live response from an abandoned scope cannot replace the current Activity feed', async () => {
    location.hash = '#/monitoring?tab=activity&live=1&client=first';
    let finishOld!: (page: unknown) => void;
    vi.mocked(callTool).mockImplementation((_name, input) => input?.client === 'first'
        ? new Promise(resolve => { finishOld = resolve; }) as never
        : Promise.resolve(activity('current') as never));
    render(<MonitoringPage />);
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    location.hash = '#/monitoring?tab=activity&live=1&client=second';
    fireEvent(window, new Event('hashchange'));
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Record created')).toBeInTheDocument();
    const latest = screen.getByText('Record created').closest('[data-activity-id]');
    expect(latest).toHaveAttribute('data-activity-id', 'current');
    await act(async () => { finishOld(activity('stale')); });
    expect(screen.getByText('Record created').closest('[data-activity-id]')).toHaveAttribute('data-activity-id', 'current');
});
