import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FootballGeneralistDashboard, type GeneralistManifest } from './FootballGeneralistDashboard';

afterEach(cleanup);
const legacy = { id: 'legacy_1', drill: 'movement_v1', source_run_id: 'old', indexed_at: '2026-10-12', behavior: 'MovementDrill' };
const ambiguous = { id: 'looks_like_generalist', drill: 'generalist_s0', source_run_id: 's0', indexed_at: '2026-10-14', behavior: 'FootballGeneralistV2', promotion_status: 'validated' };
const candidate = { ...ambiguous, id: 'candidate', family: 'generalist', contract_version: 'football-generalist-v2', promotion_status: 'pending', contract_sha256: 'abc', scenario_sha256: 'def' };
const promoted = { ...candidate, id: 'promoted', promotion_status: 'validated' };
const manifest: GeneralistManifest = {
    available: true, source: 'unity-workspace', provenance: 'working_tree_metadata_not_policy_validation',
    contract: { contract_id: 'football-generalist-v2', behavior: 'FootballGeneralistV2', status: 'runtime_validated_s0',
        observations: { size: 54, fields: [{ name: 'ball.relative_position_xz', indices: [3, 4] }] },
        actions: { continuous: 5, channels: [{index: 0, name: 'throttle', range: [-1, 1]}] } },
    scenarios: { physicsVersion: 'p2', sceneVersion: 's2', scenarios: [{ id: 's0-contact-easy-v1', name: 'First contact', stage: 0, objective: 'Make physical contact', physicalDifficulty: 0, decisionComplexity: 0, weight: 0.7, targetRepresentation: 'ball_label_and_ring', episodeSeconds: 12 }] },
    curriculum: { stages: [{ id: 'S0', name: 'Contact', implemented: true }, { id: 'S1', name: 'Dribbling', implemented: false }], current_checkpoint: null },
    fingerprints: { contract_sha256: 'abc', scenario_sha256: 'def', curriculum_sha256: 'ghi' },
};
const props = { drills: [], jobs: [], evaluations: [], onNavigate: vi.fn(), onOpenRun: vi.fn() };

test('missing manifest and legacy entries do not claim generalist progress', () => {
    render(<FootballGeneralistDashboard {...props} policies={[legacy, ambiguous]} />);
    expect(screen.getByText('Not established')).toBeInTheDocument();
    expect(screen.getByText('Generalist scenario contract not connected.')).toBeInTheDocument();
    expect(screen.getByText('Unity generalist metadata unavailable')).toBeInTheDocument();
});

test('candidate cannot be promoted without provenance-matching manifest', () => {
    render(<FootballGeneralistDashboard {...props} policies={[legacy, candidate, promoted]} />);
    expect(screen.getByText('Not established')).toBeInTheDocument();
});

test('actual Unity metadata drives observations actions stages and scenario cards', () => {
    render(<FootballGeneralistDashboard {...props} policies={[legacy, candidate]} manifest={manifest} />);
    expect(screen.getByText('football-generalist-v2')).toBeInTheDocument();
    expect(screen.getByText('54')).toBeInTheDocument();
    expect(screen.getByText('First contact')).toBeInTheDocument();
    expect(screen.getByText('Make physical contact')).toBeInTheDocument();
    expect(screen.getByText('Implemented in Unity · not graduated')).toBeInTheDocument();
    expect(screen.getByText('Not established')).toBeInTheDocument();
});

test('explicit promotion with matching fingerprints appears without promoting candidates', () => {
    render(<FootballGeneralistDashboard {...props} policies={[legacy, candidate, promoted]} manifest={manifest} />);
    expect(screen.getAllByText('promoted').length).toBeGreaterThan(0);
    expect(screen.getByText(/Promotion recorded/)).toBeInTheDocument();
});

test('run opens existing control room and Watch remains accessible', () => {
    const onOpenRun = vi.fn(), onNavigate = vi.fn();
    render(<FootballGeneralistDashboard {...props} onNavigate={onNavigate} onOpenRun={onOpenRun} policies={[legacy]} jobs={[{id:'run_12',drill:'movement_v1',state:'running',started_at:'2026-10-14T00:00:00Z'}]} />);
    fireEvent.click(screen.getByRole('button', {name:/run_12/}));
    expect(onOpenRun).toHaveBeenCalledWith('run_12');
    fireEvent.click(screen.getByRole('button', {name:'Open policy Watch →'}));
    expect(onNavigate).toHaveBeenCalledWith('viewer');
});
