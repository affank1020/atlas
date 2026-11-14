import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AtlasError } from '@atlas/protocol/errors';
import type { Workspace } from '@atlas/protocol/workspace';
import { workspaceOperationSchemas } from '@atlas/protocol/workspace-operations';

type Input = ReturnType<typeof workspaceOperationSchemas.football_control.parse>;
const execFileAsync = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const POLICY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_POLICY_ID = 'football-v1';
const EXECUTABLE_POLICIES: Record<string, { contractId: string; behavior: string; observations: number;
    actions: number; trainer: string; config: string; scene: string; }> = {
    'football-v1': {
        contractId: 'fyp-football-v1', behavior: 'FootballV1', observations: 25, actions: 8,
        trainer: 'poca', config: 'Training/football_v1.yaml', scene: 'Assets/Football/Scenes/OpenGoalClose.unity',
    },
    'football-instruction-v3': {
        contractId: 'football-observation-v3', behavior: 'FootballInstructionV3', observations: 93, actions: 8,
        trainer: 'poca', config: 'Training/football_instruction_v3.yaml', scene: 'Assets/Football/Scenes/OpenGoalClose.unity',
    },
};
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'LOGNAME']
        .filter(name => process.env[name] !== undefined)
        .map(name => [name, process.env[name]]),
);

function safeSource(workspace: Workspace, relative: string) {
    const root = realpathSync(workspace.rootPath);
    const source = path.join(root, relative);
    const resolved = realpathSync(source);
    if (!resolved.startsWith(root + path.sep) || lstatSync(source).isSymbolicLink() ||
        !statSync(resolved).isFile())
        throw new AtlasError('FYP file is not a regular source in its Unity checkout.', 'DRIVER_UNAVAILABLE');
    return resolved;
}

function fypWorkspace(workspace: Workspace) {
    if (workspace.kind !== 'unity' || workspace.status !== 'active' || workspace.name !== 'FYP')
        throw new AtlasError('FYP requires its own registered, active Unity checkout.', 'WORKSPACE_UNAVAILABLE');
}

function fypPolicyRecords(workspace: Workspace) {
    fypWorkspace(workspace);
    const root = realpathSync(workspace.rootPath);
    const directory = path.join(root, 'Training', 'policies');
    if (!existsSync(directory)) {
        const legacyFile = safeSource(workspace, 'Training/atlas_contract.json');
        let legacy: any;
        try { legacy = JSON.parse(readFileSync(legacyFile, 'utf8')); }
        catch { throw new AtlasError('FYP policy catalogue is missing or unreadable.', 'DRIVER_UNAVAILABLE'); }
        if (legacy.contract_id !== 'fyp-football-v1' || legacy.behavior !== 'FootballV1' ||
            legacy.observations?.size !== 25 || legacy.actions?.continuous !== 8)
            throw new AtlasError('FYP policy catalogue is missing and the legacy contract is incompatible.', 'DRIVER_UNAVAILABLE');
        return [{
            record_schema_version: 1, policy_id: DEFAULT_POLICY_ID, display_name: 'FYP Football v1',
            status: 'supported', revision: 1, purpose: 'Legacy contract profile.',
            contract: { contract_id: legacy.contract_id, behavior_name: legacy.behavior,
                observations: { size: legacy.observations.size }, actions: { continuous_count: legacy.actions.continuous } },
            trainer: { algorithm: legacy.trainer_kind }, curriculum: [{ scene_path: legacy.scene }],
            execution_supported: true,
        }];
    }
    if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory() ||
        !realpathSync(directory).startsWith(root + path.sep))
        throw new AtlasError('FYP policy catalogue is unsafe.', 'DRIVER_UNAVAILABLE');
    const ids = new Set<string>();
    const records = readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => {
        if (!/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name) && name !== 'fyp-football-v1.json')
            throw new AtlasError('FYP policy catalogue contains an invalid file name.', 'DRIVER_UNAVAILABLE');
        const file = safeSource(workspace, `Training/policies/${name}`);
        if (statSync(file).size > 256 * 1024) throw new AtlasError('FYP policy record is oversized.', 'DRIVER_UNAVAILABLE');
        let record: any;
        try { record = JSON.parse(readFileSync(file, 'utf8')); }
        catch { throw new AtlasError('FYP policy record is unreadable.', 'DRIVER_UNAVAILABLE'); }
        if (!record || record.record_schema_version !== 1 || !POLICY_ID.test(record.policy_id ?? '') ||
            !['draft', 'supported', 'archived'].includes(record.status) || !Number.isInteger(record.revision) ||
            typeof record.display_name !== 'string' || !record.display_name.trim() ||
            !record.contract || typeof record.contract !== 'object' ||
            !record.contract.observations || !Array.isArray(record.contract.observations.channels) ||
            !record.contract.actions || !Array.isArray(record.contract.actions.channels) ||
            !record.actor || !Number.isInteger(record.actor.decision_period_physics_steps) ||
            !record.actor.network || !record.trainer || typeof record.trainer.settings !== 'object' ||
            !record.runtime || !record.artifacts || !Array.isArray(record.curriculum) ||
            (name !== `${record.policy_id}.json` && !(record.policy_id === DEFAULT_POLICY_ID && name === 'fyp-football-v1.json')))
            throw new AtlasError('FYP policy record does not match the supported schema.', 'DRIVER_UNAVAILABLE');
        if (ids.has(record.policy_id)) throw new AtlasError('FYP policy catalogue has a duplicate policy ID.', 'DRIVER_UNAVAILABLE');
        ids.add(record.policy_id);
        const executable = EXECUTABLE_POLICIES[record.policy_id];
        const observationsCoverContract = (() => {
            if (!Array.isArray(record.contract.observations.channels)) return false;
            const channels = [...record.contract.observations.channels].sort((a, b) => a.start - b.start);
            let next = 0;
            for (const channel of channels) {
                if (!Number.isInteger(channel.start) || !Number.isInteger(channel.size) || channel.size < 1 || channel.start !== next)
                    return false;
                next += channel.size;
            }
            return next === record.contract.observations.size;
        })();
        const actionsCoverContract = (() => {
            if (!Array.isArray(record.contract.actions.channels)) return false;
            const channels = [...record.contract.actions.channels].sort((a, b) => a.index - b.index);
            return channels.length === record.contract.actions.continuous_count &&
                channels.every((channel, index) => channel.index === index) &&
                (record.contract.actions.discrete_branches?.length ?? 0) === 0;
        })();
        const executionSupported = !!executable && record.status === 'supported' &&
            record.contract.contract_id === executable.contractId &&
            record.contract.behavior_name === executable.behavior &&
            record.contract.observations?.size === executable.observations &&
            record.contract.observations?.stacked_vectors === 1 &&
            record.contract.actions?.continuous_count === executable.actions &&
            record.trainer?.algorithm === executable.trainer &&
            record.trainer?.config_path === executable.config &&
            record.curriculum?.[0]?.scene_path === executable.scene &&
            record.actor?.decision_period_physics_steps === 5 &&
            record.actor?.memory === 'feed_forward' &&
            observationsCoverContract && actionsCoverContract;
        return { ...record, execution_supported: executionSupported };
    });
    if (!records.some(record => record.policy_id === DEFAULT_POLICY_ID))
        throw new AtlasError('FYP policy catalogue does not contain Football v1.', 'DRIVER_UNAVAILABLE');
    return records;
}

