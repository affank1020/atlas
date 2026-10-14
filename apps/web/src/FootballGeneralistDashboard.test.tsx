import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FootballGeneralistDashboard } from './FootballGeneralistDashboard';

afterEach(cleanup);

const legacy = { id:'legacy_1', drill:'movement_v1', source_run_id:'old', indexed_at:'2026-10-12', behavior:'MovementDrill' };
const unpromoted = { id:'generalist_candidate', drill:'generalist_s0', source_run_id:'s0', indexed_at:'2026-10-14', behavior:'FootballGeneralistV1' };
const validated = { ...unpromoted, id:'generalist_promoted', promotion_status:'validated', indexed_at:'2026-10-15' };

test('legacy experiments are never presented as validated generalist competence', () => {
    render(<FootballGeneralistDashboard policies={[legacy]} drills={[]} evaluations={[]} onNavigate={vi.fn()} />);
    expect(screen.getByText('Architecture migration · no validated generalist checkpoint')).toBeInTheDocument();
    expect(screen.getByText('Legacy policies retained')).toBeInTheDocument();
    expect(screen.getAllByText('0', { selector: 'strong' }).length).toBeGreaterThan(0);
    expect(screen.getByText('37 vector observations', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('5 continuous actions', { exact: false })).toBeInTheDocument();
});

test('a candidate is not implicitly promoted and links preserve existing tools', () => {
    const navigate = vi.fn();
    render(<FootballGeneralistDashboard policies={[legacy,unpromoted]} drills={[]} evaluations={[]} onNavigate={navigate} />);
    expect(screen.getByText(/Latest unpromoted candidate/)).toBeInTheDocument();
    expect(screen.queryByText('Verified generalist checkpoint')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name:'Watch a policy →' }));
    expect(navigate).toHaveBeenCalledWith('viewer');
});

test('explicitly validated policy becomes the canonical hero', () => {
    render(<FootballGeneralistDashboard policies={[legacy,unpromoted,validated]} drills={[]} evaluations={[]} onNavigate={vi.fn()} />);
    expect(screen.getByText('Verified generalist checkpoint')).toBeInTheDocument();
    expect(screen.getByText('generalist_promoted')).toBeInTheDocument();
});
