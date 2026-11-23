import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { callTool } from './api';
import { FootballGeneralistExperience } from './FootballGeneralistExperience';

vi.mock('./api', () => ({ callTool: vi.fn(), onToolMutation: () => () => {} }));

const policy = {
    policy_id: 'football-v1', display_name: 'FYP Football v1', status: 'supported', revision: 1,
    purpose: 'Solo open-goal football.', execution_supported: true,
    contract: {
        contract_id: 'fyp-football-v1', behavior_name: 'FootballV1',
        observations: {
            size: 25, stacked_vectors: 1, reference_frame: 'player-local',
            entity_capacity: { teammates_max: 1, opponents_max: 0 },
            channels: [{ name: 'ball_relative_position', start: 0, size: 3, components: ['x', 'y', 'z'], encoding: 'relative position' }],
        },
        actions: {
            continuous_count: 8, discrete_branches: [],
            channels: Array.from({ length: 8 }, (_, index) => ({ name: `action_${index}`, index, range: [-1, 1], meaning: 'test action' })),
        },
    },
    actor: { sharing: 'shared', memory: 'feed_forward', decision_period_physics_steps: 5, network: { normalize: false, hidden_units: 128, layers: 2 } },
    trainer: { algorithm: 'poca', config_path: 'Training/football_v1.yaml', python_package_version: '1.1.0', settings: {} },
    runtime: { unity_version: '6000.3.6f1', ml_agents_unity_version: '4.1.0', player_build_required: false },
    artifacts: { model_format: 'ONNX', model_filename: 'FootballV1.onnx', behavior_name: 'FootballV1', checkpoint_format: 'trainer checkpoint' },
    curriculum: [{ stage: 1, environment_id: 'open-goal-close', environment_version: '1.0.0', scene_path: 'Assets/Football/Scenes/OpenGoalClose.unity', purpose: 'Solo scoring.' }],
};
const successorPolicy = {
    ...policy,
    policy_id: 'football-v2', display_name: 'FYP Football v2 · cooperative',
    purpose: 'Cooperative football with explicit opponent observations.',
    notes: 'Policy successor to Football v1. Adds opponent presence, relative position and velocity observations.',
    contract: {
        ...policy.contract, contract_id: 'fyp-football-v2', behavior_name: 'FootballV2',
        observations: {
            ...policy.contract.observations, size: 30,
            entity_capacity: { teammates_max: 1, opponents_max: 1, slot_ordering: 'first teammate; nearest opponent' },
            channels: [...policy.contract.observations.channels,
                { name: 'opponent_present', start: 25, size: 1, components: ['present'], encoding: 'boolean' },
                { name: 'opponent_relative_position', start: 26, size: 2, components: ['x', 'z'], encoding: 'relative position' },
                { name: 'opponent_velocity', start: 28, size: 2, components: ['x', 'z'], encoding: 'relative velocity' }],
        },
    },
    trainer: { ...policy.trainer, config_path: 'Training/football_v2.yaml' },
    artifacts: { ...policy.artifacts, model_filename: 'FootballV2.onnx', behavior_name: 'FootballV2' },
    curriculum: [{ stage: 1, environment_id: 'cooperative-scrimmage', environment_version: '1.0.0', definition_sha256: 'a83e1c6f4b920d75e2a6f3108c4d7b591f06a3e8c2d47b915a6f0c3e8d214759', scene_path: 'Assets/Football/Scenes/CooperativeScrimmage.unity', purpose: 'Cooperative scrimmage.' }],
};
const policies = [policy, successorPolicy];
const manifest = {
    available: true, policy, policies, execution_supported: true,
    contract: {
        contract_id: 'fyp-football-v1', behavior: 'FootballV1',
        observations: { size: 25 }, actions: { continuous: 8 }, trainer_kind: 'poca',
        scene: 'Assets/Football/Scenes/OpenGoalClose.unity',
    },
};
function policyToolResult(name: string, input: Record<string, unknown> = {}) {
    if (name === 'football_fyp_policies') return policies;
    if (name !== 'football_fyp_manifest') return undefined;
    const selected = input.policyId === 'football-v2' ? successorPolicy : policy;
    return {
        ...manifest, policy: selected, execution_supported: selected.execution_supported,
        contract: {
            contract_id: selected.contract.contract_id, behavior: selected.contract.behavior_name,
            observations: { size: selected.contract.observations.size },
            actions: { continuous: selected.contract.actions.continuous_count },
            trainer_kind: selected.trainer.algorithm, scene: selected.curriculum[0].scene_path,
        },
    };
}
const readyPreflight = {
    editor_available: true, editor_open: true, editor_playing: false, editor_compiling: false,
    trainer_connected: false, trainer_available: true, scene_ready: true,
    active_scene: 'Assets/Football/Scenes/OpenGoalClose.unity', environment_present: false,
    episode: null, goals: null, last_outcome: null, episodes_completed: null, recent_episodes: [],
    heartbeat_age_seconds: 1, verified_build: false, ready_to_train: true, policy_supported: true,
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
    environment_id: 'open-goal-close', name: 'Open Goal — Close', version: '1.0.0', difficulty: 'Introductory',
    purpose: 'Score in a close-range open goal.', scene_path: 'Assets/Football/Scenes/OpenGoalClose.unity',
    definition_sha256: 'abcdef0123456789',
    settings: [], modifiers: [],
}];