/** Separate, fail-closed ABIs. Each executable policy has an explicit runtime registration. */
export function fypManifest(workspace: Workspace, policyId = DEFAULT_POLICY_ID) {
    fypWorkspace(workspace);
    if (!POLICY_ID.test(policyId)) throw new AtlasError('Invalid FYP policy ID.', 'INVALID_ARGUMENT');
    const policies = fypPolicyRecords(workspace);
    const policy = policies.find(record => record.policy_id === policyId);
    if (!policy) throw new AtlasError('FYP policy was not found.', 'NOT_FOUND');
    let legacyData: any = null;
    if (policy.execution_supported) {
        try {
            const executable = EXECUTABLE_POLICIES[policy.policy_id];
            if (!executable) throw new Error('Policy is not registered for execution');
            const config = readFileSync(safeSource(workspace, executable.config), 'utf8');
            if (!config.includes(`  ${executable.behavior}:`) ||
                !new RegExp(`trainer_type:\\s*${executable.trainer}\\b`).test(config))
                throw new Error('Trainer configuration does not match the registered policy');
            const scene = readFileSync(safeSource(workspace, executable.scene), 'utf8');
            const prefab = readFileSync(safeSource(workspace, 'Assets/Football/Prefabs/Player.prefab'), 'utf8');
            if (policy.policy_id === DEFAULT_POLICY_ID) {
                const file = safeSource(workspace, 'Training/atlas_contract.json');
                if (statSync(file).size > 32 * 1024) throw new Error('Oversized contract');
                legacyData = JSON.parse(readFileSync(file, 'utf8'));
                if (legacyData.contract_id !== executable.contractId ||
                    legacyData.behavior !== executable.behavior ||
                    legacyData.observations?.size !== executable.observations ||
                    legacyData.actions?.continuous !== executable.actions ||
                    legacyData.source_project !== 'affank1020/FYP' || legacyData.trainer_kind !== executable.trainer ||
                    legacyData.scene !== executable.scene)
                    throw new Error('Supported policy and runtime contract differ');
                const prefabTokens = [`VectorObservationSize: ${executable.observations}`,
                    `m_NumContinuousActions: ${executable.actions}`, `m_BehaviorName: ${executable.behavior}`,
                    `DecisionPeriod: ${policy.actor.decision_period_physics_steps}`];
                if (!prefabTokens.every(token => prefab.includes(token)))
                    throw new Error('FYP prefab has a different observation/action contract');
            } else {
                const sceneOverrides = [
                    `propertyPath: m_BehaviorName\n      value: ${executable.behavior}`,
                    `propertyPath: m_BrainParameters.VectorObservationSize\n      value: ${executable.observations}`,
                ];
                if (!sceneOverrides.every(token => scene.includes(token)) ||
                    !prefab.includes(`m_NumContinuousActions: ${executable.actions}`) ||
                    !prefab.includes(`DecisionPeriod: ${policy.actor.decision_period_physics_steps}`))
                    throw new Error('FYP open-goal scene or shared prefab has a different v3 ABI');
            }
        } catch (error) {
            if (error instanceof AtlasError) throw error;
            throw new AtlasError('FYP policy, runtime contract, or prefab is incompatible.', 'DRIVER_UNAVAILABLE');
        }
    }
    return {
        available: true, policy, policies,
        execution_supported: policy.execution_supported,
        contract: {
            contract_id: policy.contract.contract_id,
            behavior: policy.contract.behavior_name,
            observations: { size: policy.contract.observations?.size },
            actions: { continuous: policy.contract.actions?.continuous_count },
            scene: policy.curriculum?.[0]?.scene_path ?? legacyData?.scene,
            trainer_kind: policy.trainer?.algorithm,
        },
        provenance: 'policy-record; execution support is checked separately from documentation',
    };
}

