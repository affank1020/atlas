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
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_run_evaluation', { policyId: policy.id, episodes: 100, seed: 123 }));
    fireEvent.click(screen.getByRole('button', { name: /^Watch/ }));
    fireEvent.click(screen.getByRole('button', { name: /Watch live on Mac/ }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_watch_live', { runId: activeJob.id }));
    fireEvent.click(screen.getByRole('button', { name: /Open policy viewer/ }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith('football_open_policy_viewer', { policyId: policy.id, arenas: 1, seed: 42 }));
});
test('offline Node errors stay visible without fake metrics', async () => {
    vi.mocked(callTool).mockRejectedValue(new Error('Workspace host Node is offline.'));
    render(<FootballTraining />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace host Node is offline');
    expect(screen.getByText('Running jobs')).toBeInTheDocument();
    expect(screen.queryByText('movement_v1_demo')).not.toBeInTheDocument();
});
