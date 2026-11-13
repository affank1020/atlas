import { useCallback, useEffect, useMemo, useState } from 'react';
import { callTool } from './api';
import { FypV1Evidence } from './FypV1Evidence';
import type { FypEnvironment } from './FypEnvironmentCatalog';

type FypManifest = { available: boolean; contract: { contract_id: string; behavior: string; observations: { size: number }; actions: { continuous: number }; scene: string; trainer_kind: string } };
type FypPreflight = {
    editor_available: boolean; editor_open: boolean; editor_playing: boolean; editor_compiling?: boolean;
    trainer_connected: boolean; trainer_available: boolean; editor_ready: boolean; scene_ready: boolean; active_scene: string | null;
    active_environment?: FypEnvironment | null; selected_environment?: FypEnvironment | null;
    environment_present: boolean; episode: number | null; goals: number | null; last_outcome: string | null;
    episodes_completed: number | null; recent_episodes: { session_id: string; sequence: number; episode: number; seed: number; goals: number; elapsed_seconds: number; outcome: string; trainer_connected: boolean }[];
    heartbeat_age_seconds: number | null; verified_build: boolean; ready_to_train: boolean;
    source_sha256: string; note: string;
};
type FypRun = { run_id: string; preset: string; steps: number; seed: number; state: string; source_sha256: string; exported_model?: boolean; model_sha256?: string | null; checkpoint_sha256?: string | null; environment?: FypEnvironment; started_at?: string; error?: string };
type FypEvaluation = { evaluation_id: string; training_run_id: string; state: string; requested_episodes: number; episodes_completed?: number; goals_scored?: number; goal_rate?: number; seed?: number; training_environment?: FypEnvironment; evaluation_environment?: FypEnvironment; started_at?: string; error?: string };
type FypTicket = { accepted?: boolean; ticket: string; run_id?: string | null; action: string; status: string; result?: unknown; error?: string; note?: string };

const ACTIVE_STATES = new Set(['accepted', 'pending', 'queued', 'dispatching', 'launching', 'starting', 'active', 'running', 'cancelling', 'unknown', 'incomplete']);
const HEARTBEAT_MAX_AGE_SECONDS = 15;
const OPERATION_STORAGE_KEY = 'atlas.football.fyp.operation';
const CHECKPOINT_REVIEW_KEY = 'atlas.football.fyp.checkpoint-reviews';
const isActive = (state?: string) => !!state && ACTIVE_STATES.has(state.toLowerCase());
const sceneName = (path?: string | null) => path?.split('/').pop()?.replace(/\.unity$/i, '') || 'FYP scene';

function readSavedTicket(): FypTicket | null {
    try {
        if (typeof window === 'undefined') return null;
        const value = JSON.parse(window.sessionStorage.getItem(OPERATION_STORAGE_KEY) || 'null') as Partial<FypTicket> | null;
        return value && typeof value.ticket === 'string' && typeof value.action === 'string' && typeof value.status === 'string'
            ? value as FypTicket : null;
    } catch { return null; }
}

function readCheckpointReviews(): Record<string, 'keep' | 'discard'> {
    try {
        const saved = window.localStorage.getItem(CHECKPOINT_REVIEW_KEY);
        const parsed = saved ? JSON.parse(saved) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, 'keep' | 'discard'] =>
            entry[1] === 'keep' || entry[1] === 'discard'));
    } catch { return {}; }
}

