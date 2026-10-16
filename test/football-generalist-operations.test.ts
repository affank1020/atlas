import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { footballControl } from '../apps/node/src/capabilities/football.js';

const input = { projectId: 'ce09dbe0-0755-4bd8-9376-e4a3152d59f7', workspaceId: '09bd8b0b-41be-4b78-a649-a71ce5f08520' };
const ws = (rootPath: string) => ({ ...input, nodeId: '9eb6659d-69c4-4d40-9788-098e5ff6a2fb', id: input.workspaceId, kind: 'unity', status: 'active', rootPath }) as any;

test('generalist run discovery indexes receipts independently from legacy driver', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-generalist-'));
    try {
        const dir = path.join(root, 'training-driver-runs', 'external-generalist');
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'generalist-run.json'), JSON.stringify({
            family: 'generalist', mode: 'train', run_id: 'external-run-42',
            scenario: 's0-contact-easy-v1', seed: 42, num_envs: 2, contract_sha256: 'abc',
        }));
        const result = await footballControl(ws(root), { ...input, action: 'generalist_runs' }) as any[];
        assert.equal(result.length, 1);
        assert.equal(result[0].id, 'external-run-42');
        assert.equal(result[0].num_envs, 2);
        assert.equal(result[0].state, 'unknown');
        assert.equal(result[0].family, 'generalist');
        await writeFile(path.join(dir, 'another.json'), JSON.stringify({ family: 'legacy' }));
        assert.equal((await footballControl(ws(root), { ...input, action: 'generalist_runs' }) as any[]).length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('generalist operations fail closed for missing scripts, invalid scenarios and invalid receipt identifiers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-generalist-'));
    try {
        await mkdir(path.join(root, 'ml-agents/config'), { recursive: true });
        await mkdir(path.join(root, 'Assets/Resources/Generalist'), { recursive: true });
        await writeFile(path.join(root, 'ml-agents/config/football_generalist_v2_contract.json'), JSON.stringify({
            contract_id: 'football-generalist-v2', behavior: 'FootballGeneralistV2',
            observations: { size: 54, fields: [] }, actions: { continuous: 5, channels: [] },
        }));
        await writeFile(path.join(root, 'Assets/Resources/Generalist/scenarios.json'), JSON.stringify({
            sceneVersion: 's2', physicsVersion: 'p2', scenarios: [{ id: 's0-contact-easy-v1' }],
        }));
        await writeFile(path.join(root, 'ml-agents/config/generalist_curriculum.json'), JSON.stringify({
            stages: [{ id: 'S0' }], held_out_seeds: [515],
        }));
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_train', scenario: 'bogus', preset: 'smoke', seed: 42 }), (e: any) => e.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_train', scenario: 'mix', preset: 'smoke', seed: 515 }), (e: any) => e.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_train', scenario: 'mix', preset: 'smoke', seed: 42 }));
        // S1 must never silently start from random weights.
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_train',
            scenario: 's1_rehearsal', preset: 'smoke', seed: 42 }),
            (e: any) => e.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_train',
            scenario: 's1_rehearsal', preset: 'smoke', seed: 42, initializeFromRunId: '../outside' }));
        const source = path.join(root, 'training-driver-runs', 'old-s0');
        await mkdir(path.join(source, 'old-s0', 'FootballGeneralistV2'), { recursive: true });
        await writeFile(path.join(source, 'generalist-run.json'), JSON.stringify({
            family: 'generalist', mode: 'train', run_id: 'old-s0', contract_sha256: 'wrong-abi',
        }));
        await writeFile(path.join(source, 'old-s0', 'FootballGeneralistV2', 'checkpoint.pt'), 'checkpoint');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_train',
            scenario: 's1_rehearsal', preset: 'smoke', seed: 42, initializeFromRunId: 'old-s0' }),
            (e: any) => e.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_status', runId: '../secret' }));
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_watch', policyId: 'legacy-policy', scenario: 'mix' }));
        // A Watch-only playlist cannot leak into PPO or held-out evaluation.
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_train',
            scenario: 'dribbling_showcase_v1', preset: 'smoke', seed: 42 }),
            (e: any) => e.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_evaluate',
            scenario: 'dribbling_showcase_v1', policyId: 'generalist-musiala-v1', seed: 515 }),
            (e: any) => e.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_watch',
            scenario: 'dribbling_showcase_v1', policyId: 'generalist-musiala-v1', seed: 515 }),
            (e: any) => e.code === 'NOT_FOUND');

    } finally { await rm(root, { recursive: true, force: true }); }
});


