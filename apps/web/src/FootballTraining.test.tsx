import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FootballTraining } from './FootballTraining';
import { callTool } from './api';

vi.mock('./api', () => ({ callTool: vi.fn() }));
const drills = [{ id: 'movement_v1', behavior: 'MovementDrill', scene: 'Assets/Scenes/ArenaSandbox.unity', observation_size: 6, continuous_actions: 2, configs: { smoke: 'smoke.yaml', full: 'full.yaml' } }];
const job = { id: 'movement_v1_demo', drill: 'movement_v1', preset: 'smoke', state: 'running', mode: 'independent_policy', arenas: 1, base_port: 5005, seed: 42, started_at: '2026-10-09T20:00:00Z' };
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(callTool).mockImplementation(async (name) => {
        if (name === 'football_list_drills') return drills as never;
        if (name === 'football_list_jobs') return [job] as never;
        if (name === 'football_list_policies') return [] as never;
        if (name === 'football_get_job_logs') return { text: 'Trainer connected' } as never;
        return { accepted: true, ticket: 'demo' } as never;
    });
});
afterEach(cleanup);
test('football panel reads real drills and run data and exposes run logs', async () => {
    render(<FootballTraining />);
    expect((await screen.findAllByText('movement_v1_demo')).length).toBeGreaterThan(0);
    expect(screen.getByText('6 observations')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View latest logs' }));
    expect(await screen.findByText('Trainer connected')).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('football_get_job_logs', { runId: 'movement_v1_demo', lines: 120 });
});
test('launch requires an explicit confirmation and only sends validated choices', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<FootballTraining />);
    await screen.findAllByText('movement_v1_demo');
    fireEvent.click(screen.getByRole('button', { name: /Launch training/ }));
    expect(confirm).toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalledWith('football_launch_training', expect.anything());
    confirm.mockRestore();
});
test('offline Node errors are visible, not replaced with fake training metrics', async () => {
    vi.mocked(callTool).mockRejectedValue(new Error('Workspace host Node is offline.'));
    render(<FootballTraining />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace host Node is offline');
    expect(screen.getByText('Running jobs')).toBeInTheDocument();
    expect(screen.queryByText('movement_v1_demo')).not.toBeInTheDocument();
});
