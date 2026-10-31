import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MonitoringPage } from './Monitoring';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn(), IS_MOCK_MODE: false }));
vi.mock('./Workspace', () => ({ MonitoringOverview: () => null }));
afterEach(() => {
    cleanup(); vi.resetAllMocks(); location.hash = '#/';
});

const base = () => ({
    checkedAt: '2026-10-31T10:40:00Z', overall: 'healthy',
    server: { status: 'healthy', startedAt: '2026-10-31T10:00:00Z',
        uptimeSeconds: 2400, database: { status: 'reachable', latencyMs: 2 } },
    nodes: { available: true,
        summary: { total: 0, healthy: 0, stale: 0, offline: 0,
            unavailable: 0, revoked: 0, unknown: 0 }, items: [] },
});
const diagnostics = {
    status: 'available', coverage: 'incomplete-possible', retentionDays: 14,
    droppedSinceStart: 0, queuedForWrite: 0, writePaused: false,
};

test('Monitoring health distinguishes DB success from diagnostic archive backoff and links retained evidence', async () => {
    location.hash = '#/monitoring?tab=overview';
    vi.mocked(callTool).mockResolvedValue({ ...base(), overall: 'unknown',
        diagnostics: { ...diagnostics, droppedSinceStart: 4, writePaused: true },
    } as never);
    render(<MonitoringPage />);
    expect(await screen.findByText('Server diagnostic archive')).toBeInTheDocument();
    expect(screen.getByText(/4 dropped since restart/)).toBeInTheDocument();
    expect(screen.getByText(/Archive writes are backing off/)).toBeInTheDocument();
    expect(screen.getByText(/Database query succeeded/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View retained diagnostics' })).toHaveAttribute('href',
        '#/monitoring?tab=logs&target=server&history=1');
    await waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
});

test('rolling upgrade renders older health responses as unknown archive state without crashing', async () => {
    location.hash = '#/monitoring?tab=overview';
    vi.mocked(callTool).mockResolvedValue(base() as never);
    render(<MonitoringPage />);
    expect(await screen.findByText(/Archive state unknown \(older Server revision\)/))
        .toBeInTheDocument();
    expect(screen.getByText('Server diagnostic archive')).toBeInTheDocument();
    expect(screen.getByLabelText('Overall health')).toHaveTextContent('unknown');
    expect(screen.getByLabelText('Overall health')).not.toHaveClass('success');
});

test('explicit disabled state and unreadable archive have different explanations', async () => {
    for (const state of ['disabled', 'unavailable'] as const) {
        location.hash = '#/monitoring?tab=overview';
        vi.mocked(callTool).mockResolvedValue({ ...base(),
            diagnostics: { ...diagnostics, status: state } } as never);
        const view = render(<MonitoringPage />);
        if (state === 'disabled') expect(await screen.findByText(/archive disabled by configuration/))
            .toBeInTheDocument();
        else expect(await screen.findByText(/Archive read not verified/)).toBeInTheDocument();
        view.unmount();
    }
});


test('unavailable archive still shows known dropped writes after backoff expires', async () => {
    location.hash = '#/monitoring?tab=overview';
    vi.mocked(callTool).mockResolvedValue({ ...base(), overall: 'unknown',
        diagnostics: { ...diagnostics, status: 'unavailable',
            droppedSinceStart: 7, queuedForWrite: 2, writePaused: false },
    } as never);
    render(<MonitoringPage />);
    expect(await screen.findByText(/Archive read not verified/)).toBeInTheDocument();
    expect(screen.getByText(/7 dropped since restart/)).toBeInTheDocument();
    expect(screen.getByText(/2 waiting to write/)).toBeInTheDocument();
    expect(screen.queryByText(/Archive writes are backing off/)).not.toBeInTheDocument();
    expect(screen.getByText(/Database query succeeded/)).toBeInTheDocument();
});

test('unknown diagnostic telemetry never invents zero lost or queued writes', async () => {
    location.hash = '#/monitoring?tab=overview';
    vi.mocked(callTool).mockResolvedValue({ ...base(), overall: 'unknown',
        diagnostics: { ...diagnostics, status: 'unknown',
            droppedSinceStart: null, queuedForWrite: null, writePaused: null },
    } as never);
    render(<MonitoringPage />);
    expect(await screen.findByText(/Archive read not verified/)).toBeInTheDocument();
    expect(screen.queryByText(/0 dropped since restart/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 waiting to write/)).not.toBeInTheDocument();
});

test('rolling upgrade keeps a genuine degraded aggregate and never upgrades it to unknown or healthy', async () => {
    location.hash = '#/monitoring?tab=overview';
    vi.mocked(callTool).mockResolvedValue({ ...base(), overall: 'degraded',
        server: { ...base().server, status: 'degraded', database: { status: 'unavailable' } },
    } as never);
    render(<MonitoringPage />);
    expect(await screen.findByText(/Archive state unknown \(older Server revision\)/))
        .toBeInTheDocument();
    expect(screen.getByLabelText('Overall health')).toHaveTextContent('degraded');
    expect(screen.getByLabelText('Overall health')).not.toHaveClass('success');
});

test('aggregate stays conservative when current archive evidence disagrees with a healthy Server aggregate', async () => {
    for (const archive of [
        { ...diagnostics, status: 'unavailable' },
        { ...diagnostics, status: 'unknown', droppedSinceStart: null, queuedForWrite: null },
        { ...diagnostics, status: 'available', droppedSinceStart: 2 },
        { ...diagnostics, status: 'available', writePaused: true },
    ]) {
        location.hash = '#/monitoring?tab=overview';
        vi.mocked(callTool).mockResolvedValue({ ...base(), diagnostics: archive } as never);
        const view = render(<MonitoringPage />);
        await screen.findByText('Server diagnostic archive');
        expect(screen.getByLabelText('Overall health')).toHaveTextContent('unknown');
        expect(screen.getByLabelText('Overall health')).not.toHaveClass('success');
        view.unmount();
    }
});

test('verified archive and explicitly disabled archive retain a healthy aggregate', async () => {
    for (const status of ['available', 'disabled'] as const) {
        location.hash = '#/monitoring?tab=overview';
        vi.mocked(callTool).mockResolvedValue({ ...base(), diagnostics: { ...diagnostics, status } } as never);
        const view = render(<MonitoringPage />);
        await screen.findByText('Server diagnostic archive');
        expect(screen.getByLabelText('Overall health')).toHaveTextContent('healthy');
        expect(screen.getByLabelText('Overall health')).toHaveClass('success');
        view.unmount();
    }
});