test('generalist run detail safely provides saved checkpoints and reports missing terminal logs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-generalist-detail-'));
    try {
        const dir = path.join(root, 'training-driver-runs', 'external-run');
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'generalist-run.json'), JSON.stringify({
            family: 'generalist', mode: 'train', run_id: 'run-detail-42', scenario: 'mix', seed: 42,
        }));
        const detail = await footballControl(ws(root), { ...input, action: 'generalist_run_detail', runId: 'run-detail-42' }) as any;
        assert.equal(detail.run.id, 'run-detail-42');
        assert.equal(detail.log_source, null);
        assert.match(detail.log_note, /No saved trainer console log/);
        const operations = path.join(root, 'training-driver-runs', 'atlas-generalist-operations');
        await mkdir(operations, { recursive: true });
        const ticket = '5d2504cd-c985-4b5e-a5f7-31cc84fd245a';
        await writeFile(path.join(operations, ticket + '.json'), JSON.stringify({
            ticket, pid: -1, action: 'generalist_train', run_id: 'run-detail-42',
        }));
        await writeFile(path.join(operations, ticket + '.out'),
            '[INFO] FootballGeneralistV2. Step: 1500. Time Elapsed: 10 s. Mean Reward: 0.5.\\n');
        await mkdir(path.join(dir, 'run-detail-42'), { recursive: true });
        await writeFile(path.join(dir, 'run-detail-42', 'configuration.yaml'),
            'behaviors:\n  FootballGeneralistV2:\n    max_steps: 100000\n');
        const live = await footballControl(ws(root), { ...input, action: 'generalist_run_detail', runId: 'run-detail-42' }) as any;
        assert.equal(live.log_source, 'Atlas training launch');
        assert.match(live.logs, /Step: 1500/);
        assert.equal(live.ticket, ticket);
        assert.equal(live.training_budget_steps, 100000);
        // Terminal-launched runs retain ML-Agents checkpoint progress even without stdout.
        await mkdir(path.join(dir, 'run-detail-42', 'FootballGeneralistV2'), { recursive: true });
        await mkdir(path.join(dir, 'run-detail-42', 'run_logs'), { recursive: true });
        await writeFile(path.join(dir, 'run-detail-42', 'FootballGeneralistV2', 'FootballGeneralistV2-2050.onnx'), 'model');
        await writeFile(path.join(dir, 'run-detail-42', 'FootballGeneralistV2.onnx'), 'final model');
        await writeFile(path.join(dir, 'run-detail-42', 'run_logs', 'training_status.json'), JSON.stringify({
            FootballGeneralistV2: { checkpoints: [{ steps: 1500, reward: 0.5 }],
                final_checkpoint: { steps: 2050, reward: 0.6 } },
        }));
        const recovered = await footballControl(ws(root), { ...input, action: 'generalist_run_detail', runId: 'run-detail-42' }) as any;
        assert.equal(recovered.checkpoint_steps, 2050);
        assert.deepEqual(recovered.checkpoint_samples, [{ step: 1500, reward: 0.5 }, { step: 2050, reward: 0.6 }]);
        assert.equal(recovered.run.checkpoints, 2);
        assert.equal(recovered.run.checkpoint_files.length, 2);
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_run_detail', runId: '../bad' }));
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_run_detail', runId: 'missing' }));
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('generalist evaluation detail paginates actual results and preserves outcome evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-generalist-eval-'));
    try {
        const dir = path.join(root, 'training-driver-runs', 'atlas-generalist-operations');
        await mkdir(dir, { recursive: true });
        const ticket = '75ed74ef-a004-4299-8f2f-ad47389cd39a';
        await writeFile(path.join(dir, ticket + '.json'), JSON.stringify({
            ticket, pid: -1, action: 'generalist_evaluate', policy_id: 'policy_generalist-a',
            started_at: new Date().toISOString(), output: path.join(dir, ticket + '.result.json'),
        }));
        await writeFile(path.join(dir, ticket + '.result.json'), JSON.stringify({ contract: 'football-generalist-v2',
            episodes: [
                { index: 0, outcome: 'contact', success: true },
                { index: 1, outcome: 'timeout', success: false },
                { index: 2, outcome: 'contact', success: true },
            ],
        }));
        const result = await footballControl(ws(root), { ...input, action: 'generalist_evaluation_detail', runId: ticket,
            offset: 1, limit: 1 }) as any;
        assert.equal(result.summary.total, 3);
        assert.equal(result.summary.success_rate, 2 / 3);
        assert.deepEqual(result.summary.outcomes, { contact: 2, timeout: 1 });
        assert.equal(result.episodes[0].index, 1);
        assert.equal(result.pagination.has_more, true);
        // Recover a historical run whose receipt UUID and result-file UUID differ.
        const olderTicket = '75ed74ef-a004-4299-8f2f-ad47389cd39c';
        const olderResult = path.join(dir, '75ed74ef-a004-4299-8f2f-ad47389cd39d.result.json');
        await writeFile(path.join(dir, olderTicket + '.json'), JSON.stringify({
            ticket: olderTicket, pid: -1, action: 'generalist_evaluate', output: olderResult,
            started_at: new Date().toISOString(),
        }));
        await writeFile(olderResult, JSON.stringify({ contract: 'football-generalist-v2', episodes: [
            { index: 0, outcome: 'physical_contact' }, { index: 1, outcome: 'physical_contact' },
        ] }));
        const recovered = await footballControl(ws(root), { ...input,
            action: 'generalist_evaluation_detail', runId: olderTicket }) as any;
        assert.equal(recovered.summary.total, 2);
        assert.deepEqual(recovered.summary.outcomes, { physical_contact: 2 });
        assert.equal(recovered.summary.success_rate, null);
        // Never read a result file outside the private operations directory.
        const unsafeTicket = '75ed74ef-a004-4299-8f2f-ad47389cd39e';
        await writeFile(path.join(dir, unsafeTicket + '.json'), JSON.stringify({
            ticket: unsafeTicket, pid: -1, action: 'generalist_evaluate',
            output: path.join(root, 'external.result.json'),
        }));
        const unsafe = await footballControl(ws(root), { ...input,
            action: 'generalist_evaluation_detail', runId: unsafeTicket }) as any;
        assert.equal(unsafe.summary, null);
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_evaluation_detail', runId: '../bad' }));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('generalist policy packaging is only offered for a completed export and exposed in run records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-generalist-package-'));
    try {
        const dir = path.join(root, 'training-driver-runs', 'finished-run');
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'generalist-run.json'), JSON.stringify({
            family: 'generalist', mode: 'train', run_id: 'complete-42', scenario: 'mix',
        }));
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_package',
            runId: 'complete-42' }), (error: any) => error.code === 'INVALID_ARGUMENT');
        await mkdir(path.join(dir, 'complete-42'), { recursive: true });
        await writeFile(path.join(dir, 'complete-42', 'FootballGeneralistV2.onnx'), 'model');
        await writeFile(path.join(dir, 'policy-packaging.json'), JSON.stringify({
            status: 'failed', error: 'Unity import failed',
        }));
        const runs = await footballControl(ws(root), { ...input, action: 'generalist_runs' }) as any[];
        assert.equal(runs[0].packaging.status, 'failed');
        assert.equal(runs[0].packaging.error, 'Unity import failed');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_package',
            runId: '../invalid' }));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('Watch receipts distinguish LaunchServices request from player activity without claiming window visibility', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-generalist-viewer-'));
    try {
        const dir = path.join(root, 'training-driver-runs', 'atlas-generalist-operations');
        await mkdir(dir, { recursive: true });
        const ticket = '75ed74ef-a004-4299-8f2f-ad47389cd39b';
        const output = path.join(dir, ticket + '.result.json');
        const data = { ticket, action: 'generalist_watch', pid: process.pid,
            started_at: new Date().toISOString(), output };
        await writeFile(path.join(dir, ticket + '.json'), JSON.stringify(data));
        await writeFile(output + '.launch.json', JSON.stringify({
            command: ['open', '-n', '-W', '-a', '/tmp/generalist.app', '--args', '-generalist-mode', 'watch'],
        }));
        const before = await footballControl(ws(root), { ...input, action: 'generalist_status',
            runId: ticket }) as any;
        assert.equal(before.viewer.launch_method, 'launchservices');
        assert.equal(before.viewer.state, 'launching_unverified');
        assert.equal(before.viewer.player_log_detected, false);
        await writeFile(output + '.player.log', '[UnityMemory] Started standalone Unity player\\n');
        const after = await footballControl(ws(root), { ...input, action: 'generalist_status',
            runId: ticket }) as any;
        assert.equal(after.status, 'running');
        assert.equal(after.viewer.state, 'player_logging');
        assert.equal(after.viewer.player_log_detected, true);
        assert.match(after.viewer.note, /does not prove a window is visible/);
        assert.match(after.viewer.log_tail, /Started standalone/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('Watch receipts reject false visibility from unrelated files or exited launcher', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-generalist-viewer-'));
    try {
        const dir = path.join(root, 'training-driver-runs', 'atlas-generalist-operations');
        await mkdir(dir, { recursive: true });
        const ticket = '75ed74ef-a004-4299-8f2f-ad47389cd39c';
        const output = path.join(dir, ticket + '.result.json');
        await writeFile(path.join(dir, ticket + '.json'), JSON.stringify({
            ticket, action: 'generalist_watch', pid: -1, output, started_at: new Date().toISOString(),
        }));
        await writeFile(output + '.player.log', '[UnityMemory] startup\\n');
        const closed = await footballControl(ws(root), { ...input, action: 'generalist_status',
            runId: ticket }) as any;
        assert.equal(closed.viewer.state, 'closed');
        assert.equal(closed.viewer.launcher_alive, false);
        await writeFile(path.join(dir, ticket + '.err'), 'subprocess.CalledProcessError: failed to open app');
        const failed = await footballControl(ws(root), { ...input, action: 'generalist_status',
            runId: ticket }) as any;
        assert.equal(failed.viewer.state, 'launch_failed');
        assert.equal(failed.status, 'failed_or_stopped');
    } finally { await rm(root, { recursive: true, force: true }); }
});


test('historical featured policy exposes versioned playback only with its pinned recorded runner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-generalist-historical-'));
    const bareApp = await mkdtemp(path.join('/tmp', 'atlas-football-generalist-build-fixture-'));
    const app = bareApp + '.app';
    await rename(bareApp, app);
    try {
        const binary = path.join(app, 'Contents', 'MacOS', 'AI Football');
        await mkdir(path.dirname(binary), { recursive: true });
        await writeFile(binary, 'historical Unity player');
        const oldScenario = 's1-dribble-moving-interception-v1';
        await writeFile(path.join(app, 'Contents', 'generalist-build.json'), JSON.stringify({
            family: 'generalist', contract: { behavior: 'FootballGeneralistV2' },
            contract_sha256: 'old-contract', scenario_sha256: 'old-scenarios',
            implementation_sha256: 'old-implementation',
            scenarios: { scenarios: [{ id: oldScenario }] },
        }));
        await mkdir(path.join(root, 'ml-agents/config'), { recursive: true });
        await mkdir(path.join(root, 'Assets/Resources/Generalist'), { recursive: true });
        await writeFile(path.join(root, 'ml-agents/config/football_generalist_v2_contract.json'), JSON.stringify({
            contract_id: 'football-generalist-v2', behavior: 'FootballGeneralistV2',
            observations: { size: 54, fields: [] }, actions: { continuous: 5, channels: [] },
        }));
        await writeFile(path.join(root, 'Assets/Resources/Generalist/scenarios.json'), JSON.stringify({
            scenarios: [{ id: 's2-score-basic-v1' }], sceneVersion: 's2', physicsVersion: 'p2',
        }));
        await writeFile(path.join(root, 'ml-agents/config/generalist_curriculum.json'), JSON.stringify({
            held_out_seeds: [515], stages: [{ id: 'S2' }],
        }));
        const dir = path.join(root, 'training-driver-runs', 'old-run');
        await mkdir(dir, { recursive: true });
        const bundle = path.join(dir, 'old.footballpolicy');
        const onnx = path.join(dir, 'old.onnx');
        await writeFile(bundle, 'model bundle');
        await writeFile(onnx, 'model');
        await writeFile(path.join(root, 'football_generalist.py'), '# test fixture');
        await writeFile(path.join(dir, 'policy.json'), JSON.stringify({
            id: 'generalist-musiala-v1', family: 'generalist', behavior: 'FootballGeneralistV2',
            runner_binary: binary, bundle_path: bundle, onnx_path: onnx,
            contract_sha256: 'old-contract', scenario_sha256: 'old-scenarios',
            implementation_sha256: 'old-implementation', view_scenario: oldScenario,
        }));
        const curation = path.join(root, 'validation/generalist');
        await mkdir(curation, { recursive: true });
        const curate = (featured: boolean) => writeFile(path.join(curation, 'policy-curation.json'),
            JSON.stringify({ schema_version: 1, policies: { 'generalist-musiala-v1': { display_name: 'Musiala', featured } } }));
        await curate(true);
        const [policy] = await footballControl(ws(root), { ...input, action: 'generalist_policies' }) as any[];
        assert.equal(policy.display_name, 'Musiala');
        assert.equal(policy.featured, true);
        assert.equal(policy.compatible_metadata, false);
        assert.equal(policy.historical_watch_available, true);
        // Wrong drill and current-version evaluation must both fail closed.
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_watch',
            policyId: 'generalist-musiala-v1', scenario: 's2-score-basic-v1', seed: 515 }),
            (error: any) => error.code === 'INVALID_ARGUMENT');
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_evaluate',
            policyId: 'generalist-musiala-v1', scenario: 's2-score-basic-v1', seed: 515 }),
            (error: any) => error.code === 'INVALID_ARGUMENT');
        const launched = await footballControl(ws(root), { ...input, action: 'generalist_watch',
            policyId: 'generalist-musiala-v1', scenario: oldScenario, seed: 515 }) as any;
        assert.equal(launched.accepted, true);
        assert.equal(launched.action, 'generalist_watch');
        const operations = path.join(root, 'training-driver-runs', 'atlas-generalist-operations');
        const receipt = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(operations, launched.ticket + '.json'), 'utf8'));
        assert.equal(receipt.historical_watch, true);
        assert.equal(receipt.scenario, oldScenario);
        // Clearing curated status revokes the playback permission without removing the model.
        await curate(false);
        const [uncurated] = await footballControl(ws(root), { ...input, action: 'generalist_policies' }) as any[];
        assert.equal(uncurated.historical_watch_available, false);
        await assert.rejects(footballControl(ws(root), { ...input, action: 'generalist_watch',
            policyId: 'generalist-musiala-v1', scenario: oldScenario, seed: 515 }),
            (error: any) => error.code === 'INVALID_ARGUMENT');
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(app, { recursive: true, force: true });
    }
});
