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

test('paging into history automatically disables live mode and its timers', async () => {
    vi.useFakeTimers();
    location.hash = '#/monitoring?tab=activity&live=1';
    vi.mocked(callTool).mockResolvedValue({
        ...activity('latest'), total: 70,
    } as never);
    render(<MonitoringPage />);
    await flush();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent(window, new Event('hashchange'));
    await flush();
    expect(location.hash).toContain('offset=30');
    expect(location.hash).not.toContain('live=1');
    expect(screen.getByRole('button', { name: 'Start live updates' })).toBeInTheDocument();
    const observed = vi.mocked(callTool).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(callTool).toHaveBeenCalledTimes(observed);
});


test('stopping live mode retains settled Activity and does not start a replacement read', async () => {
    vi.useFakeTimers();
    location.hash = '#/monitoring?tab=activity&live=1';
    vi.mocked(callTool).mockResolvedValue(activity('retained') as never);
    render(<MonitoringPage />);
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Record created').closest('[data-activity-id]'))
        .toHaveAttribute('data-activity-id', 'retained');
    fireEvent.click(screen.getByRole('button', { name: 'Stop live updates' }));
    fireEvent(window, new Event('hashchange'));
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Loading audit history…')).not.toBeInTheDocument();
    expect(screen.getByText('Record created').closest('[data-activity-id]'))
        .toHaveAttribute('data-activity-id', 'retained');
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(callTool).toHaveBeenCalledTimes(1);
});

test('quick Start/Stop toggles reuse the previous cooldown and never fire extra requests', async () => {
    vi.useFakeTimers();
    location.hash = '#/monitoring?tab=activity';
    vi.mocked(callTool).mockResolvedValue(activity('first') as never);
    render(<MonitoringPage />);
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start live updates' }));
    fireEvent(window, new Event('hashchange'));
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    fireEvent.click(screen.getByRole('button', { name: 'Stop live updates' }));
    fireEvent(window, new Event('hashchange'));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Start live updates' }));
    fireEvent(window, new Event('hashchange'));
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(28_999); });
    expect(callTool).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(callTool).toHaveBeenCalledTimes(2);
});

test('switching live mode while a request is pending neither aborts nor duplicates that read', async () => {
    location.hash = '#/monitoring?tab=activity&live=1';
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(accept => { resolve = accept; });
    vi.mocked(callTool).mockImplementation(() => pending as never);
    render(<MonitoringPage />);
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    const activeSignal = vi.mocked(callTool).mock.calls[0]![2]!;
    fireEvent.click(screen.getByRole('button', { name: 'Stop live updates' }));
    fireEvent(window, new Event('hashchange'));
    await act(async () => { await Promise.resolve(); });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(activeSignal.aborted).toBe(false);
    await act(async () => { resolve(activity('settled')); });
    expect(screen.getByText('Record created').closest('[data-activity-id]'))
        .toHaveAttribute('data-activity-id', 'settled');
    expect(callTool).toHaveBeenCalledTimes(1);
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

test('rapid tab switching does not bypass the 30-second live read cooldown', async () => {
    vi.useFakeTimers();
    let visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    location.hash = '#/monitoring?tab=activity&live=1';
    vi.mocked(callTool).mockResolvedValue(activity('live') as never);
    render(<MonitoringPage />);
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    visibility = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(28_999); });
    expect(callTool).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(callTool).toHaveBeenCalledTimes(2);
});

test('a live Activity deep link opened in a hidden tab does not read until visible', async () => {
    vi.useFakeTimers();
    let visibility = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    location.hash = '#/monitoring?tab=activity&live=1';
    vi.mocked(callTool).mockResolvedValue(activity('live') as never);
    render(<MonitoringPage />);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(callTool).not.toHaveBeenCalled();
    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
});

test('live failures back off without overlapping; a successful read restores the normal interval', async () => {
    vi.useFakeTimers();
    location.hash = '#/monitoring?tab=activity&live=1';
    vi.mocked(callTool).mockRejectedValueOnce(new Error('temporary outage'))
        .mockResolvedValue(activity('recovered') as never);
    render(<MonitoringPage />);
    await flush();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('temporary outage');
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(callTool).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(callTool).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(callTool).toHaveBeenCalledTimes(3);
});
