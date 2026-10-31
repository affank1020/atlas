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
