import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FootballGeneralistDashboard } from './FootballGeneralistDashboard';

afterEach(cleanup);
const legacy = { id: 'legacy_1', drill: 'movement_v1', source_run_id: 'old', indexed_at: '2026-10-12', behavior: 'MovementDrill' };
const ambiguous = { id: 'looks_like_generalist', drill: 'generalist_s0', source_run_id: 's0', indexed_at: '2026-10-14', behavior: 'FootballGeneralistV1', promotion_status: 'validated' };
const candidate = { ...ambiguous, id: 'candidate', contract_version: 'football-generalist-v1', promotion_status: 'pending' };
const promoted = { ...candidate, id: 'promoted', promotion_status: 'validated' };
const baselineProps = { drills: [], jobs: [], evaluations: [], onNavigate: vi.fn(), onOpenRun: vi.fn() };

test('does not infer generalist success from behavior name or legacy checkpoints', () => {
    render(<FootballGeneralistDashboard {...baselineProps} policies={[legacy, ambiguous]} />);
    expect(screen.getByText('Not established')).toBeInTheDocument();
    expect(screen.getByText('2', { selector: '.football-lab-facts strong' })).toBeInTheDocument();
    expect(screen.getByText('Generalist scenario contract not connected.')).toBeInTheDocument();
});

test('identifies candidates, but promotion requires explicit evidence flag', () => {
    render(<FootballGeneralistDashboard {...baselineProps} policies={[legacy, candidate]} />);
    expect(screen.getByText('Not established')).toBeInTheDocument();
    expect(screen.getByText(/Most recent unpromoted candidate/)).toBeInTheDocument();
});

test('promoted policy appears without promoting other candidates', () => {
    render(<FootballGeneralistDashboard {...baselineProps} policies={[legacy, candidate, promoted]} />);
    expect(screen.getAllByText('promoted').length).toBeGreaterThan(0);
    expect(screen.getByText(/Promotion recorded/)).toBeInTheDocument();
});

test('recent running jobs open the existing control room, and tools stay reachable', () => {
    const onOpenRun = vi.fn();
    const onNavigate = vi.fn();
    render(<FootballGeneralistDashboard {...baselineProps} onNavigate={onNavigate} onOpenRun={onOpenRun} policies={[legacy]} jobs={[{id:'run_12',drill:'movement_v1',state:'running',started_at:'2026-10-14T00:00:00Z'}]} />);
    fireEvent.click(screen.getByRole('button', {name:/run_12/}));
    expect(onOpenRun).toHaveBeenCalledWith('run_12');
    fireEvent.click(screen.getByRole('button', {name:'Open policy Watch →'}));
    expect(onNavigate).toHaveBeenCalledWith('viewer');
});
