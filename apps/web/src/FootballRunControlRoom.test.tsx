import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, test, expect, vi } from 'vitest';
import { FootballRunControlRoom, FootballEvaluationControlRoom, parseFootballTrainingLog } from './FootballRunControlRoom';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
const runId = 'ball_control_v1_20261010_101826_7d9b40';
const job = { id: runId, drill: 'ball_control_v1', preset: 'approach', state: 'not_running', arenas: 2, base_port: 5250, seed: 515,
    started_at: '2026-10-10T09:18:26.187Z', curriculum_stage: 1, curriculum_stage_id: 'approach' };
const logs = [
    '\tmax_steps:\t20000',
    '[INFO] BallControlDrill. Step: 10000. Time Elapsed: 56.148 s. Mean Reward: -0.108. Std of Reward: 0.666. Training.',
    '[INFO] BallControlDrill. Step: 20000. Time Elapsed: 118.090 s. Mean Reward: -0.069. Std of Reward: 0.681. Training.',
    '[INFO] Exported /runs/BallControlDrill-20034.onnx',
    '[INFO] Copied /runs/BallControlDrill-20034.onnx to /runs/BallControlDrill.onnx.',
].join('\n');
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_list_jobs') return [job] as never;
        if (name === 'football_get_job_logs') return { text: logs } as never;
        return [] as never;
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
test('parses reported budget, reward samples and final exported model', () => {
    const parsed = parseFootballTrainingLog(logs);
    expect(parsed.budget).toBe(20000);
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.samples[1].reward).toBe(-0.069);
    expect(parsed.finalModel).toBe('BallControlDrill.onnx');
    expect(parsed.checkpoints[0].step).toBe(20034);
});
test('run detail refreshes Mac logs and distinguishes a likely completed job from merely inactive', async () => {
    const back = vi.fn(), watch = vi.fn(), index = vi.fn();
    render(<FootballRunControlRoom runId={runId} onBack={back} onWatch={watch} onStop={vi.fn()} onIndex={index}
        onEvaluate={vi.fn()} policies={[]} evaluations={[]} />);
    expect(await screen.findByText('Likely completed')).toBeInTheDocument();
    expect(screen.getAllByText('20,000', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText('Physical contact success')).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('football_get_job_logs', { runId, lines: 200 });
    fireEvent.click(screen.getByRole('button', { name: 'Checkpoint timeline (1)' }));
    expect(screen.getByText('BallControlDrill-20034.onnx')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Index policy' }));
    expect(index).toHaveBeenCalledWith(runId);
    fireEvent.click(screen.getByRole('button', { name: '← All runs' }));
    expect(back).toHaveBeenCalled();
});
test('incomplete terminal evidence is not labelled successful', async () => {
    vi.mocked(callTool).mockImplementation(async name => name === 'football_list_jobs' ? [job] as never : { text: '[INFO] starting…' } as never);
    render(<FootballRunControlRoom runId={runId} onBack={vi.fn()} onWatch={vi.fn()} onStop={vi.fn()} onIndex={vi.fn()}
        onEvaluate={vi.fn()} policies={[]} evaluations={[]} />);
    expect(await screen.findByText('Inactive — reason unknown')).toBeInTheDocument();
    expect(screen.queryByText('Likely completed')).not.toBeInTheDocument();
});
test('evaluation detail keeps saved summary when diagnostics are unavailable', async () => {
    vi.mocked(callTool).mockRejectedValue(new Error('Node needs update'));
    render(<FootballEvaluationControlRoom evaluation={{
        id:'eval_test', policy_id: 'policy_test', drill: 'ball_control_v1', episodes: 100, seed: 515,
        success_rate: .13, contact_episodes: 13, mean_reward: -.2, curriculum_stage: 1,
    }} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('13.0%')).toBeInTheDocument());
    expect(await screen.findByText('Could not load detailed diagnostics:', { exact: false })).toBeInTheDocument();
});
test('evaluation diagnostics show real measured contact distances and preserve missing times for failed episodes', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_get_evaluation_detail') return {
            id: 'eval_v2', diagnostics_version: 2, episodes: 2, seed: 515,
            pagination: { offset: 0, limit: 100, total: 2, has_more: false },
            summary: {
                physical_contact_episodes: 1, termination_reasons: { physical_contact: 1, timeout: 1 },
                mean_start_distance_m: 2.2, mean_min_distance_m: 0.71,
                mean_time_to_contact_s: 1.5, mean_episode_duration_s: 7,
                closest_approach_buckets: { under_0_5_m: 1, '0_5_to_1_m': 0, '1_to_2_m': 1, over_2_m: 0 },
            },
            episode_results: [
                { index: 1, success: true, reward: 1.11, ball_control: { has_contact: true, termination_reason: 'physical_contact', start_player_ball_distance_m: 2.3, min_player_ball_distance_m: .4, time_to_first_contact_s: 1.5 } },
                { index: 2, success: false, reward: -.5, ball_control: { has_contact: false, termination_reason: 'timeout', start_player_ball_distance_m: 2.1, min_player_ball_distance_m: 1.02, time_to_first_contact_s: null } },
            ],
        } as never;
        return [] as never;
    });
    render(<FootballEvaluationControlRoom evaluation={{
        id:'eval_v2', policy_id:'policy_test', drill:'ball_control_v1',
        episodes:2, seed:515, success_rate:.5, mean_reward:.305,
        contact_episodes:1, curriculum_stage:1,
    }} onBack={vi.fn()} />);
    expect(await screen.findByText('Physics diagnostics v2')).toBeInTheDocument();
    expect(screen.getByText('Mean nearest')).toBeInTheDocument();
    expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0);
    expect(screen.getAllByText('physical contact').length).toBeGreaterThan(0);
    expect(callTool).toHaveBeenCalledWith('football_get_evaluation_detail', { evaluationId: 'eval_v2', offset: 0, limit: 100 });
});