function historyToolResult(name: string, input: Record<string, unknown> = {}) {
    switch (name) {
        case 'football_fyp_live': return { training: null, evaluation: null, busy: false };
        case 'football_fyp_overview': return { runs: 1, checkpoints: 1, evaluations: 1 };
        case 'football_fyp_run_detail': return runs[0];
        case 'football_fyp_evaluation_detail': return evaluations[0];
        case 'football_fyp_run_chart': return { steps_completed: 2048, training_metrics: [] };
        case 'football_fyp_episode_page': return { items: [], page_cursor: null, next_cursor: null };
        case 'football_fyp_history': {
            const items = input.historyView === 'checkpoints' ? runs : input.historyView === 'evaluations' ? evaluations : [...runs, ...evaluations];
            return { items, page_cursor: 'first', next_cursor: null };
        }
    }
}

beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        const policyResult = policyToolResult(name, input);
        if (policyResult !== undefined) return policyResult as never;
        if (name === 'football_fyp_preflight') return { ...readyPreflight, editor_open: false, ready_to_train: false } as never;
        const historyResult = historyToolResult(name, input);
        if (historyResult !== undefined) return historyResult as never;
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
    const checkpoint = await screen.findByRole('button', { name: /Open checkpoint C1/ });
    expect(checkpoint.querySelector('time[datetime="2026-11-10T10:20:00.000Z"]')).toHaveTextContent(/2026/);
    fireEvent.click(checkpoint);
    expect(await screen.findByRole('heading', { name: /C1/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Training run' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /T1Smoke run/ })).toBeInTheDocument();
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
    expect(await screen.findByRole('button', { name: /T1Smoke run/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Evaluation.*10\/10 episodes/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    fireEvent.click(screen.getByRole('button', { name: /Environments/ }));
    expect(await screen.findByRole('button', { name: /Open Goal — Close/ })).toBeInTheDocument();
});

test('recent history keeps its first page cursor and opens a receipt from the next page by ID', async () => {
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        if (name === 'football_fyp_history') return (input?.cursor === 'older'
            ? { items: evaluations, page_cursor: 'older', next_cursor: null }
            : { items: runs, page_cursor: 'first', next_cursor: 'older' }) as never;
        const result = policyToolResult(name, input) ?? historyToolResult(name, input);
        if (result !== undefined) return result as never;
        if (name === 'football_fyp_preflight') return readyPreflight as never;
        throw new Error('Unexpected tool: ' + name);
    });
    render(<FootballGeneralistExperience />);
    fireEvent.click(await screen.findByRole('button', { name: /Recent Runs/ }));
    const pager = await screen.findByRole('navigation', { name: 'Recent runs pagination' });
    expect(within(pager).getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(within(pager).getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('button', { name: /Evaluation.*10\/10 episodes/ })).toBeInTheDocument();
    expect(within(pager).getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(within(pager).getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('button', { name: /T1Smoke run/ })).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('football_fyp_history', expect.objectContaining({ cursor: 'first' }), expect.any(AbortSignal));
    fireEvent.click(within(pager).getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: /Evaluation.*10\/10 episodes/ }));
    expect(await screen.findByRole('region', { name: 'Evaluation details' })).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledWith('football_fyp_evaluation_detail', { policyId: 'football-v1', evaluationId: 'eval-1' }, expect.any(AbortSignal));
});

test('a history count error leaves the Unity status visible', async () => {
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        if (name === 'football_fyp_overview') throw new Error('History unavailable');
        if (name === 'football_fyp_preflight') return readyPreflight as never;
        const result = policyToolResult(name, input) ?? historyToolResult(name, input);
        if (result !== undefined) return result as never;
        throw new Error('Unexpected tool: ' + name);
    });
    render(<FootballGeneralistExperience />);
    expect(await screen.findByRole('heading', { name: 'Unity open · idle · ready to run' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Recent Runs.*Counts unavailable/ })).toBeInTheDocument();
    expect(screen.queryByText('Unity status unavailable')).not.toBeInTheDocument();
});

