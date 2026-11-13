import type { AtlasRecord, AtlasStatus, AuditEvent, Page, Project, Store } from './types';
import type { AtlasNode } from './Nodes';
import { mockCodeReviewTool } from './mockCodeReviews';

/**
 * Deterministic read-only fixture backend. No network, credentials, or database.
 * IDs and content are deliberately synthetic and must never be presented as live.
 */
const stamp = '2026-10-19T14:00:00.000Z';
const uuid = (group: number, item = 1) => '00000000-0000-4000-8000-' + String(group).padStart(4, '0') + String(item).padStart(8, '0');
const project = (id: number, name: string, description: string): Project =>
    ({ id: uuid(1, id), name, description, createdAt: stamp, updatedAt: stamp });

export const mockProjects: Project[] = [
    project(1, 'Atlas Demo', 'Sample control plane, development workspaces and infrastructure.'),
    project(2, 'Portfolio Demo', 'Sample portfolio content and publishing workflows.'),
    project(3, 'Football Research Demo', 'Example football simulation and experiment data.'),
    project(4, 'University Demo', 'Example module notes and study progress.'),
];

const field = (name: string, type: 'string' | 'number' | 'boolean' = 'string') => ({ name, type });
const store = (projectIndex: number, storeIndex: number, name: string, description: string, fields: ReturnType<typeof field>[]): Store => ({
    id: uuid(2 + projectIndex, storeIndex),
    projectId: mockProjects[projectIndex].id,
    name, description, schema: { version: 1, fields }, createdAt: stamp, updatedAt: stamp,
});
const stores: Store[] = [
    store(0, 1, 'Infrastructure', 'Example machines and services', [field('name'), field('environment'), field('healthy', 'boolean')]),
    store(0, 2, 'Deployments', 'Illustrative release history', [field('service'), field('version'), field('durationSeconds', 'number')]),
    store(1, 1, 'Projects', 'Example portfolio items', [field('title'), field('category'), field('featured', 'boolean')]),
    store(2, 1, 'Experiments', 'Example model evaluations', [field('name'), field('successRate', 'number'), field('episodes', 'number')]),
    store(3, 1, 'Modules', 'Example university learning records', [field('code'), field('topic'), field('complete', 'boolean')]),
];
const data: Record<string, unknown>[][] = [
    [{ name: 'Demo Linux VPS', environment: 'Production-like', healthy: true }, { name: 'Demo MacBook', environment: 'Development', healthy: true }],
    [{ service: 'Atlas web', version: '2.0.0-demo', durationSeconds: 42 }],
    [{ title: 'Atlas', category: 'AI agent tooling', featured: true }, { title: 'EcoPrompt', category: 'Full stack', featured: false }],
    [{ name: 'Dribbling baseline', successRate: 0.78, episodes: 100 }, { name: 'Moving-ball contact', successRate: 0.63, episodes: 100 }],
    [{ code: 'MATH37011', topic: 'Markov chains', complete: true }, { code: 'COMP34111', topic: 'Game-playing agents', complete: false }],
];
const records: AtlasRecord[] = stores.flatMap((entry, storeIndex) =>
    data[storeIndex].map((value, index) => ({ id: uuid(10 + storeIndex, index + 1), projectId: entry.projectId, storeId: entry.id, data: value as Record<string, unknown>, createdAt: stamp, updatedAt: stamp }))
);
const nodeMac = uuid(20, 1);
const nodeLinux = uuid(20, 2);
const nodeAndroidTablet = uuid(20, 3);
const nodeAndroidPhone = uuid(20, 4);
// All checkout paths and repository names are synthetic. Model many physical
// checkouts per repository so the local Workspaces UI exercises its real layout.
const demoCheckout = (index: number, nodeId: string, name: string, rootPath: string,
    projectId: string | null, kind: 'generic' | 'unity' = 'generic') => ({
    id: uuid(21, index), nodeId, projectId, name, rootPath, kind,
    adapter: kind === 'unity' ? 'unity' : null, status: 'active' as const,
});
const workspaces = [
    demoCheckout(1, nodeMac, 'Atlas main', '/demo/mac/atlas', mockProjects[0].id),
    demoCheckout(2, nodeMac, 'Football Research', '/demo/mac/football', mockProjects[2].id, 'unity'),
    demoCheckout(3, nodeLinux, 'Linux Development Root', '/srv/demo/workspaces', null),
    demoCheckout(4, nodeMac, 'Workspace UI redesign', '/demo/mac/worktrees/workspace-ui', mockProjects[0].id),
    demoCheckout(5, nodeMac, 'Code Review integration', '/demo/mac/worktrees/code-reviews', mockProjects[0].id),
    demoCheckout(6, nodeMac, 'Monitoring cleanup', '/demo/mac/worktrees/monitoring', mockProjects[0].id),
    demoCheckout(7, nodeLinux, 'Node release tooling', '/srv/demo/workspaces/node-releases', mockProjects[0].id),
    demoCheckout(8, nodeLinux, 'Server observability', '/srv/demo/workspaces/observability', mockProjects[0].id),
    demoCheckout(9, nodeMac, 'Search improvements', '/demo/mac/worktrees/search', mockProjects[0].id),
    demoCheckout(10, nodeMac, 'Portfolio main', '/demo/mac/portfolio', mockProjects[1].id),
    demoCheckout(11, nodeLinux, 'Portfolio VPS checkout', '/srv/demo/workspaces/portfolio', mockProjects[1].id),
    demoCheckout(12, nodeLinux, 'Benchmark main', '/srv/demo/workspaces/benchmark', mockProjects[0].id),
    demoCheckout(13, nodeMac, 'Benchmark dashboard', '/demo/mac/benchmark-dashboard', mockProjects[0].id),
    demoCheckout(14, nodeMac, 'Relay gateway', '/demo/mac/relay', mockProjects[0].id),
    demoCheckout(15, nodeMac, 'ChatFlow extension', '/demo/mac/chatflow', mockProjects[0].id),
    demoCheckout(16, nodeMac, 'EcoPrompt', '/demo/mac/ecoprompt', mockProjects[0].id),
    demoCheckout(17, nodeMac, 'Mac Development Root', '/demo/mac/projects', null),
    demoCheckout(18, nodeMac, 'Node package updates', '/demo/mac/worktrees/node-updates', mockProjects[0].id),
    demoCheckout(19, nodeMac, 'Research notes', '/demo/mac/notes', null),
];
// Keep the logical/physical relationship consistent with the hosted API.
// Local directories use their physical checkout ID as their logical ID.
const demoGroup = (index: number, name: string, repository: string | null, indices: number[]) => {
    const checkouts = indices.map(n => {
        const checkout = workspaces.find(workspace => workspace.id === uuid(21, n));
        if (!checkout) throw new Error('Missing demo checkout ' + n);
        return checkout;
    });
    return {
        id: repository ? uuid(22, index) : checkouts[0].id, name, repository,
        kind: repository ? 'git' as const : 'local' as const,
        projectIds: [...new Set(checkouts.map(checkout => checkout.projectId).filter((id): id is string => !!id))],
        checkouts,
    };
};
const logicalWorkspaces = [
    demoGroup(1, 'Atlas', 'example/atlas-demo', [1, 4, 5, 6, 7, 8, 9, 18]),
    demoGroup(2, 'Portfolio Site', 'example/portfolio-demo', [10, 11]),
    demoGroup(3, 'Benchmark', 'example/benchmark-demo', [12, 13]),
    demoGroup(4, 'Relay', 'example/relay-demo', [14]),
    demoGroup(5, 'ChatFlow', 'example/chatflow-demo', [15]),
    demoGroup(6, 'EcoPrompt', 'example/ecoprompt-demo', [16]),
    demoGroup(7, 'Football Research', null, [2]),
    demoGroup(8, 'Linux Development Root', null, [3]),
    demoGroup(9, 'Mac Development Root', null, [17]),
    demoGroup(10, 'Research notes', null, [19]),
];
const nodes: AtlasNode[] = [
    { id: nodeMac, name: 'Demo MacBook', status: 'online', platform: 'darwin', version: '2.0.0-demo', credentialState: 'active', capabilities: ['workspace.files', 'workspace.git', 'workspace.dev', 'unity'], lastSeen: stamp, hostedWorkspaceCount: workspaces.filter(w => w.nodeId === nodeMac).length },
    // Deliberately disconnected in local mock mode to preview offline Node states.
    { id: nodeLinux, name: 'Demo Linux VPS', status: 'offline', platform: 'linux', version: '2.0.0-demo', credentialState: 'active', capabilities: ['workspace.files', 'workspace.git'], lastSeen: stamp, hostedWorkspaceCount: workspaces.filter(w => w.nodeId === nodeLinux).length },
    // Android fixtures preview future mobile nodes; they are not enrolled runtimes.
    { id: nodeAndroidTablet, name: 'Demo Android Tablet', status: 'online', platform: 'android', deviceType: 'tablet', version: '2.0.0-demo', credentialState: 'active', capabilities: ['workspace.files'], lastSeen: stamp, hostedWorkspaceCount: 0 },
    { id: nodeAndroidPhone, name: 'Demo Android Phone', status: 'offline', platform: 'android', deviceType: 'phone', version: '2.0.0-demo', credentialState: 'active', capabilities: ['workspace.files'], lastSeen: stamp, hostedWorkspaceCount: 0 },
];
const activity: AuditEvent[] = [
    { id: uuid(30, 1), occurredAt: stamp, client: 'demo', operation: 'workspace.git_status', projectId: mockProjects[0].id, workspaceId: workspaces[0].id, resulting: { branch: 'demo/main' } },
    { id: uuid(30, 2), occurredAt: stamp, client: 'demo', operation: 'record.created', projectId: mockProjects[3].id, storeId: stores[4].id, recordId: records[records.length - 1].id },
    { id: uuid(30, 3), occurredAt: stamp, client: 'demo', operation: 'project.created', projectId: mockProjects[1].id },
];
const portfolioTypes = ['profile', 'contact', 'projects', 'experience', 'posts', 'collections'] as const;
const portfolioFields: Record<string, ReturnType<typeof field>[]> = {
    profile: [field('firstName'), field('lastName'), field('description')],
    contact: [field('email'), field('label')],
    projects: [field('title'), field('description'), field('category')],
    experience: [field('company'), field('role'), field('description')],
    posts: [field('title'), field('excerpt'), field('body')],
    collections: [field('title'), field('description')],
};
const portfolioEntries = [
    { id: uuid(40, 1), contentType: 'projects', storeId: uuid(41, 1), data: { title: 'Atlas Demo', description: 'A sample infrastructure project, not real portfolio content.', category: 'AI tooling' }, status: 'published', createdAt: stamp, updatedAt: stamp, publishedAt: stamp },
    { id: uuid(40, 2), contentType: 'projects', storeId: uuid(41, 1), data: { title: 'EcoPrompt Demo', description: 'Example browser extension entry.', category: 'Full stack' }, status: 'draft', createdAt: stamp, updatedAt: stamp },
    { id: uuid(40, 3), contentType: 'experience', storeId: uuid(41, 4), data: { company: 'Example Studio', role: 'Software Engineer', description: 'Illustrative placement entry.' }, status: 'published', createdAt: stamp, updatedAt: stamp, publishedAt: stamp },
];
const applications = [
    { type: 'portfolio', slug: 'portfolio', name: 'Portfolio', description: 'Browse sample portfolio records in read-only preview.', projectId: mockProjects[1].id },
    { type: 'football-training', slug: 'football-training', name: 'Football Training', description: 'Explore sample training runs and policies.', projectId: mockProjects[2].id },
    { type: 'code-reviews', slug: 'code-reviews', name: 'Code Reviews', description: 'Explore simulated review rounds, findings and PR timelines. Local demo data only.', projectId: mockProjects[0].id },
];
const fypSourceHash = '6b1d97e80a4c6325f09e3a71b8c52640d3e9f14a72c85b6019e4d3a7f2c81650';
const fypModelHash = '4c7a2f9180de5631b4c8a6079e2d51f3a8604c7d1e9b3256f08a4d2c7b915e63';
const fypCheckpointHash = 'a83e1c6f4b920d75e2a6f3108c4d7b591f06a3e8c2d47b915a6f0c3e8d214759';
const fypPlayerSettings = {
    forwardSpeed: 5, sidewaysSpeed: 3, backwardsSpeed: 2, acceleration: 16, braking: 22,
    turnSpeed: 450, desiredFacingSpeed: 720, contactTolerance: 0.12, backwardKickMultiplier: 0.6,
    gentleImpulse: 0.35, kickImpulse: 4, touchCooldown: 0.18, keyboardControl: true,
};
const fypPlayerSettingsHash = 'd338f993e6bfd16d2f2ca8e34f655590e9328031952bd3ff9ce4966832ed6b84';
const fypPolicy = {
    record_schema_version: 1, policy_id: 'football-v1', display_name: 'FYP Football v1', status: 'supported', revision: 1,
    purpose: 'Solo open-goal football with a fixed policy interface that reserves one teammate slot.', execution_supported: true,
    contract: {
        contract_id: 'fyp-football-v1', behavior_name: 'FootballV1',
        observations: { kind: 'vector', size: 25, stacked_vectors: 1, reference_frame: 'player-local; horizontal axes are local X/Z',
            entity_capacity: { teammates_max: 1, opponents_max: 0, slot_ordering: 'first active teammate in teamAgents' },
            channels: [
                { name: 'ball_relative_position', start: 0, size: 3, components: ['x', 'y', 'z'], encoding: 'Relative position divided by 20', frame: 'player-local', scale_divisor: 20 },
                { name: 'ball_velocity', start: 3, size: 3, components: ['x', 'y', 'z'], encoding: 'Relative velocity divided by 10', frame: 'player-local', scale_divisor: 10 },
                { name: 'player_velocity', start: 6, size: 2, components: ['x', 'z'], encoding: 'Horizontal velocity divided by 5', frame: 'player-local', scale_divisor: 5 },
                { name: 'goal_relative_position', start: 8, size: 2, components: ['x', 'z'], encoding: 'Relative goal position divided by 20', frame: 'player-local', scale_divisor: 20, missing_value: 0 },
                { name: 'remaining_time_fraction', start: 10, size: 1, components: ['fraction'], encoding: 'One minus elapsed fraction, clamped' },
                { name: 'can_touch_ball', start: 11, size: 1, components: ['available'], encoding: 'Boolean as 0 or 1' },
                { name: 'teammate_present', start: 12, size: 1, components: ['present'], encoding: 'Boolean as 0 or 1' },
                { name: 'teammate_relative_position', start: 13, size: 2, components: ['x', 'z'], encoding: 'Relative position divided by 20', frame: 'player-local', scale_divisor: 20, missing_value: 0 },
                { name: 'teammate_velocity', start: 15, size: 2, components: ['x', 'z'], encoding: 'Velocity divided by 5', frame: 'player-local', scale_divisor: 5, missing_value: 0 },
                { name: 'proximity_rays', start: 17, size: 8, components: ['forward', '45deg', '90deg', '135deg', '180deg', '225deg', '270deg', '315deg'], encoding: 'One minus nearest distance divided by 18', frame: 'player-facing horizontal', details: { range: 18 } },
            ],
        },
        actions: { continuous_count: 8, discrete_branches: [], channels: [
            { name: 'strafe', index: 0, range: [-1, 1], meaning: 'Local sideways movement' },
            { name: 'forward_back', index: 1, range: [-1, 1], meaning: 'Local forward/back movement' },
            { name: 'desired_facing_x', index: 2, range: [-1, 1], meaning: 'Local X desired facing' },
            { name: 'desired_facing_z', index: 3, range: [-1, 1], meaning: 'Local Z desired facing' },
            { name: 'touch_direction_x', index: 4, range: [-1, 1], meaning: 'Local X touch direction' },
            { name: 'touch_direction_z', index: 5, range: [-1, 1], meaning: 'Local Z touch direction' },
            { name: 'touch_power', index: 6, range: [-1, 1], meaning: 'Mapped to power fraction (value + 1) / 2' },
            { name: 'touch_trigger', index: 7, range: [-1, 1], meaning: 'Request touch when value exceeds 0.5' },
        ] },
    },
    actor: { sharing: 'shared', memory: 'feed_forward', decision_period_physics_steps: 5, network: { normalize: false, hidden_units: 128, layers: 2 } },
    trainer: { algorithm: 'poca', config_path: 'Training/football_v1.yaml', python_package_version: '1.1.0', settings: {
        batch_size: 1024, buffer_size: 10240, learning_rate: 0.0003, beta: 0.005, epsilon: 0.2,
        lambda: 0.95, num_epoch: 3, learning_rate_schedule: 'linear', extrinsic_gamma: 0.99,
        extrinsic_strength: 1, keep_checkpoints: 5, checkpoint_interval: 50000, max_steps: 500000,
        time_horizon: 64, summary_freq: 5000,
    } },
    runtime: { unity_version: '6000.3.6f1', ml_agents_unity_version: '4.1.0', player_build_required: false, build_requirements: [] },
    artifacts: { model_format: 'ONNX', model_filename: 'FootballV1.onnx', behavior_name: 'FootballV1',
        checkpoint_format: 'ML-Agents trainer checkpoint.pt',
        notes: 'Weights are specific to each training run; Atlas records model and checkpoint hashes in run receipts. Network dimensions describe architecture, not a fixed weight file size.' },
    curriculum: [{ stage: 1, environment_id: 'open-goal-close', environment_version: '1.0.0',
        definition_sha256: '5a286a2bc03108d012f3e91829977b3a972ea60efbe26a223db17852907e5d75',
        scene_path: 'Assets/Football/Scenes/OpenGoalClose.unity', purpose: 'Solo open-goal scoring in the primary training scene.' }],
    player_settings: { source_prefab: 'Assets/Football/Prefabs/Player.prefab', settings: fypPlayerSettings, snapshot_sha256: fypPlayerSettingsHash },
    notes: 'The teammate slot is selected by teamAgents order. This record documents the existing policy and does not imply compatibility with an expanded contract.',
};
const fypCooperativePolicy = {
    ...fypPolicy,
    policy_id: 'football-v2',
    display_name: 'FYP Football v2 · cooperative',
    status: 'supported' as const,
    revision: 1,
    purpose: 'Cooperative two-player football with the Football v1 action interface and an explicit nearest-opponent observation slot.',
    execution_supported: true,
    contract: {
        ...fypPolicy.contract,
        contract_id: 'fyp-football-v2',
        behavior_name: 'FootballV2',
        observations: {
            ...fypPolicy.contract.observations,
            size: 30,
            entity_capacity: { teammates_max: 1, opponents_max: 1, slot_ordering: 'first active teammate; nearest active opponent' },
            channels: [
                ...fypPolicy.contract.observations.channels,
                { name: 'opponent_present', start: 25, size: 1, components: ['present'], encoding: 'Boolean as 0 or 1' },
                { name: 'opponent_relative_position', start: 26, size: 2, components: ['x', 'z'], encoding: 'Nearest opponent position divided by 20', frame: 'player-local', scale_divisor: 20, missing_value: 0 },
                { name: 'opponent_velocity', start: 28, size: 2, components: ['x', 'z'], encoding: 'Nearest opponent velocity divided by 5', frame: 'player-local', scale_divisor: 5, missing_value: 0 },
            ],
        },
    },
    trainer: { ...fypPolicy.trainer, config_path: 'Training/football_v2.yaml' },
    artifacts: {
        ...fypPolicy.artifacts,
        model_filename: 'FootballV2.onnx',
        behavior_name: 'FootballV2',
        notes: 'This successor has its own model weights and checkpoint history, separate from Football v1.',
    },
    curriculum: [
        { stage: 1, environment_id: 'cooperative-scrimmage', environment_version: '1.0.0',
            definition_sha256: fypCheckpointHash,
            scene_path: 'Assets/Football/Scenes/CooperativeScrimmage.unity',
            purpose: 'Build passing and support habits in a two-player attack against one opponent.' },
        { stage: 2, environment_id: 'cooperative-build-up', environment_version: '1.0.0',
            definition_sha256: 'b'.repeat(64),
            scene_path: 'Assets/Football/Scenes/CooperativeBuildUp.unity',
            purpose: 'Move the ball through a wider field while keeping a passing option available.' },
        { stage: 3, environment_id: 'cooperative-high-pressure', environment_version: '1.0.0',
            definition_sha256: 'c'.repeat(64),
            scene_path: 'Assets/Football/Scenes/CooperativeHighPressure.unity',
            purpose: 'Create a scoring chance with two defenders closing down the space.' },
    ],
    notes: 'Policy successor to Football v1. Adds opponent presence, relative position and velocity observations for cooperative play. Its run, evaluation and checkpoint history is separate from v1.',
};
const fypPolicies = [fypPolicy, fypCooperativePolicy];
const fypEnvironment = {
    environment_id: 'open-goal-close', name: 'Open Goal — Close', version: '1.0.0', difficulty: '1 — introductory',
    purpose: 'Score in a close-range open goal using the shared FootballV1 policy.',
    scene_path: 'Assets/Football/Scenes/OpenGoalClose.unity',
    definition_sha256: '5a286a2bc03108d012f3e91829977b3a972ea60efbe26a223db17852907e5d75', snapshot_recorded: true,
    player_settings_sha256: fypPlayerSettingsHash,
    player_settings: [
        { key: 'FootballPlayer.forwardSpeed', component: 'FootballPlayer', category: 'Player', label: 'Forward Speed', value: '5', unit: 'm/s' },
        { key: 'FootballPlayer.sidewaysSpeed', component: 'FootballPlayer', category: 'Player', label: 'Sideways Speed', value: '3', unit: 'm/s' },
        { key: 'FootballPlayer.backwardsSpeed', component: 'FootballPlayer', category: 'Player', label: 'Backwards Speed', value: '2', unit: 'm/s' },
        { key: 'FootballPlayer.acceleration', component: 'FootballPlayer', category: 'Player', label: 'Acceleration', value: '16', unit: 'm/s²' },
        { key: 'FootballPlayer.braking', component: 'FootballPlayer', category: 'Player', label: 'Braking', value: '22', unit: 'm/s²' },
        { key: 'FootballPlayer.turnSpeed', component: 'FootballPlayer', category: 'Player', label: 'Turn Speed', value: '450', unit: 'degrees/s' },
        { key: 'FootballPlayer.desiredFacingSpeed', component: 'FootballPlayer', category: 'Player', label: 'Desired Facing Speed', value: '720', unit: 'degrees/s' },
        { key: 'FootballPlayer.contactTolerance', component: 'FootballPlayer', category: 'Player', label: 'Contact Tolerance', value: '0.12', unit: 'm' },
        { key: 'FootballPlayer.backwardKickMultiplier', component: 'FootballPlayer', category: 'Player', label: 'Backward Kick Multiplier', value: '0.6', unit: '' },
        { key: 'FootballPlayer.gentleImpulse', component: 'FootballPlayer', category: 'Player', label: 'Gentle Impulse', value: '0.35', unit: 'N·s' },
        { key: 'FootballPlayer.kickImpulse', component: 'FootballPlayer', category: 'Player', label: 'Kick Impulse', value: '4', unit: 'N·s' },
        { key: 'FootballPlayer.touchCooldown', component: 'FootballPlayer', category: 'Player', label: 'Touch Cooldown', value: '0.18', unit: 's' },
        { key: 'FootballPlayer.keyboardControl', component: 'FootballPlayer', category: 'Player', label: 'Keyboard Control', value: 'True', unit: '' },
    ],
    settings: [
        { key: 'SpawnRegion.size', component: 'SpawnRegion', category: 'Starting setup', label: 'Randomized spawn area', value: '(0, 0)', unit: 'm' },
        { key: 'SpawnRegion.yawVariation', component: 'SpawnRegion', category: 'Starting setup', label: 'Yaw variation', value: '0', unit: 'degrees' },
        { key: 'FootballEnvironment.ballStart', component: 'FootballEnvironment', category: 'Starting setup', label: 'Ball spawn', value: '(0, 0.230000004, 8.60000038)', unit: '' },
        { key: 'FootballEnvironment.goal', component: 'FootballEnvironment', category: 'Goal', label: 'Goal object', value: '(0, 0, 13)', unit: '' },
        { key: 'FootballEnvironment.goalReward', component: 'FootballEnvironment', category: 'Rewards', label: 'Goal reward', value: '1', unit: '' },
        { key: 'FootballEnvironment.initialBallVelocity', component: 'FootballEnvironment', category: 'Starting setup', label: 'Initial ball velocity', value: '(0, 0, 0)', unit: 'm/s' },
        { key: 'FootballEnvironment.playableHalfExtents', component: 'FootballEnvironment', category: 'Episode', label: 'Playable half extents', value: '(9.5, 15)', unit: 'm' },
        { key: 'FootballEnvironment.playerStart', component: 'FootballEnvironment', category: 'Starting setup', label: 'Player spawn', value: '(0, 0, 8)', unit: '' },
        { key: 'FootballEnvironment.resetAfterGoal', component: 'FootballEnvironment', category: 'Episode', label: 'Reset after goal', value: 'True', unit: '' },
        { key: 'FootballEnvironment.resetDelay', component: 'FootballEnvironment', category: 'Episode', label: 'Reset delay', value: '1', unit: 's' },
        { key: 'FootballEnvironment.seed', component: 'FootballEnvironment', category: 'Starting setup', label: 'Environment seed', value: '104', unit: '' },
        { key: 'FootballEnvironment.timeCostPerSecond', component: 'FootballEnvironment', category: 'Rewards', label: 'Time cost per second', value: '-0.00100000005', unit: 'reward/s' },
        { key: 'FootballEnvironment.timeLimit', component: 'FootballEnvironment', category: 'Episode', label: 'Time limit', value: '12', unit: 's' },
        { key: 'FootballEnvironment.timeoutReward', component: 'FootballEnvironment', category: 'Rewards', label: 'Timeout reward', value: '0', unit: '' },
        { key: 'FootballGoal.SuccessCondition', component: 'FootballGoal', category: 'Goal', label: 'Success condition', value: 'Ball fully crosses the goal plane inside the opening.', unit: '' },
        { key: 'FootballGoal.openingHeight', component: 'FootballGoal', category: 'Goal', label: 'Opening height', value: '2.20000005', unit: 'm' },
        { key: 'FootballGoal.openingWidth', component: 'FootballGoal', category: 'Goal', label: 'Opening width', value: '4', unit: 'm' },
        { key: 'SpawnRegion.size', component: 'SpawnRegion', category: 'Starting setup', label: 'Randomized spawn area', value: '(0, 0)', unit: 'm' },
        { key: 'SpawnRegion.yawVariation', component: 'SpawnRegion', category: 'Starting setup', label: 'Yaw variation', value: '0', unit: 'degrees' },
    ],
    modifiers: [
        { name: 'Backstop', shape: 'BoxCollider', position: '(0, 1.10000002, 14.6499996)', size: '(4.25, 2.20000005, 0.100000381)', is_trigger: false },
        { name: 'Crossbar', shape: 'BoxCollider', position: '(0, 2.27999997, 13)', size: '(4.32000017, 0.159999847, 0.159999847)', is_trigger: false },
        { name: 'Goal floor', shape: 'BoxCollider', position: '(0, -0.150000006, 13.8500004)', size: '(4.30000019, 0.300000012, 1.70000076)', is_trigger: false },
        { name: 'Left post', shape: 'BoxCollider', position: '(-2.07999992, 1.10000002, 13)', size: '(0.159999967, 2.20000005, 0.159999847)', is_trigger: false },
        { name: 'Left return', shape: 'BoxCollider', position: '(-2.07999992, 1.10000002, 13.8500004)', size: '(0.0999999046, 2.20000005, 1.70000076)', is_trigger: false },
        { name: 'Playing surface — 18 x 26 m', shape: 'BoxCollider', position: '(0, -0.150000006, 0)', size: '(18, 0.300000012, 26)', is_trigger: false },
        { name: 'Right post', shape: 'BoxCollider', position: '(2.07999992, 1.10000002, 13)', size: '(0.159999967, 2.20000005, 0.159999847)', is_trigger: false },
        { name: 'Right return', shape: 'BoxCollider', position: '(2.07999992, 1.10000002, 13.8500004)', size: '(0.0999999046, 2.20000005, 1.70000076)', is_trigger: false },
        { name: 'Wall', shape: 'BoxCollider', position: '(-9.10000038, 0.425000012, 0)', size: '(0.200000763, 1, 26.3999996)', is_trigger: false },
        { name: 'Wall', shape: 'BoxCollider', position: '(9.10000038, 0.425000012, 0)', size: '(0.200000763, 1, 26.3999996)', is_trigger: false },
        { name: 'Wall', shape: 'BoxCollider', position: '(0, 0.425000012, -13.1000004)', size: '(18.3999996, 1, 1)', is_trigger: false },
        { name: 'Wall', shape: 'BoxCollider', position: '(-5.60000038, 0.425000012, 13.1000004)', size: '(7.00000048, 1, 1)', is_trigger: false },
        { name: 'Wall', shape: 'BoxCollider', position: '(5.60000038, 0.425000012, 13.1000004)', size: '(7.00000048, 1, 1)', is_trigger: false },
    ],
};
const fypCooperativeEnvironment = {
    environment_id: 'cooperative-scrimmage', name: 'Cooperative Scrimmage', version: '1.0.0', difficulty: '2 — intermediate',
    purpose: 'Two teammates coordinate to score against one scripted opponent.',
    scene_path: 'Assets/Football/Scenes/CooperativeScrimmage.unity',
    definition_sha256: fypCheckpointHash, snapshot_recorded: true,
    player_settings_sha256: fypEnvironment.player_settings_sha256,
    player_settings: fypEnvironment.player_settings,
    settings: [
        { key: 'TeamSettings.playerCount', component: 'TeamSettings', category: 'Teams', label: 'Players per team', value: '2', unit: 'players' },
        { key: 'OpponentSettings.opponentCount', component: 'OpponentSettings', category: 'Teams', label: 'Opponents', value: '1', unit: 'player' },
        { key: 'FootballEnvironment.timeLimit', component: 'FootballEnvironment', category: 'Episode', label: 'Time limit', value: '30', unit: 's' },
        { key: 'FootballEnvironment.goalReward', component: 'FootballEnvironment', category: 'Rewards', label: 'Goal reward', value: '1', unit: 'team reward' },
        { key: 'FootballEnvironment.timeCostPerSecond', component: 'FootballEnvironment', category: 'Rewards', label: 'Time cost per second', value: '-0.001', unit: 'reward/s' },
        { key: 'SpawnRegion.teamFormation', component: 'SpawnRegion', category: 'Starting setup', label: 'Team formation', value: 'side by side', unit: '' },
        { key: 'OpponentSettings.spawnDistance', component: 'OpponentSettings', category: 'Starting setup', label: 'Opponent distance', value: '6', unit: 'm' },
    ],
    modifiers: [
        { name: 'Opponent spawn zone', shape: 'BoxCollider', position: '(0, 0.5, -5)', size: '(4, 1, 2)', is_trigger: true },
        { name: 'Team spawn zone', shape: 'BoxCollider', position: '(0, 0.5, 5)', size: '(6, 1, 2)', is_trigger: true },
    ],
};
const fypCooperativeBuildUpEnvironment = {
    environment_id: 'cooperative-build-up', name: 'Cooperative Build-up', version: '1.0.0', difficulty: '3 — developing',
    purpose: 'A wider field gives the pair room to progress with passes and support runs.',
    scene_path: 'Assets/Football/Scenes/CooperativeBuildUp.unity',
    definition_sha256: 'b'.repeat(64), snapshot_recorded: true,
    player_settings_sha256: fypEnvironment.player_settings_sha256,
    player_settings: fypEnvironment.player_settings,
    settings: [
        { key: 'TeamSettings.playerCount', component: 'TeamSettings', category: 'Teams', label: 'Players per team', value: '2', unit: 'players' },
        { key: 'OpponentSettings.opponentCount', component: 'OpponentSettings', category: 'Teams', label: 'Opponents', value: '1', unit: 'player' },
        { key: 'FootballEnvironment.timeLimit', component: 'FootballEnvironment', category: 'Episode', label: 'Time limit', value: '45', unit: 's' },
        { key: 'FootballEnvironment.playableHalfExtents', component: 'FootballEnvironment', category: 'Episode', label: 'Playable half extents', value: '(12, 20)', unit: 'm' },
        { key: 'FootballEnvironment.goalReward', component: 'FootballEnvironment', category: 'Rewards', label: 'Goal reward', value: '1', unit: 'team reward' },
        { key: 'SpawnRegion.teamFormation', component: 'SpawnRegion', category: 'Starting setup', label: 'Team formation', value: 'staggered support', unit: '' },
        { key: 'SpawnRegion.ballStart', component: 'SpawnRegion', category: 'Starting setup', label: 'Ball start region', value: 'central third', unit: '' },
        { key: 'OpponentSettings.spawnDistance', component: 'OpponentSettings', category: 'Starting setup', label: 'Opponent distance', value: '8', unit: 'm' },
    ],
    modifiers: [
        { name: 'Central channel', shape: 'BoxCollider', position: '(0, 0.1, 1)', size: '(5, 0.2, 15)', is_trigger: true },
        { name: 'Left passing gate', shape: 'BoxCollider', position: '(-5, 0.5, 7)', size: '(1, 1, 2)', is_trigger: true },
        { name: 'Right passing gate', shape: 'BoxCollider', position: '(5, 0.5, 7)', size: '(1, 1, 2)', is_trigger: true },
    ],
};
const fypCooperativePressureEnvironment = {
    environment_id: 'cooperative-high-pressure', name: 'Cooperative High Pressure', version: '1.0.0', difficulty: '4 — advanced',
    purpose: 'Two defenders compress space and force quick decisions before a shot.',
    scene_path: 'Assets/Football/Scenes/CooperativeHighPressure.unity',
    definition_sha256: 'c'.repeat(64), snapshot_recorded: true,
    player_settings_sha256: fypEnvironment.player_settings_sha256,
    player_settings: fypEnvironment.player_settings,
    settings: [
        { key: 'TeamSettings.playerCount', component: 'TeamSettings', category: 'Teams', label: 'Players per team', value: '2', unit: 'players' },
        { key: 'OpponentSettings.opponentCount', component: 'OpponentSettings', category: 'Teams', label: 'Opponents', value: '2', unit: 'players' },
        { key: 'FootballEnvironment.timeLimit', component: 'FootballEnvironment', category: 'Episode', label: 'Time limit', value: '35', unit: 's' },
        { key: 'FootballEnvironment.playableHalfExtents', component: 'FootballEnvironment', category: 'Episode', label: 'Playable half extents', value: '(9, 15)', unit: 'm' },
        { key: 'FootballEnvironment.goalReward', component: 'FootballEnvironment', category: 'Rewards', label: 'Goal reward', value: '1.5', unit: 'team reward' },
        { key: 'FootballEnvironment.timeCostPerSecond', component: 'FootballEnvironment', category: 'Rewards', label: 'Time cost per second', value: '-0.002', unit: 'reward/s' },
        { key: 'SpawnRegion.teamFormation', component: 'SpawnRegion', category: 'Starting setup', label: 'Team formation', value: 'compact diamond', unit: '' },
        { key: 'OpponentSettings.spawnDistance', component: 'OpponentSettings', category: 'Starting setup', label: 'Nearest defender distance', value: '3', unit: 'm' },
    ],
    modifiers: [
        { name: 'Left pressure zone', shape: 'BoxCollider', position: '(-3, 0.5, 1)', size: '(2, 1, 7)', is_trigger: true },
        { name: 'Right pressure zone', shape: 'BoxCollider', position: '(3, 0.5, 1)', size: '(2, 1, 7)', is_trigger: true },
        { name: 'Shot lane obstacle', shape: 'CapsuleCollider', position: '(0, 0.8, 8)', size: '(1, 1.6, 1)', is_trigger: false },
    ],
};
const fypRuns = [
    {
        run_id: 'demo_fyp_smoke_006', preset: 'smoke', steps: 2048, seed: 88, state: 'completed',
        source_sha256: fypSourceHash, exported_model: true, training_number: 7, checkpoint_number: 6,
        model_sha256: fypModelHash, checkpoint_sha256: fypCheckpointHash, environment: fypEnvironment,
        started_at: '2026-11-13T08:42:00.000Z', finished_at: '2026-11-13T08:46:32.000Z', exit_code: 0,
    },
    {
        run_id: 'demo_fyp_pilot_005', preset: 'pilot_50k', steps: 50000, seed: 707, state: 'completed',
        source_sha256: fypSourceHash, exported_model: true, training_number: 6, checkpoint_number: 5,
        model_sha256: fypModelHash, checkpoint_sha256: fypCheckpointHash, environment: fypEnvironment,
        started_at: '2026-11-12T19:10:00.000Z', finished_at: '2026-11-12T20:03:47.000Z', exit_code: 0,
    },
    {
        run_id: 'demo_fyp_smoke_004', preset: 'smoke', steps: 2048, seed: 146, state: 'completed',
        source_sha256: fypSourceHash, exported_model: true, training_number: 5, checkpoint_number: 4,
        model_sha256: fypModelHash, checkpoint_sha256: fypCheckpointHash, environment: fypEnvironment,
        started_at: '2026-11-12T11:24:00.000Z', finished_at: '2026-11-12T11:29:19.000Z', exit_code: 0,
    },
    {
        run_id: 'demo_fyp_pilot_003', preset: 'pilot_50k', steps: 50000, seed: 321, state: 'completed',
        source_sha256: fypSourceHash, exported_model: true, training_number: 4, checkpoint_number: 3,
        model_sha256: fypModelHash, checkpoint_sha256: fypCheckpointHash, environment: fypEnvironment,
        started_at: '2026-11-11T16:05:00.000Z', finished_at: '2026-11-11T16:51:08.000Z', exit_code: 0,
    },
    {
        run_id: 'demo_fyp_smoke_002', preset: 'smoke', steps: 2048, seed: 105, state: 'completed',
        source_sha256: fypSourceHash, exported_model: true, training_number: 3, checkpoint_number: 2,
        model_sha256: fypModelHash, checkpoint_sha256: fypCheckpointHash, environment: fypEnvironment,
        started_at: '2026-11-11T08:12:00.000Z', finished_at: '2026-11-11T08:16:51.000Z', exit_code: 0,
    },
    {
        run_id: 'demo_fyp_smoke_001', preset: 'smoke', steps: 2048, seed: 63, state: 'completed',
        source_sha256: fypSourceHash, exported_model: true, training_number: 2, checkpoint_number: 1, model_sha256: fypModelHash,
        checkpoint_sha256: fypCheckpointHash, environment: fypEnvironment, started_at: '2026-11-10T10:20:00.000Z',
        finished_at: '2026-11-10T10:24:18.000Z', exit_code: 0,
    },
    {
        run_id: 'demo_fyp_pilot_001', preset: 'pilot_50k', steps: 50000, seed: 202, state: 'failed',
        source_sha256: fypSourceHash, exported_model: false, training_number: 1, model_sha256: null,
        checkpoint_sha256: '7e2a9c14b6035d81f4e7a206c9b3158d0f62e4a7c1935b80d6f21a4e9c738502',
        started_at: '2026-11-08T14:00:00.000Z', finished_at: '2026-11-08T14:42:11.000Z',
        exit_code: 1, error: 'Demo receipt: pilot ended before a checkpoint could be exported.',
    },
];
const fypV2PolicySnapshot = { ...fypCooperativePolicy };
delete (fypV2PolicySnapshot as Partial<typeof fypCooperativePolicy>).execution_supported;
const fypCooperativeRuns = [{
    run_id: 'demo_fyp_v2_pilot_001', policy_id: 'football-v2', policy_revision: 1,
    policy_record_sha256: fypModelHash, policy_snapshot: fypV2PolicySnapshot,
    preset: 'pilot_50k', steps: 50000, seed: 921, state: 'completed',
    source_sha256: fypSourceHash, exported_model: true, training_number: 8, checkpoint_number: 7,
    model_sha256: fypCheckpointHash, checkpoint_sha256: fypModelHash, environment: fypCooperativeEnvironment,
    started_at: '2026-11-13T12:05:00.000Z', finished_at: '2026-11-13T12:47:18.000Z', exit_code: 0,
}];
const fypEvaluations = [{
    evaluation_id: 'eval_demo_fyp_smoke_001', training_run_id: 'demo_fyp_smoke_001', state: 'completed',
    evaluation_number: 1,
    requested_episodes: 10, episodes_completed: 10, goals_scored: 3, goal_rate: 0.3, seed: 515,
    started_at: '2026-11-10T11:00:00.000Z', finished_at: '2026-11-10T11:08:42.000Z', exit_code: 0,
    training_environment: fypEnvironment, evaluation_environment: fypEnvironment,
    episodes: [
        { episode: 1, seed: 515, goals: 0, elapsed_seconds: 32.4, outcome: 'timeout' },
        { episode: 2, seed: 516, goals: 1, elapsed_seconds: 18.7, outcome: 'goal' },
        { episode: 3, seed: 517, goals: 0, elapsed_seconds: 32.1, outcome: 'timeout' },
        { episode: 4, seed: 518, goals: 0, elapsed_seconds: 31.9, outcome: 'timeout' },
        { episode: 5, seed: 519, goals: 1, elapsed_seconds: 21.3, outcome: 'goal' },
        { episode: 6, seed: 520, goals: 0, elapsed_seconds: 32.0, outcome: 'timeout' },
        { episode: 7, seed: 521, goals: 0, elapsed_seconds: 32.2, outcome: 'timeout' },
        { episode: 8, seed: 522, goals: 1, elapsed_seconds: 24.6, outcome: 'goal' },
        { episode: 9, seed: 523, goals: 0, elapsed_seconds: 32.3, outcome: 'timeout' },
        { episode: 10, seed: 524, goals: 0, elapsed_seconds: 32.1, outcome: 'timeout' },
    ],
}, {
    evaluation_id: 'eval_demo_fyp_smoke_006', training_run_id: 'demo_fyp_smoke_006', state: 'completed',
    evaluation_number: 3, requested_episodes: 20, episodes_completed: 20, goals_scored: 12, goal_rate: 0.6, seed: 900,
    started_at: '2026-11-13T10:05:00.000Z', finished_at: '2026-11-13T10:18:26.000Z', exit_code: 0,
    training_environment: fypEnvironment, evaluation_environment: fypEnvironment,
}, {
    evaluation_id: 'eval_demo_fyp_pilot_005', training_run_id: 'demo_fyp_pilot_005', state: 'completed',
    evaluation_number: 2, requested_episodes: 10, episodes_completed: 10, goals_scored: 7, goal_rate: 0.7, seed: 805,
    started_at: '2026-11-12T20:20:00.000Z', finished_at: '2026-11-12T20:27:31.000Z', exit_code: 0,
    training_environment: fypEnvironment, evaluation_environment: fypEnvironment,
}, {
    evaluation_id: 'eval_demo_fyp_pilot_003', training_run_id: 'demo_fyp_pilot_003', state: 'failed',
    evaluation_number: 1, requested_episodes: 10, episodes_completed: 3, goals_scored: 0, goal_rate: 0, seed: 331,
    started_at: '2026-11-11T17:10:00.000Z', finished_at: '2026-11-11T17:13:42.000Z', exit_code: 1,
    error: 'Demo receipt: evaluator stopped after a short Unity disconnect.',
    training_environment: fypEnvironment, evaluation_environment: fypEnvironment,
}, {
    evaluation_id: 'eval_demo_fyp_smoke_002_first', training_run_id: 'demo_fyp_smoke_002', state: 'completed',
    evaluation_number: 1, requested_episodes: 10, episodes_completed: 10, goals_scored: 4, goal_rate: 0.4, seed: 610,
    started_at: '2026-11-11T09:00:00.000Z', finished_at: '2026-11-11T09:07:54.000Z', exit_code: 0,
    training_environment: fypEnvironment, evaluation_environment: fypEnvironment,
}, {
    evaluation_id: 'eval_demo_fyp_smoke_002_retry', training_run_id: 'demo_fyp_smoke_002', state: 'completed',
    evaluation_number: 2, requested_episodes: 10, episodes_completed: 10, goals_scored: 6, goal_rate: 0.6, seed: 740,
    started_at: '2026-11-11T10:20:00.000Z', finished_at: '2026-11-11T10:27:18.000Z', exit_code: 0,
    training_environment: fypEnvironment, evaluation_environment: fypEnvironment,
}];
const fypCooperativeEvaluations = [{
    evaluation_id: 'eval_demo_fyp_v2_pilot_001', training_run_id: 'demo_fyp_v2_pilot_001',
    policy_id: 'football-v2', policy_revision: 1, policy_record_sha256: fypModelHash,
    policy_snapshot: fypV2PolicySnapshot,
    state: 'completed', evaluation_number: 4, requested_episodes: 20, episodes_completed: 20,
    goals_scored: 13, goal_rate: 0.65, seed: 1201,
    started_at: '2026-11-13T13:10:00.000Z', finished_at: '2026-11-13T13:23:36.000Z', exit_code: 0,
    training_environment: fypCooperativeEnvironment, evaluation_environment: fypCooperativeEnvironment,
    episodes: [
        { episode: 1, seed: 1201, goals: 1, elapsed_seconds: 22.6, outcome: 'goal' },
        { episode: 2, seed: 1202, goals: 0, elapsed_seconds: 30.0, outcome: 'timeout' },
        { episode: 3, seed: 1203, goals: 1, elapsed_seconds: 18.4, outcome: 'goal' },
        { episode: 4, seed: 1204, goals: 1, elapsed_seconds: 24.1, outcome: 'goal' },
        { episode: 5, seed: 1205, goals: 0, elapsed_seconds: 30.0, outcome: 'timeout' },
    ],
}];
const status: AtlasStatus = { product: 'Atlas Demo', version: '2.0.0-demo', storage: 'In-memory mock', schemaVersion: 1, projects: mockProjects.length, stores: stores.length, records: records.length };
const str = (value: unknown) => typeof value === 'string' ? value : '';