export function FypV1Experience({ onOpenEnvironment }: { onOpenEnvironment?: (environmentId: string) => void }) {
    const [manifest, setManifest] = useState<FypManifest | null>(null);
    const [preflight, setPreflight] = useState<FypPreflight | null>(null);
    const [runs, setRuns] = useState<FypRun[]>([]);
    const [evaluations, setEvaluations] = useState<FypEvaluation[]>([]);
    const [environments, setEnvironments] = useState<FypEnvironment[]>([]);
    const [selectedEnvironmentId, setSelectedEnvironmentId] = useState('');
    const [evaluationEnvironmentId, setEvaluationEnvironmentId] = useState('');
    const [seed, setSeed] = useState(63);
    const [evaluationSeed, setEvaluationSeed] = useState(515);
    const [evaluationEpisodes, setEvaluationEpisodes] = useState(10);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [ticket, setTicket] = useState<FypTicket | null>(readSavedTicket);
    const [loading, setLoading] = useState(true);
    const [checkpointReviews, setCheckpointReviews] = useState<Record<string, 'keep' | 'discard'>>(readCheckpointReviews);

    const refresh = useCallback(async () => {
        try {
            const [m, p, r, e, envs] = await Promise.all([
                callTool<FypManifest>('football_fyp_manifest'),
                // Preflight describes the scene that is open now. Training still checks
                // its chosen environment separately, while evaluation may target a
                // different scene from the one selected for the next training run.
                callTool<FypPreflight>('football_fyp_preflight'),
                callTool<FypRun[]>('football_fyp_runs'),
                callTool<FypEvaluation[]>('football_fyp_evaluations'),
                callTool<FypEnvironment[]>('football_fyp_environments'),
            ]);
            setManifest(m); setPreflight(p); setRuns(r); setEvaluations(e); setEnvironments(envs); setError('');
            const fallbackEnvironment = p.active_environment?.environment_id ?? envs[0]?.environment_id ?? '';
            if (!selectedEnvironmentId || !envs.some(environment => environment.environment_id === selectedEnvironmentId))
                setSelectedEnvironmentId(fallbackEnvironment);
            if (!evaluationEnvironmentId || !envs.some(environment => environment.environment_id === evaluationEnvironmentId))
                setEvaluationEnvironmentId(fallbackEnvironment);
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setLoading(false); }
    }, [evaluationEnvironmentId, selectedEnvironmentId]);
    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => { void refresh(); }, 3000);
        return () => window.clearInterval(timer);
    }, [refresh]);
    useEffect(() => {
        if (!ticket) return;
        try {
            if (isActive(ticket.status)) window.sessionStorage.setItem(OPERATION_STORAGE_KEY, JSON.stringify(ticket));
            else window.sessionStorage.removeItem(OPERATION_STORAGE_KEY);
        } catch { /* The live page can still inspect the receipt if session storage is unavailable. */ }
    }, [ticket]);

    const pollTicket = useCallback(async () => {
        if (!ticket?.ticket) return;
        try {
            const response = await callTool<FypTicket>('football_fyp_task_status', { runId: ticket.ticket });
            setTicket(response);
            if (!isActive(response.status)) {
                const operation = response.action === 'fyp_evaluate' ? 'Evaluation' : 'Training';
                setNotice(response.status === 'completed'
                    ? `${operation} completed. See the recorded receipt below.`
                    : `${operation} ended with state “${response.status}”. Review the receipt and Unity status.`);
                await refresh();
            }
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    }, [refresh, ticket?.ticket]);
    useEffect(() => {
        if (!ticket?.ticket || !isActive(ticket.status)) return;
        const timer = window.setInterval(() => { void pollTicket(); }, 2500);
        return () => window.clearInterval(timer);
    }, [pollTicket, ticket?.status, ticket?.ticket]);

    const activeRun = useMemo(() => runs.find(run => isActive(run.state)), [runs]);
    const activeEvaluation = useMemo(() => evaluations.find(evaluation => isActive(evaluation.state)), [evaluations]);
    const activeTicket = isActive(ticket?.status) ? ticket : null;
    const requestedAction = activeTicket?.action ?? (activeRun ? 'fyp_train' : activeEvaluation ? 'fyp_evaluate' : null);
    const selectedEnvironment = environments.find(environment => environment.environment_id === selectedEnvironmentId);
    const selectedEvaluationEnvironment = environments.find(environment => environment.environment_id === evaluationEnvironmentId);
    const sceneMatches = !!selectedEnvironment && preflight?.active_environment?.environment_id === selectedEnvironment.environment_id && !!preflight?.scene_ready;
    const evaluationSceneMatches = !!selectedEvaluationEnvironment && preflight?.active_environment?.environment_id === selectedEvaluationEnvironment.environment_id;
    const heartbeatFresh = preflight?.heartbeat_age_seconds != null && preflight.heartbeat_age_seconds <= HEARTBEAT_MAX_AGE_SECONDS;
    const editorReady = !!preflight?.editor_ready && !!preflight.editor_open &&
        !preflight.editor_compiling && !!preflight.trainer_available && !preflight.editor_playing && heartbeatFresh;
    const operationActive = !!activeTicket || !!activeRun || !!activeEvaluation;
    const canStartTraining = editorReady && sceneMatches && !operationActive && !busy;
    const canEvaluate = editorReady && evaluationSceneMatches && !activeTicket && !activeRun && !activeEvaluation && !busy;
    const completedRuns = useMemo(() => runs.filter(run => run.state === 'completed' && run.exported_model === true), [runs]);

    let readinessMessage = 'Checking Unity status…';
    let readinessTone = 'pending';
    if (loading && !preflight) readinessMessage = 'Checking Unity status…';
    else if (!preflight) { readinessMessage = 'Unity status unavailable'; readinessTone = 'warning'; }
    else if (requestedAction) {
        readinessTone = 'active';
        if (preflight.trainer_connected && requestedAction === 'fyp_train') readinessMessage = 'Training in Unity';
        else if (preflight.trainer_connected && requestedAction === 'fyp_evaluate') readinessMessage = 'Evaluating checkpoint in Unity';
        else if (!preflight.editor_open) readinessMessage = `${requestedAction === 'fyp_evaluate' ? 'Evaluation' : 'Training'} requested · Unity closed`;
        else if (preflight.editor_playing) readinessMessage = 'Play Mode · waiting for trainer connection';
        else readinessMessage = `${requestedAction === 'fyp_evaluate' ? 'Evaluation' : 'Training'} requested · press Play`;
    } else if (!manifest?.available) { readinessMessage = 'FYP Football contract unavailable'; readinessTone = 'warning'; }
    else if (environments.length === 0) { readinessMessage = 'No Unity environments in the catalogue'; readinessTone = 'warning'; }
    else if (!preflight.editor_open) { readinessMessage = 'Unity closed · idle'; readinessTone = 'pending'; }
    else if (preflight.editor_playing && preflight.environment_present) { readinessMessage = 'Manual Play · keyboard controlled'; readinessTone = 'active'; }
    else if (!sceneMatches) { readinessMessage = selectedEnvironment ? `Open ${selectedEnvironment.name} in Unity` : 'Select a training environment'; readinessTone = 'warning'; }
    else if (preflight.editor_compiling) { readinessMessage = 'Wait for Unity compilation to finish'; readinessTone = 'warning'; }
    else if (!preflight.trainer_available) { readinessMessage = 'ML-Agents trainer is unavailable'; readinessTone = 'warning'; }
    else if (!heartbeatFresh) { readinessMessage = 'Waiting for a fresh Unity heartbeat'; readinessTone = 'warning'; }
    else if (preflight.editor_playing) { readinessMessage = 'Manual Play · no model attached'; readinessTone = 'active'; }
    else if (!preflight.ready_to_train) { readinessMessage = preflight.note || 'Atlas preflight has not approved this operation'; readinessTone = 'warning'; }
    else { readinessMessage = 'Unity open · idle · ready to run'; readinessTone = 'ready'; }

    const operationDescription = activeTicket
        ? preflight?.trainer_connected ? 'Unity is connected to the active Atlas operation.'
            : preflight?.editor_playing ? 'The editor is running. Atlas is waiting for the ML-Agents connection.'
                : 'In the FYP Unity Editor, press Play to connect the trainer.'
        : activeRun ? `${activeRun.preset === 'smoke' ? 'Smoke run' : activeRun.preset === 'pilot_50k' ? '50k pilot' : activeRun.preset} · seed ${activeRun.seed}`
            : activeEvaluation ? `Checkpoint evaluation · ${activeEvaluation.episodes_completed ?? 0}/${activeEvaluation.requested_episodes} episodes`
                : preflight?.editor_playing ? 'The Unity scene is running without a requested Atlas operation. Keyboard controls remain active.'
                    : `${selectedEnvironment?.name ?? 'A catalogued environment'} is selected. Atlas starts the learner; Unity connects when you press Play.`;

    const perform = async (operation: 'smoke' | 'pilot_50k') => {
        setBusy(operation); setError(''); setNotice('');
        try {
            const response = await callTool<FypTicket>('football_fyp_train', { preset: operation, seed, environmentId: selectedEnvironmentId });
            setTicket(response);
            setNotice('Learner request accepted. Press Play in the FYP Unity Editor to connect it.');
            await refresh();
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(''); }
    };
    const evaluateRun = async (runId: string) => {
        setBusy(`evaluate:${runId}`); setError(''); setNotice('');
        try {
            const response = await callTool<FypTicket>('football_fyp_evaluate', { runId, episodes: evaluationEpisodes, seed: evaluationSeed, environmentId: evaluationEnvironmentId });
            setTicket(response);
            setNotice('Evaluation request accepted. Press Play in the FYP Unity Editor when Atlas reports that the checkpoint runner is ready.');
            await refresh();
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(''); }
    };

    const updateCheckpointReview = (runId: string, value: 'keep' | 'discard' | null) => {
        const next = { ...checkpointReviews };
        if (value) next[runId] = value;
        else delete next[runId];
        try { window.localStorage.setItem(CHECKPOINT_REVIEW_KEY, JSON.stringify(next)); }
        catch { setError('Checkpoint review could not be saved in this browser.'); return; }
        setCheckpointReviews(next);
    };

    const refreshNow = async () => {
        setBusy('refresh');
        try { await refresh(); }
        finally { setBusy(''); }
    };

    return <div className="fg-stack fyp-experience" aria-label="FYP Football editor-first training">
        {error && <p className="fg-error" role="alert">{error}</p>}
        {notice && <p className="fg-notice" role="status">{notice}</p>}

        <section className={`fg-panel fyp-readiness fyp-${readinessTone}`} aria-labelledby="fyp-readiness-title">
            <div className="fyp-readiness-header">
                <div>
                    <h2 id="fyp-readiness-title">{readinessMessage}</h2>
                </div>
                <button className="fg-button" type="button" onClick={() => void refreshNow()} disabled={!!busy}>
                    {busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}
                </button>
            </div>
            <p className="fyp-status-context">{!preflight ? 'Reading the FYP Editor connection.' : preflight.editor_open
                ? `${sceneMatches ? sceneName(preflight.active_scene) : preflight.active_scene ? 'Wrong Unity scene' : 'Scene not loaded'} · ${preflight.editor_playing ? 'Play Mode' : 'Edit Mode'}${preflight.trainer_connected ? ' · trainer connected' : ''}`
                : preflight.editor_available ? 'FYP Editor is installed but closed.' : 'FYP Editor is unavailable.'}</p>
            {operationActive && <div className="fyp-live-summary" role="status">
                <strong>{activeTicket ? 'Current operation' : activeRun ? 'Active training run' : 'Active evaluation'}</strong>
                <span>{operationDescription}</span>
                {preflight?.environment_present && <span className="fyp-live-metrics">
                    Episode {preflight.episode ?? '—'} · Completed {preflight.episodes_completed ?? '—'} · Goals {preflight.goals ?? '—'} · Last outcome {preflight.last_outcome ?? '—'}
                </span>}
                {activeTicket && <span className="fyp-ticket">{activeTicket.action === 'fyp_evaluate' ? 'Evaluation' : 'Training'} · {activeTicket.status}</span>}
                {activeTicket?.error && <span className="fg-error">{activeTicket.error}</span>}
            </div>}
            {!operationActive && preflight?.environment_present && <div className="fyp-live-summary">
                <strong>Latest Unity activity</strong>
                <span>Episode {preflight.episode ?? '—'} · {preflight.episodes_completed ?? 0} completed · {preflight.goals ?? 0} goals · {preflight.last_outcome ?? 'No recent outcome'}</span>
            </div>}
            {ticket && !activeTicket && <div className="fyp-live-summary" aria-label="Latest operation receipt">
                <strong>Latest operation · {ticket.status}</strong>
                <span>{ticket.action === 'fyp_evaluate' ? 'Checkpoint evaluation' : 'Training'} operation</span>
                {ticket.error && <span className="fg-error">{ticket.error}</span>}
            </div>}
            <details className="fyp-contract-details">
                <summary>Unity diagnostics and experiment details</summary>
                <div className="fyp-contract-grid">
                    <span>Compilation <strong>{!preflight ? 'Checking' : preflight.editor_compiling ? 'In progress' : 'Ready'}</strong></span>
                    <span>Trainer <strong>{!preflight ? 'Checking' : preflight.trainer_available ? 'Available' : 'Unavailable'}</strong></span>
                    <span>Connection <strong>{preflight?.trainer_connected ? 'Connected' : activeTicket ? preflight?.editor_playing ? 'Connecting' : 'Waiting for Play' : 'Not requested'}</strong></span>
                    <span>Heartbeat <strong>{!preflight ? 'Checking' : preflight.heartbeat_age_seconds == null ? 'Unknown' : heartbeatFresh ? `${Math.round(preflight.heartbeat_age_seconds)}s ago` : 'Stale'}</strong></span>
                    <span>Behavior <strong>{manifest?.contract.behavior ?? 'Loading'}</strong></span>
                    <span>Observations <strong>{manifest?.contract.observations.size ?? '—'}</strong></span>
                    <span>Continuous actions <strong>{manifest?.contract.actions.continuous ?? '—'}</strong></span>
                    <span>Trainer <strong>{manifest?.contract.trainer_kind ?? '—'}</strong></span>
                    <span>Scene <strong>{manifest?.contract.scene ?? 'Workspace unavailable'}</strong></span>
                    <span>Source <strong>{preflight?.source_sha256?.slice(0, 14) ?? '—'}</strong></span>
                </div>
                <p className="fg-muted">Training creates a candidate checkpoint. Evaluation and review are separate.</p>
            </details>
        </section>

        <section className="fg-panel fyp-checkpoint-panel" aria-label="Policy checkpoints">
            <div className="fyp-checkpoint-header">
                <div className="fg-panel-title">
                    <div className="fyp-checkpoint-heading"><h2>Policy checkpoints</h2><span>{completedRuns.length} available · {runs.length} training runs recorded</span></div>
                </div>
                <div className="fyp-evaluation-settings">
                    <label className="fyp-field">Environment
                        <select aria-label="FYP evaluation environment" value={evaluationEnvironmentId} onChange={event => setEvaluationEnvironmentId(event.target.value)}>
                            {environments.map(environment => <option key={environment.environment_id} value={environment.environment_id}>{environment.name}</option>)}
                        </select>
                    </label>
                    <label className="fyp-field">Episodes
                        <input aria-label="FYP evaluation episodes" type="number" min={1} max={100} step={1} value={evaluationEpisodes} onChange={event => setEvaluationEpisodes(Math.max(1, Math.min(100, Math.floor(Number(event.target.value) || 1))))} />
                    </label>
                    <label className="fyp-field">Seed
                        <input aria-label="FYP evaluation seed" type="number" min={0} max={2147483647} step={1} value={evaluationSeed} onChange={event => setEvaluationSeed(Math.max(0, Math.min(2147483647, Math.floor(Number(event.target.value) || 0))))} />
                    </label>
                </div>
            </div>
            <p className="fg-muted">Each card is an exported policy checkpoint. Choose the target environment for evaluation.</p>
            {completedRuns.length === 0 ? <p className="fg-muted">Completed training runs with an exported checkpoint will appear here.</p> :
                <ul className="fyp-checkpoint-list">{completedRuns.map(run => {
                    const runEvaluations = evaluations.filter(evaluation => evaluation.training_run_id === run.run_id);
                    const runIsActive = runEvaluations.some(evaluation => isActive(evaluation.state));
                    const review = checkpointReviews[run.run_id];
                    const reviewLabel = review === 'keep' ? 'Keep' : review === 'discard' ? 'Discard' : 'Unreviewed';
                    return <li className="fyp-checkpoint-row" key={run.run_id}>
                        <div className="fyp-checkpoint-summary">
                            <div className="fyp-checkpoint-title">
                                <strong>Policy checkpoint · {run.preset === 'smoke' ? 'Smoke run' : run.preset === 'pilot_50k' ? '50k pilot' : run.preset}</strong>
                                <span className="fyp-state fyp-state-completed">Available</span>
                                <span className={`fyp-review-tag fyp-review-${review ?? 'unreviewed'}`}>{reviewLabel}</span>
                            </div>
                            <p>{run.started_at ? new Date(run.started_at).toLocaleString() : 'Time not recorded'} · Seed {run.seed} · {run.steps.toLocaleString()} steps</p>
                            {run.environment && <p>Trained in {run.environment.name} · {run.environment.snapshot_recorded === false ? 'historical settings not recorded' : `version ${run.environment.version}`}</p>}
                            {run.environment && <button className="fg-link" type="button" onClick={() => onOpenEnvironment?.(run.environment!.environment_id)}>{run.environment.snapshot_recorded === false ? 'View current environment →' : 'View environment →'}</button>}
                            {runEvaluations.length > 0 && <p>{runEvaluations.length} evaluation{runEvaluations.length === 1 ? '' : 's'} recorded</p>}
                            {run.error && <p className="fg-error">{run.error}</p>}
                            <div className="fyp-checkpoint-review" role="group" aria-label={`Review checkpoint from ${run.preset} run`}>
                                <button className="fg-button" type="button" aria-pressed={review === 'keep'} onClick={() => updateCheckpointReview(run.run_id, review === 'keep' ? null : 'keep')}>{review === 'keep' ? 'Kept' : 'Keep'}</button>
                                <button className="fg-button" type="button" aria-pressed={review === 'discard'} onClick={() => updateCheckpointReview(run.run_id, review === 'discard' ? null : 'discard')}>{review === 'discard' ? 'Discarded' : 'Discard'}</button>
                            </div>
                        </div>
                        <button className="fg-button primary" type="button" disabled={!canEvaluate || runIsActive} onClick={() => void evaluateRun(run.run_id)}>
                            {busy === `evaluate:${run.run_id}` ? 'Starting evaluation…' : `Evaluate ${evaluationEpisodes} episodes`}
                        </button>
                    </li>;
                })}</ul>}
            {completedRuns.length > 0 && <p className="fg-muted fyp-candidate-note">Keep and Discard are saved in this browser. They record your review and do not delete or alter checkpoint files.</p>}
        </section>

        <FypV1Evidence runs={runs} evaluations={evaluations} onOpenEnvironment={onOpenEnvironment} />

        <details className="fg-panel fyp-training-panel">
            <summary><h2>New training run</h2><span>Smoke or 50k pilot</span></summary>
            <p className="fg-muted">Start with the FYP scene open in Edit Mode, then press Play in Unity to connect the learner.</p>
            <label className="fyp-field">Training environment
                <select aria-label="FYP training environment" value={selectedEnvironmentId} onChange={event => setSelectedEnvironmentId(event.target.value)}>
                    {environments.map(environment => <option key={environment.environment_id} value={environment.environment_id}>{environment.name}</option>)}
                </select>
            </label>
            <label className="fyp-field">Seed
                <input aria-label="FYP training seed" type="number" min={0} max={2147483647} step={1} value={seed} onChange={event => setSeed(Math.max(0, Math.min(2147483647, Math.floor(Number(event.target.value) || 0))))} />
            </label>
            <div className="fg-actions fyp-launch-actions">
                <button className="fg-button" type="button" disabled={!canStartTraining} onClick={() => void perform('smoke')}>
                    {busy === 'smoke' ? 'Starting smoke run…' : 'Start smoke run · 2,048 steps'}
                </button>
                <button className="fg-button" type="button" disabled={!canStartTraining} onClick={() => void perform('pilot_50k')}>
                    {busy === 'pilot_50k' ? 'Starting pilot…' : 'Start 50k pilot'}
                </button>
            </div>
            {!canStartTraining && <p className="fyp-blocker" role="status">{operationActive ? 'A FYP operation is already active.' : busy ? 'Refreshing current operation status.' : readinessMessage}</p>}
        </details>
    </div>;
}
