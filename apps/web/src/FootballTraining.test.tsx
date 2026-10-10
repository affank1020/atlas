import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FootballTraining } from './FootballTraining';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
const drills = [{ id: 'movement_v1', behavior: 'MovementDrill', scene: 'Assets/Scenes/ArenaSandbox.unity', observation_size: 6, continuous_actions: 2, configs: { smoke: 'smoke.yaml', full: 'full.yaml' } }];
const activeJob = { id: 'movement_v1_demo', drill: 'movement_v1', preset: 'smoke', state: 'running', mode: 'independent_policy', arenas: 1, base_port: 5005, seed: 42, started_at: '2026-10-09T20:00:00Z' };
const archivedJob = { ...activeJob, id: 'movement_v1_old', state: 'not_running', started_at: '2025-01-01T20:00:00Z' };
const policy = { id: 'policy_movement_v1_old', drill: 'movement_v1', role: 'unassigned', source_run_id: 'movement_v1_old', artifacts: [{ path: 'model.onnx', final: true }], indexed_at: '2026-01-01', evaluation: 'not_evaluated' };
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'football_list_drills') return drills as never;
        if (name === 'football_list_jobs') return [activeJob, archivedJob] as never;
        if (name === 'football_list_policies') return [policy] as never;
        if (name === 'football_list_evaluations') return [] as never;
        if (name === 'football_list_viewers') return [] as never;
        if (name === 'football_get_job_logs') return { text: 'Trainer connected' } as never;
        return { accepted: true, ticket: 'viewer_demo', status: 'launching' } as never;
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
test('lab navigates to runs, filters history, and loads logs', async () => {
    render(<FootballTraining />);
    expect(await screen.findByText('2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Runs/ }));
    expect(screen.getAllByText('movement_v1_demo').length).toBeGreaterThan(0);
    expect(screen.queryByText('movement_v1_old')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('movement_v1_old')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Active' }));
    fireEvent.click(screen.getByRole('button', { name: 'View latest logs' }));
    expect(await screen.findByText('Trainer connected')).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('football_get_job_logs', { runId: 'movement_v1_demo', lines: 120 });
});
test('clicking a run opens the control room and returns to the runs list', async () => {
    render(<FootballTraining />);
    await screen.findByText('2');
    fireEvent.click(screen.getByRole('button', { name: /^Runs/ }));
    fireEvent.click(screen.getByRole('button', { name: /movement_v1_demo.*Movement.*1 arena/i }));
    expect(await screen.findByText('EXPERIMENT CONTROL ROOM')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '← All runs' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '← All runs' }));
    expect(screen.getByRole('button', { name: 'View latest logs' })).toBeInTheDocument();
});
test('training launch confirms before running', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<FootballTraining />);
    await screen.findByText('2');
    fireEvent.click(screen.getByRole('button', { name: /^Train/ }));
    fireEvent.click(screen.getByRole('button', { name: /Launch training/ }));
    expect(confirm).toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalledWith('football_launch_training', expect.anything());
});
test('evaluation and viewer commands use typed policy and run operations', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FootballTraining />);
    await screen.findByText('2');
    fireEvent.click(screen.getByRole('button', { name: /^Evaluation/ }));
    fireEvent.click(screen.getByRole('button', { name: /Run evaluation/ }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_run_evaluation', { policyId: policy.id, episodes: 100, seed: 123, replayEpisode: 0 }));
    fireEvent.click(screen.getByRole('button', { name: /^Watch/ }));
    fireEvent.click(screen.getByRole('button', { name: /Watch live on Mac/ }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_watch_live', { runId: activeJob.id }));
    fireEvent.click(screen.getByRole('button', { name: /Open policy viewer/ }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_open_policy_viewer', { policyId: policy.id, arenas: 1, seed: 42 }));
});
test('Stage 1 baseline evaluation is launched through the typed controller action', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FootballTraining />);
    await screen.findByText('2');
    fireEvent.click(screen.getByRole('button', { name: /^Evaluation/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Baseline controller' }), { target: { value: 'forward' } });
    fireEvent.click(screen.getByRole('button', { name: /Run Stage-1 baseline/ }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_run_baseline_evaluation',
        { baselineMode: 'forward', episodes: 100, seed: 123, replayEpisode: 0 }));
});
test('offline Node errors stay visible without fake metrics', async () => {
    vi.mocked(callTool).mockRejectedValue(new Error('Workspace host Node is offline.'));
    render(<FootballTraining />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace host Node is offline');
    expect(screen.getByText('Running jobs')).toBeInTheDocument();
    expect(screen.queryByText('movement_v1_demo')).not.toBeInTheDocument();
});

test('curriculum presets are discovered from the drill registry and launch with the selected stage', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const ballDrill = {
        id: 'ball_control_v1', behavior: 'BallControlDrill', scene: 'Assets/Scenes/BallControlDrill.unity',
        observation_size: 10, continuous_actions: 2,
        configs: { smoke: 'smoke.yaml', full: 'full.yaml', approach: 'approach.yaml', approach_wide: 'approach_wide.yaml', first_touch: 'first_touch.yaml', dribble: 'dribble.yaml' },
        curriculum: { version: 1, mode: 'manual', stages: [
            { id: 'approach', preset: 'approach', stage: 1, title: 'Approach & contact', description: 'Touch a close ball.', metric: 'physical_contact_success_rate' },
            { id: 'first_touch', preset: 'first_touch', stage: 2, title: 'First touch', description: 'Move the ball.', metric: 'controlled_first_touch_success_rate' },
            { id: 'dribble', preset: 'dribble', stage: 3, title: 'Dribble', description: 'Keep control.', metric: 'controlled_dribble_success_rate' },
        ], variants: [
            { id: 'approach_wide', preset: 'approach_wide', stage: 1, title: 'Wide-angle approach', description: '30/70 narrow/wide starts.', metric: 'physical_contact_success_rate', training_spawn: 'wide_mix_v1' },
        ] },
    };
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_list_drills') return [drills[0], ballDrill] as never;
        if (name === 'football_list_jobs') return [activeJob] as never;
        if (name === 'football_list_policies') return [policy] as never;
        if (name === 'football_list_evaluations' || name === 'football_list_viewers') return [] as never;
        return { accepted: true, ticket: 'stage_demo', status: 'launching' } as never;
    });
    render(<FootballTraining />);
    await screen.findByText('2');
    fireEvent.click(screen.getByRole('button', { name: /^Train/ }));
    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'ball_control_v1' } });
    expect(screen.getByText(/Manual stages · v1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /1\. Approach & contact/ }));
    expect(screen.getByLabelText('Training preset')).toHaveValue('approach');
    fireEvent.click(screen.getByRole('button', { name: /Launch training/ }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_launch_training',
        { drill: 'ball_control_v1', preset: 'approach', arenas: 1, basePort: 5005, seed: 42 }));
    fireEvent.click(screen.getByRole('button', { name: /Stage 1 experiment · Wide-angle approach/ }));
    expect(screen.getByLabelText('Training preset')).toHaveValue('approach_wide');
    expect(screen.getByText(/Training distribution: wide_mix_v1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Launch training/ }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_launch_training',
        { drill: 'ball_control_v1', preset: 'approach_wide', arenas: 1, basePort: 5005, seed: 42 }));
});
