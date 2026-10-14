import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { callTool } from './api';
import { FootballGeneralistExperience } from './FootballGeneralistExperience';

vi.mock('./api', () => ({ callTool: vi.fn() }));
const contract = {
    available: true,
    contract: { contract_id: 'football-generalist-v2', behavior: 'FootballGeneralistV2',
        observations: { size: 54, fields: [] }, actions: { continuous: 5, channels: [{ index: 0, name: 'throttle' }] } },
    scenarios: { sceneVersion: 's2', physicsVersion: 'p2', scenarios: [{ id: 's0-contact-easy-v1', name: 'Easy contact', stage: 0, objective: 'Touch ball' }] },
    curriculum: { stages: [{ id: 'S0', name: 'Contact', implemented: true }], held_out_seeds: [515] },
    fingerprints: { contract_sha256: 'a', scenario_sha256: 'b' },
};
beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'football_generalist_manifest') return contract as never;
        if (name === 'football_generalist_runs') return [{ id: 'external-s0', family: 'generalist', state: 'unknown', scenario: 's0-contact-easy-v1' }] as never;
        if (name === 'football_generalist_policies') return [] as never;
        if (name === 'football_generalist_activity') return [] as never;
        if (name === 'football_list_policies') return [{ id: 'legacy-policy', drill: 'shooting_v1' }] as never;
        if (name === 'football_list_jobs') return [{ id: 'legacy-run', drill: 'shooting_v1', state: 'completed' }] as never;
        return [] as never;
    });
});
afterEach(cleanup);

test('Generalist application defaults to new contract, not legacy driver', async () => {
    render(<FootballGeneralistExperience />);
    expect(await screen.findByRole('button', { name: 'external-s0 →' })).toBeInTheDocument();
    expect(screen.getByText('football-generalist-v2')).toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.map(([name]) => name)).toEqual([
        'football_generalist_manifest', 'football_generalist_runs',
        'football_generalist_policies', 'football_generalist_activity',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Train' }));
    expect(screen.getByRole('button', { name: 'Launch generalist training' })).toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'football_list_drills')).toBe(false);
});

test('Historical specialist data is fetched only when opening read-only archive', async () => {
    render(<FootballGeneralistExperience />);
    await screen.findByRole('button', { name: 'external-s0 →' });
    fireEvent.click(screen.getByRole('button', { name: 'Legacy archive' }));
    expect(await screen.findByText('legacy-policy')).toBeInTheDocument();
    expect(screen.getByText('legacy-run')).toBeInTheDocument();
    expect(vi.mocked(callTool).mock.calls.map(([name]) => name)).toContain('football_list_jobs');
    expect(screen.queryByRole('button', { name: /Launch specialist/ })).toBeNull();
});


test('opens generalist run inspection and keeps an honest no-log state', async () => {
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'football_generalist_manifest') return contract as never;
        if (name === 'football_generalist_runs') return [{ id: 'external-s0', family: 'generalist', state: 'unknown', output_dir: 'training-driver-runs/external-s0', checkpoints: 0 }] as never;
        if (name === 'football_generalist_policies' || name === 'football_generalist_activity') return [] as never;
        if (name === 'football_generalist_run_detail') return { run: { id: 'external-s0', family: 'generalist', state: 'unknown', output_dir: 'training-driver-runs/external-s0' },
            logs: '', errors: '', log_source: null, log_note: 'No saved trainer log', training_status: null, ticket: null } as never;
        return [] as never;
    });
    render(<FootballGeneralistExperience />);
    fireEvent.click(await screen.findByRole('button', { name: 'external-s0 →' }));
    expect(await screen.findByText(/No saved trainer log/)).toBeInTheDocument();
    expect(vi.mocked(callTool)).toHaveBeenCalledWith('football_generalist_run_detail', { runId: 'external-s0' });
    fireEvent.click(screen.getByRole('button', { name: '← Training runs' }));
    expect(screen.queryByRole('button', { name: 'Launch generalist training' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'external-s0 →' })).toBeInTheDocument();
});

test('policy profile links to recorded evaluations and preselects Watch', async () => {
    const ticket = '75ed74ef-a004-4299-8f2f-ad47389cd39a';
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'football_generalist_manifest') return contract as never;
        if (name === 'football_generalist_runs') return [{ id: 'source-1', family: 'generalist', state: 'completed', output_dir: 'training-driver-runs/source-1' }] as never;
        if (name === 'football_generalist_policies') return [{ id: 'policy_generalist-a', behavior: 'FootballGeneralistV2', status: 'indexed',
            source: 'training-driver-runs/source-1/policy.json', source_run_id: 'source-1', compatible_metadata: true,
            executable_verified: false, onnx_available: true, bundle_available: true }] as never;
        if (name === 'football_generalist_activity') return [{ action: 'generalist_evaluate', ticket, status: 'completed',
            scenario: 's0-contact-easy-v1', policy_id: 'policy_generalist-a', result: { episodes: 2 } }] as never;
        if (name === 'football_generalist_evaluation_detail') return { operation: { action: 'generalist_evaluate', ticket,
            status: 'completed', policy_id: 'policy_generalist-a', scenario: 's0-contact-easy-v1' },
            summary: { total: 2, outcomes: { success: 2 }, success_rate: 1, measured_success_episodes: 2 },
            episodes: [{ index: 0, outcome: 'success', success: true }], pagination: { offset: 0, total: 2, has_more: false },
            note: 'Measured' } as never;
        return [] as never;
    });
    render(<FootballGeneralistExperience />);
    fireEvent.click(screen.getByRole('button', { name: 'Policies' }));
    fireEvent.click(await screen.findByRole('button', { name: 'policy_generalist-a →' }));
    expect(screen.getByText('POLICY PROFILE')).toBeInTheDocument();
    expect(screen.getByText('Saved evaluations')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /s0-contact-easy-v1.*completed/ }));
    expect(await screen.findByText('100%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'policy_generalist-a →' }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch in Unity →' }));
    expect(screen.getByRole('heading', { name: 'Watch a generalist policy' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Policy' })).toHaveValue('policy_generalist-a');
});

test('allows safe backfill packaging for exported generalist ONNX without another PPO launch', async () => {
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'football_generalist_manifest') return contract as never;
        if (name === 'football_generalist_runs') return [{
            id: 'finished-100k', family: 'generalist', state: 'unknown',
            checkpoint_files: ['training-driver-runs/finished-100k/finished-100k/FootballGeneralistV2.onnx'],
            packaging: { status: 'not_registered' },
        }] as never;
        if (name === 'football_generalist_policies' || name === 'football_generalist_activity') return [] as never;
        if (name === 'football_generalist_package') return {
            accepted: true, ticket: 'a561b3cc-a8bf-4331-a4f8-e497219bbb92',
            action: 'generalist_package', status: 'launching',
        } as never;
        return [] as never;
    });
    render(<FootballGeneralistExperience />);
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Package policy' }));
    await waitFor(() => expect(vi.mocked(callTool)).toHaveBeenCalledWith(
        'football_generalist_package', { runId: 'finished-100k' }));
    expect(vi.mocked(callTool).mock.calls.some(([name]) => name === 'football_generalist_train')).toBe(false);
});