test('a legacy Control Room URL redirects to Home', async () => {
    const previousHash = window.location.hash;
    window.history.replaceState(null, '', '/#/projects/demo/applications/football-training?fypPage=control-room');
    render(<FootballGeneralistExperience />);
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(window.location.hash).not.toContain('control-room');
    window.history.replaceState(null, '', previousHash || '/');
});

test('settings switches policy and shows one Settings breadcrumb with no redundant selector copy', async () => {
    render(<FootballGeneralistExperience />);
    await screen.findByRole('heading', { name: 'Unity closed · idle' });
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getAllByText('Settings')).toHaveLength(1);
    expect(screen.queryByText('Choose which policy Atlas uses for this FYP workspace. Your choice is saved for future visits.')).not.toBeInTheDocument();
    expect(screen.queryByText('Policy', { exact: true })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Selected FYP policy' }), { target: { value: 'football-v2' } });
    expect(await screen.findByText('Cooperative football with explicit opponent observations.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View policy plan →' }));
    expect(await screen.findByRole('heading', { name: 'FYP Football v2 · cooperative' })).toBeInTheDocument();
    expect(screen.getByText('30 vector values · 1 stack')).toBeInTheDocument();
    expect(screen.getByText('Opponent Present')).toBeInTheDocument();
    expect(screen.getByText(successorPolicy.notes)).toBeInTheDocument();
    expect(screen.getByText('Reference frame: player-local')).toBeInTheDocument();
    expect(screen.getByText('a83e1c6f4b920d75e2a6f3108c4d7b591f06a3e8c2d47b915a6f0c3e8d214759')).toBeInTheDocument();
});

test('starting an evaluation from a checkpoint returns to Home', async () => {
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        const policyResult = policyToolResult(name, input);
        if (policyResult !== undefined) return policyResult as never;
        if (name === 'football_fyp_preflight') return readyPreflight as never;
        if (name === 'football_fyp_environments') return environments as never;
        const historyResult = historyToolResult(name, input);
        if (historyResult !== undefined) return historyResult as never;
        if (name === 'football_fyp_evaluate') return { ticket: 'ticket-eval-1', action: 'fyp_evaluate', status: 'accepted' } as never;
        if (name === 'football_fyp_task_status') return { ticket: 'ticket-eval-1', action: 'fyp_evaluate', status: 'accepted' } as never;
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
    expect(vi.mocked(callTool)).toHaveBeenCalledWith('football_fyp_evaluate', {
        policyId: 'football-v1', runId: 'run-smoke', environmentId: 'open-goal-close',
        episodes: 10, seed: 515, timeScale: 1,
    });
});

test.each([
    { name: 'Unity closed', preflight: { editor_open: false }, expected: 'Unity closed · idle' },
    { name: 'ready to run', preflight: readyPreflight, expected: 'Unity open · idle · ready to run' },
    { name: 'manual Play Mode', preflight: { ...readyPreflight, editor_playing: true, environment_present: true }, expected: 'Manual Play · keyboard controlled' },
])('Unity status clearly reports $name', async ({ preflight, expected }) => {
    vi.mocked(callTool).mockImplementation(async (name, input) => {
        const policyResult = policyToolResult(name, input);
        if (policyResult !== undefined) return policyResult as never;
        if (name === 'football_fyp_preflight') return preflight as never;
        const historyResult = historyToolResult(name, input);
        if (historyResult !== undefined) return historyResult as never;
        throw new Error('Unexpected tool: ' + name);
    });
    render(<FootballGeneralistExperience />);
    expect(await screen.findByRole('heading', { name: expected })).toBeInTheDocument();
});
