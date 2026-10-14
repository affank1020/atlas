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


test('live trainer summaries populate steps, graph and budget before checkpoint status is saved', async () => {
    const runId = 'atlas-generalist-fecb1e8442a2';
    const logs = [
        '[INFO] Hyperparameters for behavior name FootballGeneralistV2:',
        '\tmax_steps:\t100000',
        '[INFO] FootballGeneralistV2. Step: 5000. Time Elapsed: 12.557 s. Mean Reward: 0.062. Std of Reward: 0.882. Training.',
        '[INFO] FootballGeneralistV2. Step: 10000. Time Elapsed: 21.838 s. Mean Reward: -0.015. Std of Reward: 0.883. Training.',
        '[INFO] FootballGeneralistV2. Step: 15000. Time Elapsed: 31.011 s. Mean Reward: 0.302. Std of Reward: 0.913. Training.',
    ].join('\n');
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_generalist_manifest') return contract as never;
        if (name === 'football_generalist_runs') return [{
            id: runId, family: 'generalist', state: 'running', scenario: 's1_rehearsal',
        }] as never;
        if (name === 'football_generalist_policies' || name === 'football_generalist_activity') return [] as never;
        if (name === 'football_generalist_run_detail') return {
            run: { id: runId, family: 'generalist', state: 'running', checkpoints: 0 },
            logs, errors: '', log_source: 'Atlas training launch', log_note: 'Live output',
            checkpoint_steps: null, checkpoint_samples: [], training_status: null, training_budget_steps: null,
        } as never;
        return [] as never;
    });
    render(<FootballGeneralistExperience />);
    fireEvent.click(await screen.findByRole('button', { name: runId + ' →' }));
    expect(await screen.findByText('15,000 / 100,000')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Training step progress' }))
        .toHaveAttribute('aria-valuenow', '15000');
    expect(screen.getByText('Latest mean reward')).toBeInTheDocument();
    expect(screen.getAllByText('0.302').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'Recorded mean training reward history' })).toBeInTheDocument();
    expect(screen.getByText('3 logged samples')).toBeInTheDocument();
});