function bridge(workspace: Workspace) {
    fypManifest(workspace);
    return safeSource(workspace, 'Training/atlas_fyp.py');
}

async function python(workspace: Workspace, argv: string[]): Promise<any> {
    const file = bridge(workspace);
    const { stdout } = await execFileAsync('python3', [file, ...argv], {
        cwd: workspace.rootPath, env: cleanEnv(), shell: false,
        maxBuffer: 512 * 1024, timeout: 90_000,
    });
    try { return JSON.parse(stdout); }
    catch { throw new AtlasError('FYP driver returned invalid JSON.', 'DRIVER_UNAVAILABLE'); }
}

function operationsDir(workspace: Workspace) {
    const root = realpathSync(workspace.rootPath);
    const state = path.join(root, '.atlas-fyp');
    if (existsSync(state) && (lstatSync(state).isSymbolicLink() ||
        realpathSync(state) !== state))
        throw new AtlasError('Unsafe FYP state directory.', 'INVALID_ARGUMENT');
    const directory = path.join(state, 'operations');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory)
        throw new AtlasError('Unsafe FYP operations directory.', 'INVALID_ARGUMENT');
    return directory;
}

function launch(workspace: Workspace, action: 'fyp_build' | 'fyp_train' | 'fyp_evaluate', argv: string[], runId?: string) {
    const file = bridge(workspace);
    const directory = operationsDir(workspace);
    const ticket = randomUUID();
    const outFile = path.join(directory, ticket + '.out');
    const errFile = path.join(directory, ticket + '.err');
    const out = openSync(outFile, 'wx', 0o600);
    const err = openSync(errFile, 'wx', 0o600);
    let pid: number | undefined;
    try {
        const child = spawn('python3', [file, ...argv], {
            cwd: workspace.rootPath, env: cleanEnv(), detached: true,
            shell: false, stdio: ['ignore', out, err],
        });
        child.on('error', error => {
            try { writeFileSync(errFile, String(error.message).slice(0, 1000)); } catch {}
        });
        pid = child.pid;
        if (!pid) throw new AtlasError('Unable to launch FYP driver.', 'DRIVER_UNAVAILABLE');
        child.unref();
    } finally { closeSync(out); closeSync(err); }
    writeFileSync(path.join(directory, ticket + '.json'),
        JSON.stringify({ ticket, action, run_id: runId ?? null, pid, started_at: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600 });
    return { accepted: true, ticket, run_id: runId ?? null, action, status: 'launching',
        note: 'Accepted locally; inspect FYP run or operation status. This does not prove training or build success.' };
}

function safeReceiptText(file: string): string {
    if (!existsSync(file)) return '';
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024)
        throw new AtlasError('Unsafe or oversized FYP operation receipt.', 'INVALID_ARGUMENT');
    return readFileSync(file, 'utf8');
}