function page(items: AtlasRecord[], input: Record<string, unknown>): Page<AtlasRecord> {
    const offset = Math.max(0, Number(input.offset) || 0);
    const limit = Math.max(1, Number(input.limit) || 25);
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

/** Mirrors the API tool's JSON body so existing hooks and components need no changes. */
export function mockTool<T>(name: string, input: Record<string, unknown> = {}): T {
    const projectId = str(input.projectId);
    const storeId = str(input.storeId);
    const nodeId = str(input.nodeId);
    const workspaceId = str(input.workspaceId);
    const policyId = str(input.policyId) || 'football-v1';
    // Mirror the public server alias for checkout-oriented reads; audit APIs
    // keep using their existing workspaceId filter.
    const checkoutId = str(input.checkoutId ?? input.workspaceId);
    let result: unknown;
    switch (name) {
        case 'get_atlas_status': result = status; break;
        case 'football_fyp_policies': result = fypPolicies; break;
        case 'football_fyp_manifest': result = {
            available: true,
            policy: fypPolicies.find(policy => policy.policy_id === policyId) ?? fypPolicy,
            policies: fypPolicies,
            execution_supported: fypPolicies.find(policy => policy.policy_id === policyId)?.execution_supported === true,
            contract: {
                contract_id: (fypPolicies.find(policy => policy.policy_id === policyId) ?? fypPolicy).contract.contract_id,
                behavior: (fypPolicies.find(policy => policy.policy_id === policyId) ?? fypPolicy).contract.behavior_name,
                observations: { size: (fypPolicies.find(policy => policy.policy_id === policyId) ?? fypPolicy).contract.observations.size },
                actions: { continuous: (fypPolicies.find(policy => policy.policy_id === policyId) ?? fypPolicy).contract.actions.continuous_count },
                trainer_kind: (fypPolicies.find(policy => policy.policy_id === policyId) ?? fypPolicy).trainer.algorithm,
                scene: ((fypPolicies.find(policy => policy.policy_id === policyId) ?? fypPolicy).curriculum[0]?.scene_path),
            },
        }; break;
        case 'football_fyp_preflight': result = {
            editor_available: false, editor_open: false, editor_playing: false, editor_compiling: false,
            trainer_connected: false, trainer_available: false, scene_ready: false, active_scene: null,
            environment_present: false, episode: null, goals: null, last_outcome: null,
            episodes_completed: null, recent_episodes: [], heartbeat_age_seconds: null,
            verified_build: false, ready_to_train: false,
            policy_supported: fypPolicies.find(policy => policy.policy_id === policyId)?.execution_supported === true,
            source_sha256: fypSourceHash,
            note: fypPolicies.find(policy => policy.policy_id === policyId)?.execution_supported
                ? 'Demo status only. Mock mode does not inspect the FYP Unity Editor or trainer.'
                : 'This mock policy is documentation only and cannot launch training.',
        }; break;
        case 'football_fyp_environments': result = [fypEnvironment, fypCooperativeEnvironment, fypCooperativeBuildUpEnvironment, fypCooperativePressureEnvironment]; break;
        case 'football_fyp_runs': result = policyId === 'football-v1' ? fypRuns : policyId === 'football-v2' ? fypCooperativeRuns : []; break;
        case 'football_fyp_evaluations': result = policyId === 'football-v1' ? fypEvaluations : policyId === 'football-v2' ? fypCooperativeEvaluations : []; break;
        case 'get_storage_usage': result = {
            postgres: {
                state: 'ready', measuredAt: stamp, databaseBytes: 32_000_000, tableBytes: 19_000_000, indexBytes: 6_000_000,
                tableCount: 3, tables: [
                    { schema: 'public', name: 'records', tableBytes: 12_000_000, indexBytes: 4_000_000, totalBytes: 16_000_000 },
                    { schema: 'public', name: 'stores', tableBytes: 4_000_000, indexBytes: 1_000_000, totalBytes: 5_000_000 },
                    { schema: 'public', name: 'projects', tableBytes: 3_000_000, indexBytes: 1_000_000, totalBytes: 4_000_000 },
                ],
            },
            r2: {
                state: 'ready', bucket: 'atlas-demo', measuredAt: stamp, refreshedAt: stamp,
                storageBytes: 480_000_000, objectCount: 64, classA: 314, classB: 12_400, otherOperations: 0,
                monthStart: stamp.slice(0, 8) + '01T00:00:00Z', accountWideOperations: true,
                storageAllowanceBytes: 10_000_000_000, classAAllowance: 1_000_000, classBAllowance: 10_000_000,
            },
        }; break;
        case 'list_projects':
            result = input.withMetrics ? mockProjects.map(p => ({
                ...p,
                metrics: {
                    stores: stores.filter(s => s.projectId === p.id).length,
                    records: records.filter(r => r.projectId === p.id).length,
                    views: 0,
                    applications: applications.filter(a => a.projectId === p.id).length,
                },
            })) : mockProjects;
            break;
        case 'get_project': result = mockProjects.find(p => p.id === projectId); break;
        case 'list_stores': result = stores.filter(s => s.projectId === projectId); break;
        case 'get_store': result = stores.find(s => s.id === storeId && s.projectId === projectId); break;
        case 'list_records': case 'query_records':
            result = page(records.filter(r => r.projectId === projectId && r.storeId === storeId), input); break;
        case 'list_views': result = []; break;
        case 'list_nodes': result = nodes; break;
        case 'list_node_share_approvals': result = []; break;
        case 'list_node_releases': result = { state: 'ready', releases: [], checkedAt: stamp, source: 'github-releases' }; break;
        case 'list_node_update_intents': result = []; break; // Demo only: no persisted requests or executable update control.
        case 'get_node':
            result = { ...nodes.find(node => node.id === nodeId), workspaces: workspaces.filter(w => w.nodeId === nodeId),
                activity: activity.filter(a => workspaces.some(w => w.nodeId === nodeId && w.id === a.workspaceId)).map(a => ({ operation: a.operation, createdAt: a.occurredAt })) }; break;
        case 'list_workspaces': result = workspaces.filter(w => !nodeId || w.nodeId === nodeId); break;
        case 'list_logical_workspaces':
            result = logicalWorkspaces.filter(group =>
                !input.includeArchived ? group.checkouts.some(w => w.status === 'active') : true);
            break;
        case 'list_github_repositories':
            result = { repositories: logicalWorkspaces.filter(group => group.repository).map(group => ({
                repository: group.repository, private: true, defaultBranch: 'main', archived: false,
            })) };
            break;
        case 'workspace_git_list_worktrees': result = { worktrees: [] }; break;
        case 'list_project_workspaces': result = workspaces.filter(w => w.projectId === projectId); break;
        case 'get_workspace': result = workspaces.find(w => w.id === checkoutId && (!projectId || w.projectId === projectId)); break;
        case 'workspace_git_status': {
            const checkout = workspaces.find(w => w.id === checkoutId);
            const group = logicalWorkspaces.find(group => group.checkouts.some(w => w.id === checkoutId));
            if (!checkout || !group?.repository) {
                result = { available: false, reason: 'No Git repository in this demo directory.' };
                break;
            }
            const branch = checkout.name === 'Atlas main' || checkout.name.endsWith('main')
                ? 'main' : 'atlas/' + checkout.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            result = {
                available: true, branch, head: 'a'.repeat(40), originRepository: group.repository,
                dirty: branch !== 'main', changes: [], truncated: false,
            };
            break;
        }
        case 'workspace_list_dev_tasks': result = []; break;
        case 'workspace_list_files': result = { entries: [{ path: 'README.md', type: 'file' }, { path: 'src', type: 'directory' }], truncated: false }; break;
        case 'workspace_read_file': result = { path: input.path, text: '# Demo workspace\nThis is an illustrative local fixture, not a real repository.' }; break;
        case 'unity_list_commands': result = { available: true, state: 'ready', commands: [] }; break;
        case 'query_monitoring_activity': {
            // Demo fixtures do not model authoritative logical Workspace membership.
            // Fail closed rather than presenting unrelated activity as server-scoped.
            if (input.logicalWorkspaceId) throw new Error(
                'Logical Workspace activity is unavailable in local mock mode.');
            const filtered = activity.filter(event => {
                const details = event.resulting && typeof event.resulting === 'object' ? event.resulting as Record<string, unknown> : {};
                const category = event.operation.startsWith('workspace.git_') ? 'git' : event.operation.startsWith('workspace.file_') ? 'files'
                    : event.operation.startsWith('workspace.dev_') ? 'dev' : event.operation.startsWith('workspace.unity_') ? 'unity'
                    : event.operation.startsWith('workspace.') ? 'workspace' : event.operation.startsWith('view.') ? 'view' : 'core';
                const outcome = event.operation.endsWith('_failed') || details.outcome === 'failed' || details.success === false ? 'failed' : event.operation === 'workspace.mutation_requested' ? 'pending' : 'completed';
                return (!projectId || event.projectId === projectId)
                    && (!workspaceId || event.workspaceId === workspaceId)
                    && (!input.checkoutId || event.workspaceId === input.checkoutId)
                    && (!storeId || event.storeId === storeId)
                    && (!input.nodeId || details.nodeId === input.nodeId)
                    && (!input.client || event.client.toLowerCase() === String(input.client).toLowerCase())
                    && (!input.operation || event.operation === input.operation)
                    && (!input.category || category === input.category)
                    && (!input.outcome || outcome === input.outcome)
                    && (!input.search || [event.operation, event.client, details.error, details.task].some(value => String(value ?? '').toLowerCase().includes(String(input.search).toLowerCase())))
                    && (!input.from || event.occurredAt >= String(input.from))
                    && (!input.to || event.occurredAt <= String(input.to));
            }).sort((a,b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
            const offset = Math.max(0, Number(input.offset) || 0);
            const limit = Math.min(100, Math.max(1, Number(input.limit) || 30));
            result = { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
            break;
        }
        case 'get_recent_activity': case 'get_audit_history':
            result = activity.filter(event => (!projectId || event.projectId === projectId) && (!workspaceId || event.workspaceId === workspaceId))
                .slice(0, Number(input.limit) || 200); break;
        case 'list_all_applications': result = applications; break;
        case 'list_applications': result = applications.filter(a => a.projectId === projectId); break;
        case 'get_application': result = applications.find(a => (!projectId || a.projectId === projectId) && a.slug === input.slug); break;
        case 'code_reviews_overview': case 'code_reviews_dashboard': case 'code_reviews_list_runs': case 'code_reviews_list_findings':
        case 'code_reviews_pr_summary': case 'code_reviews_pr_timeline': case 'code_reviews_review_thread_state':
            result = mockCodeReviewTool(name, input); break;
        case 'get_portfolio_schemas': result = portfolioTypes.map(contentType => ({
            contentType, storeId: uuid(41, portfolioTypes.indexOf(contentType) + 1), name: contentType, fields: portfolioFields[contentType],
        })); break;
        case 'list_portfolio_entries': result = portfolioEntries.filter(entry => !input.contentType || entry.contentType === input.contentType); break;
        case 'get_portfolio_dashboard': result = {
            contentTypes: portfolioTypes.map(contentType => ({
                contentType, name: contentType, storeId: uuid(41, portfolioTypes.indexOf(contentType) + 1),
                total: portfolioEntries.filter(e => e.contentType === contentType).length,
                published: portfolioEntries.filter(e => e.contentType === contentType && e.status === 'published').length,
                drafts: portfolioEntries.filter(e => e.contentType === contentType && e.status !== 'published').length,
            })), media: { active: 0, bytes: 0 },
        }; break;
        case 'list_portfolio_media': case 'list_portfolio_revisions': result = []; break;
        case 'search_everything': {
            const query = str(input.query);
            const needle = query.trim().toLowerCase();
            const hits = [
                ...mockProjects.map(p => ({ id: p.id, kind: 'project', title: p.name, description: p.description ?? '', context: 'Demo project', href: '#/projects/' + p.id, score: 20 })),
                ...stores.map(s => ({ id: s.id, kind: 'store', title: s.name, description: s.description ?? '', context: 'Demo store', href: '#/projects/' + s.projectId + '/stores/' + s.id + '/records', score: 15 })),
                ...nodes.map(n => ({ id: n.id, kind: 'node', title: n.name, description: n.platform ?? '', context: 'Demo node', href: '#/nodes', score: 20 })),
                ...applications.map(a => ({ id: a.slug, kind: 'application', title: a.name, description: a.description, context: 'Demo application', href: '#/projects/' + a.projectId + '/applications/' + a.slug, score: 20 })),
                ...workspaces.map(w => ({ id: w.id, kind: 'workspace', title: w.name, description: w.rootPath, context: 'Demo workspace', href: '#/projects/' + w.projectId + '/workspaces', score: 10 })),
                ...records.map(r => ({ id: r.id, kind: 'record', title: String(r.data.name ?? r.data.title ?? r.data.code ?? 'Record'), description: JSON.stringify(r.data), context: 'Demo record', href: '#/projects/' + r.projectId + '/stores/' + r.storeId + '/records', score: 8 })),
            ];
            if (/logs?|error lines|stdout|stderr/.test(needle)) {
                result = { query, incomplete: [], results: nodes.map(n => ({
                    id: 'log-' + n.id, kind: 'node', title: 'Read logs from ' + n.name,
                    description: 'Illustrative logs, not the real node output', context: 'Demo node logs',
                    href: '#/nodes', score: 25,
                    action: { type: 'read_node_logs', nodeId: n.id, source: 'stdout', lines: 100 },
                })) };
            } else {
                result = { query, incomplete: [], results: hits.filter(hit =>
                    needle.split(/[^a-z0-9]+/).filter(term => term.length > 2 && !['open', 'find', 'show', 'the', 'want', 'for', 'from', 'please', 'look', 'check', 'with', 'about'].includes(term)).some(term =>
                        (hit.title + ' ' + hit.description + ' ' + hit.kind + ' ' + hit.context).toLowerCase().includes(term))
                ).slice(0, Number(input.limit) || 45) };
            }
            break;
        }
        case 'get_monitoring_health': result = {
            checkedAt: stamp, overall: 'healthy',
            server: { status: 'healthy', startedAt: stamp, uptimeSeconds: 0, database: { status: 'reachable', latencyMs: 0 } },
            nodes: { available: true, summary: { total: 0, healthy: 0, stale: 0, offline: 0,
                unavailable: 0, revoked: 0, unknown: 0 }, items: [] },
        }; break;
        case 'read_server_diagnostics': result = {
            source: 'atlas-server-process', available: true, startedAt: stamp,
            retention: 'current-process', truncated: false,
            events: [{ at: stamp, code: 'server_initialised', level: 'info', message: '[demo] Server runtime initialised' }],
        }; break;
        case 'read_node_logs': result = {
            source: input.source ?? 'stdout', available: true, truncated: false,
            lines: ['[demo] Atlas node fixture initialised', '[demo] Workspace connection healthy', '[demo] No real server logs were accessed'],
        }; break;
        case 'ask_atlas': case 'ask_portfolio': result = {
            question: input.question ?? '', answer: 'You are viewing local demo fixtures. Connect to a live Atlas Server to use the real assistant.',
            abstained: true, sources: [],
            diagnostics: { provider: 'mock', contextRecordCount: 0, authorityStatus: 'mock', unresolvedConflicts: 0,
                relevantUnresolvedConflicts: 0, authorityDecisions: [], relevanceFloorRejected: 0, authoritySuppressed: 0, redundancyRejected: 0 },
        }; break;
        case 'search_atlas': result = { query: input.query ?? '', results: [], diagnostics: { mode: 'mock', resultCount: 0 } }; break;
        case 'request_context': case 'get_context': result = { query: input.query ?? '', selections: [], diagnostics: { mode: 'mock' } }; break;
        default:
            throw new Error('This operation is unavailable in local mock mode (' + name + '). Set VITE_ATLAS_API_MODE=live to use a real Atlas Server.');
    }
    if (result === undefined) throw new Error('No mock fixture found for ' + name + '.');
    return structuredClone(result) as T;
}