test('older generalist run recovers progress and rewards from saved ML-Agents checkpoints', async () => {
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'football_generalist_manifest') return contract as never;
        if (name === 'football_generalist_runs') return [{ id: 'older-run', family: 'generalist', state: 'unknown',
            checkpoints: 2 }] as never;
        if (name === 'football_generalist_policies' || name === 'football_generalist_activity') return [] as never;
        if (name === 'football_generalist_run_detail') return {
            run: { id: 'older-run', family: 'generalist', state: 'unknown', checkpoints: 2,
                checkpoint_files: ['checkpoint-1.onnx', 'checkpoint-2.onnx'] },
            logs: '', errors: '', log_source: null, log_note: 'No trainer console available',
            ticket: null, training_status: {}, training_budget_steps: 100000,
            checkpoint_steps: 100003, checkpoint_samples: [
                { step: 39994, reward: 1.08 }, { step: 99997, reward: 1.17 },
                { step: 100003, reward: 1.1695 },
            ],
        } as never;
        return [] as never;
    });
    render(<FootballGeneralistExperience />);
    fireEvent.click(await screen.findByRole('button', { name: 'older-run →' }));
    expect(await screen.findByText('100,003 / 100,000')).toBeInTheDocument();
    expect(screen.getByText('Checkpoint reward')).toBeInTheDocument();
    expect(screen.getByText(/Saved ML-Agents checkpoint rewards/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Training step progress' })).toHaveAttribute('aria-valuenow', '100000');
    fireEvent.click(screen.getByRole('button', { name: 'Checkpoints (2)' }));
    expect(screen.getByText('checkpoint-1.onnx')).toBeInTheDocument();
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

test('Watch receipt shows player logging evidence without claiming a visible window', async () => {
    const ticket = 'ef456628-8eed-4579-af11-bc7248c745d8';
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'football_generalist_manifest') return contract as never;
        if (name === 'football_generalist_runs' || name === 'football_generalist_activity') return [] as never;
        if (name === 'football_generalist_policies') return [{
            id: 'generalist-check', status: 'unevaluated', behavior: 'FootballGeneralistV2',
            compatible_metadata: true, onnx_available: true, bundle_available: true,
        }] as never;
        if (name === 'football_generalist_watch') return {
            ticket, action: 'generalist_watch', status: 'launching', accepted: true,
        } as never;
        if (name === 'football_generalist_status') return {
            ticket, action: 'generalist_watch', status: 'running',
            viewer: { state: 'player_logging', launch_method: 'launchservices',
                launcher_alive: true, player_log_detected: true,
                note: 'Unity wrote a player log; this does not prove a window is visible.',
                log_tail: '[UnityMemory] Player startup' },
        } as never;
        return [] as never;
    });
    render(<FootballGeneralistExperience />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Unity player' }));
    expect(await screen.findByText('Viewer: Unity player is logging')).toBeInTheDocument();
    expect(screen.getByText(/does not prove a window is visible/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Unity player log (last 4 KB)'));
    expect(screen.getByText('[UnityMemory] Player startup')).toBeInTheDocument();
});

test('shows externally launched evaluation progress without a saved per-episode report', async () => {
    const ticket = 'da35acfe-5c55-4ed7-b86c-5052c779faa7';
    const operation = {
        ticket, action: 'generalist_evaluate', status: 'running', scenario: 's0-contact-easy-v1',
        policy_id: 'generalist-run', requested_episodes: 100,
        result: { episodes: 25, outcomes: { physical_contact: 25 }, success_rate: null },
    };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_generalist_manifest') return contract as never;
        if (name === 'football_generalist_runs' || name === 'football_generalist_policies') return [] as never;
        if (name === 'football_generalist_activity') return [operation] as never;
        if (name === 'football_generalist_evaluation_detail') return {
            operation, summary: null, episodes: [], pagination: { offset: 0, total: 0, has_more: false },
            note: 'Report is not yet saved.',
        } as never;
        return [] as never;
    });
    render(<FootballGeneralistExperience />);
    expect(await screen.findByText('25 / 100 episodes · 25 physical contact')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 's0-contact-easy-v1 →' }));
    expect(await screen.findByRole('progressbar', { name: 'Evaluation episode progress' }))
        .toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('25 / 100 episodes observed')).toBeInTheDocument();
    expect(screen.getByText('physical_contact')).toBeInTheDocument();
    expect(screen.getByText(/Individual episode records are not available yet/)).toBeInTheDocument();
});

test('S1 continuation requires a checkpoint and forwards the exact source run', async () => {
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'football_generalist_manifest') return contract as never;
        if (name === 'football_generalist_runs') return [{
            id: 'proven-s0', family: 'generalist', scenario: 'mix',
            contract_sha256: 'a', initialization_available: true, state: 'completed',
        }] as never;
        if (name === 'football_generalist_policies' || name === 'football_generalist_activity') return [] as never;
        if (name === 'football_generalist_train') return {
            accepted: true, ticket: 'f99de0da-adcc-4ec5-a8db-99539550aab9',
            action: 'generalist_train', status: 'launching',
        } as never;
        return [] as never;
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FootballGeneralistExperience />);
    await screen.findByRole('button', { name: 'Train' });
    fireEvent.click(screen.getByRole('button', { name: 'Train' }));
    fireEvent.change(screen.getByLabelText('Scenario'), { target: { value: 's1_rehearsal' } });
    expect(screen.getByRole('button', { name: 'Launch generalist training' })).toBeDisabled();
    expect(screen.getByText('Select a recorded S0 checkpoint before S1 continuation.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Initial weights'), { target: { value: 'proven-s0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch generalist training' }));
    await waitFor(() => expect(vi.mocked(callTool)).toHaveBeenCalledWith('football_generalist_train', {
        scenario: 's1_rehearsal', preset: 'smoke', seed: 42, arenas: 1,
        basePort: 5605, initializeFromRunId: 'proven-s0',
    }));
    vi.mocked(window.confirm).mockRestore();
});