function taskStatus(workspace: Workspace, id: string) {
    if (!UUID.test(id)) throw new AtlasError('Invalid FYP ticket.', 'INVALID_ARGUMENT');
    const dir = operationsDir(workspace);
    const base = path.join(dir, id);
    if (!existsSync(base + '.json')) throw new AtlasError('FYP ticket not found.', 'NOT_FOUND');
    const info = JSON.parse(safeReceiptText(base + '.json'));
    if (info.ticket !== id || !['fyp_build','fyp_train','fyp_evaluate'].includes(info.action))
        throw new AtlasError('Invalid FYP operation receipt.', 'INVALID_ARGUMENT');
    const output = safeReceiptText(base + '.out').slice(-4000);
    const error = safeReceiptText(base + '.err').slice(-4000);
    let result: any = null;
    try { result = JSON.parse(output.trim().split('\n').at(-1) ?? ''); } catch {}
    let alive = false;
    if (Number.isInteger(info.pid) && info.pid > 1) {
        try { process.kill(info.pid, 0); alive = true; } catch {}
    }
    return { ticket: id, action: info.action, run_id: info.run_id, result,
        status: result?.state === 'failed' ? 'failed' :
            result?.completed === true || result?.state === 'completed' ? 'completed' :
            alive ? 'running' : 'failed_or_unknown',
        output, error, note: result ? 'Completed command; assess resulting artifacts separately.' :
            'No completion receipt. Process status alone does not establish success.' };
}

export async function fypOperation(workspace: Workspace, x: Input): Promise<unknown> {
    const policyArgs = x.policyId ? ['--policy-id', x.policyId] : [];
    if (x.action === 'fyp_policies') return fypPolicyRecords(workspace);
    if (x.action === 'fyp_manifest') return fypManifest(workspace, x.policyId ?? DEFAULT_POLICY_ID);
    if (x.action === 'fyp_preflight') return python(workspace, ['preflight', ...policyArgs]);
    if (x.action === 'fyp_runs') return python(workspace, ['runs', ...policyArgs]);
    if (x.action === 'fyp_checkpoint_note') {
        if (!x.runId || !/^fyp-[a-f0-9-]{36}$/.test(x.runId) || x.notes === undefined)
            throw new AtlasError('FYP checkpoint notes require a valid run ID and notes text.', 'INVALID_ARGUMENT');
        return python(workspace, ['checkpoint-note', '--run-id', x.runId, ...policyArgs, '--notes=' + x.notes]);
    }
    if (x.action === 'fyp_evaluations') return python(workspace, ['evaluations', ...policyArgs]);
    if (x.action === 'fyp_environments') return python(workspace, ['environments']);
    if (x.action === 'fyp_status') {
        if (!x.runId || !/^fyp-[a-f0-9-]{36}$/.test(x.runId))
            throw new AtlasError('Valid FYP run ID required.', 'INVALID_ARGUMENT');
        return python(workspace, ['status', '--run-id', x.runId, ...policyArgs]);
    }
    if (x.action === 'fyp_task_status') {
        if (!x.runId) throw new AtlasError('FYP task ticket required.', 'INVALID_ARGUMENT');
        return taskStatus(workspace, x.runId);
    }
    if (x.action === 'fyp_build') return launch(workspace, 'fyp_build', ['build', ...policyArgs]);
    if (x.action === 'fyp_train') {
        if (!['smoke','pilot_50k'].includes(x.preset ?? '') || x.seed === undefined)
            throw new AtlasError('FYP training requires an approved preset and seed.', 'INVALID_ARGUMENT');
        const readiness = await python(workspace, ['preflight', ...policyArgs]);
        if (readiness?.ready_to_train !== true)
            throw new AtlasError('FYP preflight failed: configure the trainer and open the selected policy environment in Edit Mode. Atlas will start the learner; then press Play to connect.', 'DRIVER_UNAVAILABLE');
        const runId = 'fyp-' + randomUUID();
        return launch(workspace, 'fyp_train',
            ['train', '--run-id', runId, '--preset', x.preset!,
                '--seed', String(x.seed), ...policyArgs], runId);
    }
    if (x.action === 'fyp_evaluate') {
        if (!x.runId || !/^fyp-[a-f0-9-]{36}$/.test(x.runId) ||
            x.episodes === undefined || x.episodes < 1 || x.episodes > 100 || x.seed === undefined)
            throw new AtlasError('FYP evaluation requires a completed run ID, 1–100 episodes and seed.', 'INVALID_ARGUMENT');
        const readiness = await python(workspace, ['preflight', ...policyArgs]);
        if (readiness?.ready_to_train !== true)
            throw new AtlasError('FYP preflight failed: open the FYP training scene in Unity Edit Mode; stop Play Mode before requesting evaluation.', 'DRIVER_UNAVAILABLE');
        const evaluationId = 'fyp-eval-' + randomUUID();
        return launch(workspace, 'fyp_evaluate',
            ['evaluate', '--evaluation-id', evaluationId, '--run-id', x.runId,
                '--episodes', String(x.episodes), '--seed', String(x.seed), ...policyArgs], x.runId);
    }
    throw new AtlasError('Unsupported FYP operation.', 'INVALID_ARGUMENT');
}
