import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { WorkspaceRepository } from '../workspaces/repository.js';
import type { NodeRouter } from '../nodes/router.js';
import type { Workspace } from '../workspaces/model.js';
import { z } from 'zod';
import type { ApplicationDefinition, ApplicationTool } from './registry.js';

export const FOOTBALL_PROJECT_ID = 'ce09dbe0-0755-4bd8-9376-e4a3152d59f7';
const runId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const policyId = z.string().regex(/^policy_[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const evaluationId = z.string().regex(/^eval_[A-Za-z0-9_]{1,74}$/);
const drill = runId;
const integer = z.number().int();

export class FootballTrainingService {
    constructor(
        private readonly catalog: Pick<CoreService, 'getProject'>,
        private readonly repository: Pick<WorkspaceRepository, 'list' | 'audit'>,
        private readonly router: Pick<NodeRouter, 'execute'>,
    ) {}
    async call(action: string, input: Record<string, unknown> = {}) {
        await this.catalog.getProject(FOOTBALL_PROJECT_ID);
        const available = await this.repository.list(FOOTBALL_PROJECT_ID);
        const workspace = available.find((ws: Workspace) => ws.kind === 'unity' && ws.status === 'active');
        if (!workspace) throw new AtlasError('Connect an active Unity Workspace to the AI Football Project before using this Application.', 'WORKSPACE_UNAVAILABLE');
        const start = ['generalist_stop', 'generalist_package', 'generalist_train', 'generalist_evaluate', 'generalist_baseline', 'generalist_watch', 'generalist_policy_update', 'prebuild_training', 'recover_queue', 'resume_training', 'launch_headless', 'evaluate', 'evaluate_baseline', 'watch_policy', 'watch_live', 'validation_python', 'validation_editor', 'validation_physics'].includes(action);
        const stop = action === 'stop_job';
        const metadata = { action, activityKind: start || stop || action === 'index_policy' ? 'mutation' : 'inspection',
            ...(typeof input.runId === 'string' ? { runId: input.runId } : {}),
            ...(typeof input.drill === 'string' ? { drill: input.drill } : {}) };
        // Record intent before dispatching potentially long-running local work.
        if (start || stop || action === 'index_policy')
            await this.repository.audit(workspace, 'application.football.requested', 'Football Training', metadata);
        try {
            const response = await this.router.execute(workspace, 'football_control',
                { projectId: FOOTBALL_PROJECT_ID, workspaceId: workspace.id, action, ...input });
            await this.repository.audit(workspace, 'application.football.completed', 'Football Training', { ...metadata, outcome: 'accepted' });
            return response;
        } catch (error) {
            await this.repository.audit(workspace, 'application.football.failed', 'Football Training', { ...metadata, outcome: 'failed' }).catch(() => undefined);
            throw error;
        }
    }
}

export function footballTrainingApplication(service: Pick<FootballTrainingService, 'call'>): ApplicationDefinition {
    const action = (name: string, description: string, inputSchema: ApplicationTool['inputSchema'], operation: string): ApplicationTool =>
        ({ name, description, inputSchema, invoke: x => service.call(operation, z.object(inputSchema).strict().parse(x)) });
    return {
        type: 'football-training', slug: 'football-training', projectId: FOOTBALL_PROJECT_ID,
        name: 'Football Training', description: 'Run and inspect Unity ML-Agents training, logs and policies on your connected Mac.',
        tools: [
            action('football_generalist_manifest', 'Read versioned generalist policy contract, curriculum and scenario definitions from the connected Unity workspace. Read-only; no build or training.', {}, 'generalist_manifest'),
            action('football_generalist_runs', 'Discover canonical generalist training receipts, including runs launched outside Atlas. Unknown state is not treated as success.', {}, 'generalist_runs'),
            action('football_generalist_run_detail', 'Read bounded live trainer output, checkpoints and metadata for a discovered generalist run.', { runId }, 'generalist_run_detail'),
            action('football_generalist_evaluation_detail', 'Read saved generalist evaluation outcomes and paginated episodes.', { runId: z.string().uuid(), offset: integer.min(0).max(10000).default(0), limit: integer.min(1).max(200).default(100) }, 'generalist_evaluation_detail'),
            action('football_generalist_policies', 'Discover only explicitly registered generalist policy metadata; no inferred compatibility.', {}, 'generalist_policies'),
            action('football_generalist_assessments', 'Read grouped, provisional skill evidence from saved held-out policy evaluations.', {}, 'generalist_assessments'),
            action('football_generalist_policy_update', 'Set a friendly policy name or feature a saved policy without modifying model identity or weights.',
                { policyId: runId, displayName: z.string().min(1).max(64).optional(), featured: z.boolean().optional() }, 'generalist_policy_update'),
            action('football_generalist_activity', 'Read generalist evaluation, baseline and watch receipts.', {}, 'generalist_activity'),
            action('football_generalist_status', 'Inspect a generalist operation receipt.', { runId: z.string().uuid() }, 'generalist_status'),
            action('football_generalist_package', 'Register a completed generalist ONNX run as a hashed Unity policy bundle without restarting training.', { runId }, 'generalist_package'),
            action('football_generalist_stop', 'Request a graceful interrupt of an Atlas-owned generalist training process group.', { runId: z.string().uuid() }, 'generalist_stop'),
            action('football_generalist_train', 'Start one generalist PPO learner with an allowlisted scenario and preset.', { scenario: drill, preset: z.enum(['smoke', 'pilot_100k']), seed: integer.min(0).max(2147483647), arenas: integer.min(1).max(16), basePort: integer.min(1024).max(65519), initializeFromRunId: runId.optional() }, 'generalist_train'),
            action('football_generalist_evaluate', 'Evaluate a compatible provenance-checked generalist policy.', { policyId: runId, scenario: drill, seed: integer.min(0).max(2147483647), episodes: integer.min(1).max(10000) }, 'generalist_evaluate'),
            action('football_generalist_baseline', 'Evaluate the scripted generalist baseline with a stamped Unity runner.', { scenario: drill, seed: integer.min(0).max(2147483647), episodes: integer.min(1).max(10000) }, 'generalist_baseline'),
            action('football_generalist_watch', 'Open a compatible provenance-checked generalist policy in Unity.', { policyId: runId, scenario: drill, seed: integer.min(0).max(2147483647), arenas: integer.min(1).max(16) }, 'generalist_watch'),
            action('football_list_drills', 'List available football training drills and trainer contracts.', {}, 'drills'),
            action('football_prebuild_training', 'Build and verify a cached Unity player while training is idle. Poll the launch receipt. Never launches PPO.', { drill }, 'prebuild_training'),
            action('football_training_resources', 'Read owner-configured admission budgets, host usage and queue health.', {}, 'training_resources'),
            action('football_recover_queue', 'Restart the durable queue dispatcher; its kernel lock prevents duplicate dispatch.', {}, 'recover_queue'),
            action('football_resume_training', 'Resume a verified checkpoint using its original immutable config, player and training environment.', { runId, basePort: integer.min(1024).max(65535).optional() }, 'resume_training'),
            action('football_list_jobs', 'Read active and past headless football training jobs.', {}, 'jobs'),
            action('football_get_job_logs', 'Read bounded trainer logs for one headless training job.', { runId, lines: integer.min(1).max(200).optional() }, 'job_logs'),
            action('football_list_policies', 'List indexed exported football policies.', {}, 'policies'),
            action('football_launch_training', 'Queue an independent policy on the Mac using a prebuilt player and resource admission. Multiple arenas share that one policy. Returns a receipt, not trainer success.', { drill, preset: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).default('smoke'), arenas: integer.min(1).max(65535).default(1), basePort: integer.min(1024).max(65535).default(5005), seed: integer.min(0).max(2147483647).default(42) }, 'launch_headless'),
            action('football_get_launch_status', 'Read the bounded receipt/log for a previously submitted training launch.', { runId }, 'launch_status'),
            action('football_stop_training', 'Request graceful stop of a verified running headless football training job.', { runId }, 'stop_job'),
            action('football_index_policy', 'Index exported ONNX policy artifacts from a completed football training run.', { runId }, 'index_policy'),
            action('football_list_evaluations', 'List saved model evaluations.', {}, 'evaluations'),
            action('football_get_evaluation_detail', 'Read bounded measured per-episode evaluation diagnostics and summary for a completed evaluation.', { evaluationId, offset: integer.min(0).max(10000).default(0), limit: integer.min(1).max(200).default(100) }, 'evaluation_detail'),
            action('football_run_evaluation', 'Start seeded policy inference evaluation on connected Mac. Returns a receipt.', { policyId, episodes: integer.min(1).max(10000).default(100), seed: integer.min(0).max(2147483647).default(123), replayEpisode: integer.min(0).max(10000).optional(), evaluationStage: z.union([z.literal(1), z.literal(2)]).optional() }, 'evaluate'),
            action('football_run_baseline_evaluation', 'Run zero/random/forward/scripted Stage-1 controller in the same Unity physics harness, with reproducible scenarios.', { baselineMode: z.enum(['zero', 'random', 'forward', 'scripted']), episodes: integer.min(1).max(10000).default(100), seed: integer.min(0).max(2147483647).default(123), replayEpisode: integer.min(0).max(10000).optional() }, 'evaluate_baseline'),
            action('football_get_evaluation_status', 'Inspect evaluation progress and completion receipt.', { runId }, 'evaluation_status'),
            action('football_list_viewers', 'List local Mac viewer sessions, including live telemetry and policy playback.', {}, 'viewer_sessions'),
            action('football_watch_live', 'Open a graphical viewer of telemetry from a running training job on the connected Mac; does not modify training.', { runId }, 'watch_live'),
            action('football_open_policy_viewer', 'Open a selected indexed ONNX policy in a graphical Unity viewer on the connected Mac.', { policyId, arenas: integer.min(1).max(16).default(1), seed: integer.min(0).max(2147483647).default(42) }, 'watch_policy'),
            action('football_get_viewer_launch_status', 'Inspect asynchronous Mac graphical viewer launch progress.', { runId }, 'viewer_launch_status'),
            action('football_plan_evaluation', 'Build a dry-run evaluation plan for an indexed policy; does not execute an evaluation.', { policyId, episodes: integer.min(1).max(10000).default(100), seed: integer.min(0).max(2147483647).default(42) }, 'evaluation_plan'),
            action('football_validation_status', 'Read recent Mac validation receipts and permissions.', {}, 'validation_status'),
            action('football_validate_python', 'Run a fixed Python regression suite on the Mac and store evidence.', {}, 'validation_python'),
            action('football_validate_editor_gates', 'Run four fixed Unity Editor predicate gates if locally approved and Editor idle.', {}, 'validation_editor'),
            action('football_validate_physics_smoke', 'Run opt-in Play Mode shared Rigidbody collision and goal smoke; not an agent evaluation.', {}, 'validation_physics'),
        ],
    };
}
