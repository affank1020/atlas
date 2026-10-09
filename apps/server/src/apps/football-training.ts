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
        const start = action === 'launch_headless';
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
        ({ name, description, inputSchema, invoke: x => service.call(operation, x) });
    return {
        type: 'football-training', slug: 'football-training', projectId: FOOTBALL_PROJECT_ID,
        name: 'Football Training', description: 'Run and inspect Unity ML-Agents training, logs and policies on your connected Mac.',
        tools: [
            action('football_list_drills', 'List available football training drills and trainer contracts.', {}, 'drills'),
            action('football_list_jobs', 'Read active and past headless football training jobs.', {}, 'jobs'),
            action('football_get_job_logs', 'Read bounded trainer logs for one headless training job.', { runId, lines: integer.min(1).max(200).optional() }, 'job_logs'),
            action('football_list_policies', 'List indexed exported football policies.', {}, 'policies'),
            action('football_launch_training', 'Request one headless football training job on the connected Mac (may require an initial cached Unity build). Returns a launch receipt, not trainer success.', { drill, preset: z.enum(['smoke', 'full']).default('smoke'), arenas: integer.min(1).max(16).default(1), basePort: integer.min(1024).max(65519).default(5005), seed: integer.min(0).max(2147483647).default(42) }, 'launch_headless'),
            action('football_get_launch_status', 'Read the bounded receipt/log for a previously submitted training launch.', { runId }, 'launch_status'),
            action('football_stop_training', 'Request graceful stop of a verified running headless football training job.', { runId }, 'stop_job'),
            action('football_index_policy', 'Index exported ONNX policy artifacts from a completed football training run.', { runId }, 'index_policy'),
            action('football_plan_evaluation', 'Build a dry-run evaluation plan for an indexed policy; does not execute an evaluation.', { policyId, episodes: integer.min(1).max(10000).default(100), seed: integer.min(0).max(2147483647).default(42) }, 'evaluation_plan'),
        ],
    };
}
