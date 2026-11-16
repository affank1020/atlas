import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { FypPolicyPage, type FypPolicy } from './FypPolicyPage';
import type { FypEnvironment } from './FypEnvironmentCatalog';

afterEach(cleanup);

const policy: FypPolicy = {
    policy_id: 'football-instruction-v3', display_name: 'Instruction V3', status: 'supported',
    revision: 3, purpose: 'Football curriculum', execution_supported: true,
    contract: {
        contract_id: 'football-observation-v3', behavior_name: 'FootballInstructionV3',
        observations: { size: 93, stacked_vectors: 1, reference_frame: 'local', channels: [] },
        actions: { continuous_count: 8, discrete_branches: [], channels: [] },
    },
    actor: { sharing: 'shared', memory: 'feed_forward', decision_period_physics_steps: 5, network: {} },
    trainer: { algorithm: 'poca', config_path: 'Training/football_instruction_v3.yaml', python_package_version: '1.1.0', settings: {} },
    runtime: { unity_version: '6000.3.6f1', ml_agents_unity_version: '4.1.0', player_build_required: false },
    artifacts: { model_format: 'ONNX', model_filename: 'FootballInstructionV3.onnx', behavior_name: 'FootballInstructionV3', checkpoint_format: 'checkpoint.pt' },
    curriculum: [],
};

test('shows proposed drill meaning and open questions without a scene or version', () => {
    const stage: FypPolicy['curriculum'][number] = {
        stage: 2, stage_label: '1B', status: 'proposed', display_name: 'Open Goal — Varied',
        environment_id: 'open-goal-varied', purpose: 'Score from varied distances and angles.',
        design: {
            learning_objectives: ['Line up a useful shot.'], instructions: 'NONE initially.',
            open_questions: ['Starting distances remain open.'],
        },
    };
    render(<FypPolicyPage policy={{ ...policy, curriculum: [stage] }} />);
    const card = screen.getByRole('article');
    expect(within(card).getByText('Stage 1B · Proposed')).toBeInTheDocument();
    expect(within(card).getByText('Score from varied distances and angles.')).toBeInTheDocument();
    expect(within(card).getByText('Line up a useful shot.')).toBeInTheDocument();
    expect(within(card).getByText('NONE initially.')).toBeInTheDocument();
    expect(within(card).getByText('Starting distances remain open.')).toBeInTheDocument();
    expect(within(card).queryByText(/undefined|current snapshot differs/)).not.toBeInTheDocument();
    expect(within(card).queryByText('Pinned definition SHA-256')).not.toBeInTheDocument();
});

test('preserves existing implemented snapshot details without requiring new plan fields', () => {
    const stage: FypPolicy['curriculum'][number] = {
        stage: 1, environment_id: 'open-goal-close', environment_version: '1.0.0',
        scene_path: 'Assets/Football/Scenes/OpenGoalClose.unity', definition_sha256: 'a'.repeat(64),
        purpose: 'Close-range scoring.',
    };
    const environment: FypEnvironment = {
        environment_id: stage.environment_id, name: 'Open Goal — Close', version: '1.0.0',
        difficulty: 'Introductory', purpose: stage.purpose, scene_path: stage.scene_path!,
        definition_sha256: stage.definition_sha256!, modifiers: [],
        settings: [{ key: 'goalReward', component: 'FootballEnvironment', category: 'Rewards', label: 'Goal reward', value: '1', unit: '' }],
    };
    render(<FypPolicyPage policy={{ ...policy, curriculum: [stage] }} environments={[environment]} />);
    expect(screen.getByText('Stage 1 · Plan v1.0.0 · Unity v1.0.0 · matched')).toBeInTheDocument();
    expect(screen.getByText(stage.scene_path!)).toBeInTheDocument();
    expect(screen.getByText(stage.definition_sha256!)).toBeInTheDocument();
    expect(screen.getByText('Goal reward')).toBeInTheDocument();
    expect(screen.queryByText(/Draft drill concept/)).not.toBeInTheDocument();
});
