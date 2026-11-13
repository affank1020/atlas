import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { callTool } from './api';
import { FootballGeneralistExperience } from './FootballGeneralistExperience';

vi.mock('./api', () => ({ callTool: vi.fn(), onToolMutation: () => () => {} }));

const manifest = {
    available: true,
    contract: {
        contract_id: 'fyp-football-v1', behavior: 'FootballV1',
        observations: { size: 25 }, actions: { continuous: 8 }, trainer_kind: 'poca',
        scene: 'Assets/Football/Scenes/OpenGoalClose.unity',
    },
};
const readyPreflight = {
    editor_available: true, editor_open: true, editor_playing: false, editor_compiling: false,
    trainer_connected: false, trainer_available: true, scene_ready: true,
    active_scene: 'Assets/Football/Scenes/OpenGoalClose.unity', environment_present: false,
    episode: null, goals: null, last_outcome: null, episodes_completed: null, recent_episodes: [],
    heartbeat_age_seconds: 1, verified_build: false, ready_to_train: true,
    source_sha256: 'abc123', note: '',
};
const runs = [{
    run_id: 'run-smoke', preset: 'smoke', steps: 2048, seed: 11, state: 'completed',
    source_sha256: 'abcdef0123456789', exported_model: true, checkpoint_number: 1, training_number: 1,
    started_at: '2026-11-10T10:20:00.000Z',
}];
const evaluations = [{
    evaluation_id: 'eval-1', training_run_id: 'run-smoke', state: 'completed',
    requested_episodes: 10, episodes_completed: 10, goals_scored: 1, goal_rate: 0.1, seed: 22,
}];
const environments = [{
    environment_id: 'open-goal-close-v1', name: 'Open Goal — Close', version: '1.0.0', difficulty: 'Introductory',
    purpose: 'Score in a close-range open goal.', scene_path: 'Assets/Football/Scenes/OpenGoalClose.unity',
    policy_contract_id: 'fyp-football-v1', definition_sha256: 'abcdef0123456789',
    settings: [], modifiers: [],
}];

beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_fyp_manifest') return manifest as never;
        if (name === 'football_fyp_preflight') return { ...readyPreflight, editor_open: false, ready_to_train: false } as never;
        if (name === 'football_fyp_runs') return runs as never;
        if (name === 'football_fyp_evaluations') return evaluations as never;
        if (name === 'football_fyp_environments') return environments as never;
        throw new Error('Unexpected tool: ' + name);
    });
});
afterEach(cleanup);

test('FYP opens on Home with Unity status and the three inner destinations', async () => {
    render(<FootballGeneralistExperience />);
    expect(await screen.findByRole('heading', { name: 'Unity closed · idle' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Policy Checkpoints/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Recent Runs/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Environments/ })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Football sections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
});

test('checkpoint, run history, and environment pages use their current layouts', async () => {
    render(<FootballGeneralistExperience />);
    await screen.findByRole('heading', { name: 'Unity closed · idle' });

    fireEvent.click(screen.getByRole('button', { name: /Policy Checkpoints/ }));
    expect(await screen.findByRole('heading', { name: 'Policy Checkpoints' })).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-11-10T10:20:00.000Z"]')).toHaveTextContent(/2026/);
    fireEvent.click(screen.getByRole('button', { name: /Open checkpoint C1/ }));
    expect(await screen.findByRole('heading', { name: /C1/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Training run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /T1Smoke run/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start evaluation' })).toBeDisabled();
    expect(screen.getByLabelText('FYP evaluation episodes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /T1Smoke run/ }));
    expect(await screen.findByRole('heading', { name: /Smoke run/ })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Policy Checkpoints');
    fireEvent.click(screen.getByRole('button', { name: 'C1' }));
    expect(await screen.findByRole('heading', { name: 'Training run' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Recent Runs/ }));
    expect(await screen.findByRole('heading', { name: 'Recent Runs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /T1Smoke run/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Evaluation.*10\/10 episodes/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    fireEvent.click(screen.getByRole('button', { name: /Environments/ }));
    expect(await screen.findByRole('button', { name: /Open Goal — Close/ })).toBeInTheDocument();
});

test('a legacy Control Room URL redirects to Home', async () => {
    const previousHash = window.location.hash;
    window.history.replaceState(null, '', '/#/projects/demo/applications/football-training?fypPage=control-room');
    render(<FootballGeneralistExperience />);
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(window.location.hash).not.toContain('control-room');
    window.history.replaceState(null, '', previousHash || '/');
});

test('starting an evaluation from a checkpoint returns to Home', async () => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_fyp_manifest') return manifest as never;
        if (name === 'football_fyp_preflight') return readyPreflight as never;
        if (name === 'football_fyp_runs') return runs as never;
        if (name === 'football_fyp_evaluations') return evaluations as never;
        if (name === 'football_fyp_evaluate') return { ticket: 'ticket-eval-1', action: 'fyp_evaluate', status: 'accepted' } as never;
        throw new Error('Unexpected tool: ' + name);
    });
    render(<FootballGeneralistExperience />);
    await screen.findByRole('heading', { name: 'Unity open · idle · ready to run' });
    fireEvent.click(screen.getByRole('button', { name: /Policy Checkpoints/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Open checkpoint C1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start evaluation' }));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(await screen.findByText('Evaluation request accepted. Home will show the operation status while Unity connects.')).toBeInTheDocument();
    expect(screen.getByText(/Checkpoint evaluation.*accepted/)).toBeInTheDocument();
    expect(vi.mocked(callTool)).toHaveBeenCalledWith('football_fyp_evaluate', { runId: 'run-smoke', episodes: 10, seed: 515 });
});

test.each([
    { name: 'Unity closed', preflight: { editor_open: false }, expected: 'Unity closed · idle' },
    { name: 'ready to run', preflight: readyPreflight, expected: 'Unity open · idle · ready to run' },
    { name: 'manual Play Mode', preflight: { ...readyPreflight, editor_playing: true, environment_present: true }, expected: 'Manual Play · keyboard controlled' },
])('Unity status clearly reports $name', async ({ preflight, expected }) => {
    vi.mocked(callTool).mockImplementation(async name => {
        if (name === 'football_fyp_manifest') return manifest as never;
        if (name === 'football_fyp_preflight') return preflight as never;
        if (name === 'football_fyp_runs') return [] as never;
        if (name === 'football_fyp_evaluations') return [] as never;
        throw new Error('Unexpected tool: ' + name);
    });
    render(<FootballGeneralistExperience />);
    expect(await screen.findByRole('heading', { name: expected })).toBeInTheDocument();
});
