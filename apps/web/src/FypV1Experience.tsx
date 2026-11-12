import { useCallback, useEffect, useMemo, useState } from 'react';
import { callTool } from './api';

type FypManifest = { available: boolean; contract: { contract_id: string; behavior: string; observations: { size: number }; actions: { continuous: number }; scene: string; trainer_kind: string } };
type FypPreflight = {
    editor_available: boolean; editor_open: boolean; editor_playing: boolean; editor_compiling?: boolean;
    trainer_connected: boolean; trainer_available: boolean; scene_ready: boolean; active_scene: string | null;
    environment_present: boolean; episode: number | null; goals: number | null; last_outcome: string | null;
    episodes_completed: number | null; recent_episodes: { session_id: string; sequence: number; episode: number; seed: number; goals: number; elapsed_seconds: number; outcome: string; trainer_connected: boolean }[];
    heartbeat_age_seconds: number | null; verified_build: boolean; ready_to_train: boolean;
    source_sha256: string; note: string;
};
type FypRun = { run_id: string; preset: string; steps: number; seed: number; state: string; source_sha256: string; exported_model?: boolean; error?: string };
type FypEvaluation = { evaluation_id: string; training_run_id: string; state: string; requested_episodes: number; episodes_completed?: number; goals_scored?: number; goal_rate?: number; seed?: number; error?: string };
type FypTicket = { accepted?: boolean; ticket: string; run_id?: string | null; action: string; status: string; result?: unknown; error?: string; note?: string };

const ACTIVE_STATES = new Set(['accepted', 'pending', 'queued', 'dispatching', 'launching', 'starting', 'active', 'running', 'cancelling', 'unknown', 'incomplete']);
const HEARTBEAT_MAX_AGE_SECONDS = 15;
const OPERATION_STORAGE_KEY = 'atlas.football.fyp.operation';
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

export function FypV1Experience({ onOpenEvidence }: { onOpenEvidence?: () => void }) {
    const [manifest, setManifest] = useState<FypManifest | null>(null);
    const [preflight, setPreflight] = useState<FypPreflight | null>(null);
    const [runs, setRuns] = useState<FypRun[]>([]);
    const [evaluations, setEvaluations] = useState<FypEvaluation[]>([]);
    const [seed, setSeed] = useState(63);
    const [evaluationSeed, setEvaluationSeed] = useState(515);
    const [evaluationEpisodes, setEvaluationEpisodes] = useState(10);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [ticket, setTicket] = useState<FypTicket | null>(readSavedTicket);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        try {
            const [m, p, r, e] = await Promise.all([
                callTool<FypManifest>('football_fyp_manifest'),
                callTool<FypPreflight>('football_fyp_preflight'),
                callTool<FypRun[]>('football_fyp_runs'),
                callTool<FypEvaluation[]>('football_fyp_evaluations'),
            ]);
            setManifest(m); setPreflight(p); setRuns(r); setEvaluations(e); setError('');
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setLoading(false); }
    }, []);
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
    const manifestScene = manifest?.contract.scene;
    const sceneMatches = manifest?.available === true && !!preflight?.scene_ready &&
        !!manifestScene && preflight?.active_scene === manifestScene;
    const heartbeatFresh = preflight?.heartbeat_age_seconds != null && preflight.heartbeat_age_seconds <= HEARTBEAT_MAX_AGE_SECONDS;
    const editorReady = !!preflight?.ready_to_train && !!preflight.editor_open && sceneMatches &&
        !preflight.editor_compiling && !!preflight.trainer_available && !preflight.editor_playing && heartbeatFresh;
    const operationActive = !!activeTicket || !!activeRun || !!activeEvaluation;
    const canStartTraining = editorReady && !operationActive && !busy;
    const canEvaluate = editorReady && !activeTicket && !activeRun && !activeEvaluation && !busy;
    const completedRuns = useMemo(() => runs.filter(run => run.state === 'completed' && run.exported_model === true), [runs]);
    const recentRuns = runs.slice(0, 3);

    let readinessMessage = 'Checking Unity readiness…';
    let readinessTone = 'pending';
    if (loading && !preflight) readinessMessage = 'Checking Unity readiness…';
    else if (!preflight) { readinessMessage = 'Unity status unavailable'; readinessTone = 'warning'; }
    else if (activeTicket) {
        readinessTone = 'active';
        if (preflight.trainer_connected && activeTicket.action === 'fyp_train') readinessMessage = 'Training in Unity';
        else if (preflight.trainer_connected && activeTicket.action === 'fyp_evaluate') readinessMessage = 'Evaluating checkpoint in Unity';
        else if (preflight.editor_playing) readinessMessage = 'Unity is in Play Mode — waiting for trainer connection';
        else readinessMessage = activeTicket.action === 'fyp_evaluate'
            ? 'Evaluation runner started — press Play in the FYP Editor'
            : 'Learner started — press Play in the FYP Editor';
    } else if (activeRun) {
        readinessTone = 'active'; readinessMessage = 'FYP training run is active';
    } else if (activeEvaluation) {
        readinessTone = 'active'; readinessMessage = 'Checkpoint evaluation is active';
    } else if (!manifest?.available) { readinessMessage = 'FYP Football contract unavailable'; readinessTone = 'warning'; }
    else if (!preflight.editor_open) { readinessMessage = 'Open the FYP project in Unity'; readinessTone = 'warning'; }
    else if (!sceneMatches) { readinessMessage = `Open ${sceneName(manifest?.contract.scene)} in Unity`; readinessTone = 'warning'; }
    else if (preflight.editor_compiling) { readinessMessage = 'Wait for Unity compilation to finish'; readinessTone = 'warning'; }
    else if (!preflight.trainer_available) { readinessMessage = 'ML-Agents trainer is unavailable'; readinessTone = 'warning'; }
    else if (!heartbeatFresh) { readinessMessage = 'Waiting for a fresh Unity heartbeat'; readinessTone = 'warning'; }
    else if (preflight.editor_playing) { readinessMessage = 'Stop Play Mode before starting an operation'; readinessTone = 'warning'; }
    else if (!preflight.ready_to_train) { readinessMessage = preflight.note || 'Atlas preflight has not approved this operation'; readinessTone = 'warning'; }
    else { readinessMessage = 'Ready to start from Unity Edit Mode'; readinessTone = 'ready'; }

    const operationDescription = activeTicket
        ? preflight?.trainer_connected ? 'Unity is connected to the active Atlas operation.'
            : preflight?.editor_playing ? 'The editor is running. Atlas is waiting for the ML-Agents connection.'
                : 'In the FYP Unity Editor, press Play to connect the trainer.'
        : activeRun ? `Run ${activeRun.run_id} · ${activeRun.preset} · seed ${activeRun.seed}`
            : activeEvaluation ? `Evaluation for ${activeEvaluation.training_run_id} · ${activeEvaluation.episodes_completed ?? 0}/${activeEvaluation.requested_episodes} episodes`
                : 'OpenGoalClose is the current FYP scene. Atlas starts the learner; Unity connects when you press Play.';

    const perform = async (operation: 'smoke' | 'pilot_50k') => {
        setBusy(operation); setError(''); setNotice('');
        try {
            const response = await callTool<FypTicket>('football_fyp_train', { preset: operation, seed });
            setTicket(response);
            setNotice('Learner request accepted. Press Play in the FYP Unity Editor to connect it.');
            await refresh();
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(''); }
    };
    const evaluateRun = async (runId: string) => {
        setBusy(`evaluate:${runId}`); setError(''); setNotice('');
        try {
            const response = await callTool<FypTicket>('football_fyp_evaluate', { runId, episodes: evaluationEpisodes, seed: evaluationSeed });
            setTicket(response);
            setNotice('Evaluation request accepted. Press Play in the FYP Unity Editor when Atlas reports that the checkpoint runner is ready.');
            await refresh();
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(''); }
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
                    <p className="fg-eyebrow">UNITY EDITOR</p>
                    <h2 id="fyp-readiness-title">{readinessMessage}</h2>
                </div>
                <button className="fg-button" type="button" onClick={() => void refreshNow()} disabled={!!busy}>
                    {busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}
                </button>
            </div>
            <div className="fyp-readiness-grid" aria-label="Unity readiness">
                <ReadinessItem label="Editor" value={!preflight ? 'Checking…' : preflight.editor_open ? 'Open' : preflight.editor_available ? 'Installed' : 'Closed'} state={!preflight ? 'pending' : preflight.editor_open ? 'ready' : 'warning'} />
                <ReadinessItem label="Scene" value={!preflight ? 'Checking…' : sceneMatches ? sceneName(preflight.active_scene) : preflight.active_scene ? 'Wrong scene' : 'Not loaded'} state={!preflight ? 'pending' : sceneMatches ? 'ready' : 'warning'} />
                <ReadinessItem label="Mode" value={!preflight ? 'Checking…' : preflight.editor_playing ? 'Play Mode' : 'Edit Mode'} state={!preflight ? 'pending' : preflight.editor_playing ? 'active' : 'ready'} />
                <ReadinessItem label="Compilation" value={!preflight ? 'Checking…' : preflight.editor_compiling ? 'Compiling' : 'Ready'} state={!preflight ? 'pending' : preflight.editor_compiling ? 'warning' : 'ready'} />
                <ReadinessItem label="Trainer" value={!preflight ? 'Checking…' : preflight.trainer_available ? 'Ready' : 'Unavailable'} state={!preflight ? 'pending' : preflight.trainer_available ? 'ready' : 'warning'} />
                <ReadinessItem label="Connection" value={preflight?.trainer_connected ? 'Connected' : activeTicket ? preflight?.editor_playing ? 'Connecting' : 'Waiting for Play' : 'Waiting'} state={preflight?.trainer_connected ? 'active' : 'pending'} />
                <ReadinessItem label="Heartbeat" value={!preflight ? 'Checking…' : preflight.heartbeat_age_seconds == null ? 'Unknown' : heartbeatFresh ? `${Math.round(preflight.heartbeat_age_seconds)}s ago` : 'Stale'} state={!preflight ? 'pending' : heartbeatFresh ? 'ready' : 'warning'} />
            </div>
            {operationActive && <div className="fyp-live-summary" role="status">
                <strong>{activeTicket ? 'Current operation' : activeRun ? 'Active training run' : 'Active evaluation'}</strong>
                <span>{operationDescription}</span>
                {preflight?.environment_present && <span className="fyp-live-metrics">
                    Episode {preflight.episode ?? '—'} · Completed {preflight.episodes_completed ?? '—'} · Goals {preflight.goals ?? '—'} · Last outcome {preflight.last_outcome ?? '—'}
                </span>}
                {activeTicket && <span className="fyp-ticket">{activeTicket.action} · {activeTicket.status} · ticket {activeTicket.ticket}</span>}
                {activeTicket?.error && <span className="fg-error">{activeTicket.error}</span>}
            </div>}
            {!operationActive && preflight?.environment_present && <div className="fyp-live-summary">
                <strong>Latest Unity activity</strong>
                <span>Episode {preflight.episode ?? '—'} · {preflight.episodes_completed ?? 0} completed · {preflight.goals ?? 0} goals · {preflight.last_outcome ?? 'No recent outcome'}</span>
            </div>}
            {ticket && !activeTicket && <div className="fyp-live-summary" aria-label="Latest operation receipt">
                <strong>Latest operation · {ticket.status}</strong>
                <span>{ticket.action === 'fyp_evaluate' ? 'Checkpoint evaluation' : 'Training'} · ticket {ticket.ticket}</span>
                {ticket.run_id && <span>Run {ticket.run_id}</span>}
                {ticket.error && <span className="fg-error">{ticket.error}</span>}
            </div>}
            <details className="fyp-contract-details">
                <summary>Experiment details</summary>
                <div className="fyp-contract-grid">
                    <span>Behavior <strong>{manifest?.contract.behavior ?? 'Loading'}</strong></span>
                    <span>Observations <strong>{manifest?.contract.observations.size ?? '—'}</strong></span>
                    <span>Continuous actions <strong>{manifest?.contract.actions.continuous ?? '—'}</strong></span>
                    <span>Trainer <strong>{manifest?.contract.trainer_kind ?? '—'}</strong></span>
                    <span>Scene <strong>{manifest?.contract.scene ?? 'Workspace unavailable'}</strong></span>
                    <span>Source <strong>{preflight?.source_sha256?.slice(0, 14) ?? '—'}</strong></span>
                </div>
                <p className="fg-muted">Training creates a candidate checkpoint. Atlas does not automatically evaluate, approve, promote, or advance a research phase.</p>
            </details>
        </section>

        <div className="fyp-workflow-grid">
            <section className="fg-panel fyp-training-panel">
                <p className="fg-eyebrow">EXPERIMENT</p>
                <h2>Train FootballV1</h2>
                <p className="fg-muted">Start the learner with the FYP scene open in Edit Mode. Then press Play in Unity to connect it.</p>
                <label className="fyp-field">Training seed
                    <input aria-label="FYP training seed" type="number" min={0} max={2147483647} step={1} value={seed} onChange={event => setSeed(Math.max(0, Math.min(2147483647, Math.floor(Number(event.target.value) || 0))))} />
                </label>
                <div className="fg-actions fyp-launch-actions">
                    <button className="fg-button primary" type="button" disabled={!canStartTraining} onClick={() => void perform('smoke')}>
                        {busy === 'smoke' ? 'Starting smoke run…' : 'Start smoke run · 2,048 steps'}
                    </button>
                    <button className="fg-button fyp-pilot-button" type="button" disabled={!canStartTraining} onClick={() => void perform('pilot_50k')}>
                        {busy === 'pilot_50k' ? 'Starting pilot…' : 'Start 50k pilot'}
                    </button>
                </div>
                {!canStartTraining && <p className="fyp-blocker" role="status">{operationActive ? 'A FYP operation is already active. Wait for its receipt to finish before starting another.' : busy ? 'Atlas is refreshing the current operation status.' : readinessMessage}</p>}
                <p className="fg-muted fyp-pilot-note">The 50k pilot is a longer run than the smoke and uses the same Unity Play Mode connection.</p>
                <p className="fg-muted fyp-candidate-note">A run exports a candidate model. Evaluation and human review remain separate steps.</p>
            </section>

            <section className="fg-panel fyp-runs-panel">
                <div className="fg-panel-title"><div><p className="fg-eyebrow">CHECKPOINTS</p><h2>Recent FYP runs</h2></div><span>{runs.length} recorded</span></div>
                {runs.length === 0 ? <p className="fg-muted">No FYP v1 training runs recorded yet.</p> :
                    <ul className="fyp-run-list">{recentRuns.map(run => <li className="fyp-run-row" key={run.run_id}>
                        <div className="fyp-run-summary">
                            <strong>{run.preset === 'smoke' ? 'Smoke run' : run.preset === 'pilot_50k' ? '50k pilot' : run.preset}</strong>
                            <span className={`fyp-state fyp-state-${run.state.toLowerCase()}`}>{run.state}</span>
                        </div>
                        <p>Seed {run.seed} · {run.steps.toLocaleString()} steps · {run.exported_model === true ? 'ONNX exported' : 'No exported model recorded'}</p>
                        {run.error && <p className="fg-error">{run.error}</p>}
                        <code>{run.run_id}</code>
                    </li>)}</ul>}
                {onOpenEvidence && <button type="button" className="fg-link fyp-evidence-link" onClick={onOpenEvidence}>View all checkpoint evidence →</button>}
            </section>
        </div>

        <details className="fg-panel fyp-evaluation-panel" open={!!activeEvaluation || activeTicket?.action === 'fyp_evaluate'}>
            <summary><div><p className="fg-eyebrow">EVIDENCE</p><h2>Evaluate a checkpoint in Unity</h2></div><span>{completedRuns.length} eligible</span></summary>
            <div className="fyp-evaluation-body">
            <p className="fg-muted">Evaluation runs against one completed checkpoint in the visible Unity Editor. Start from Edit Mode; Atlas starts the runner, then press Play when prompted.</p>
            <div className="fyp-evaluation-settings">
                <label className="fyp-field">Evaluation episodes
                    <input aria-label="FYP evaluation episodes" type="number" min={1} max={100} step={1} value={evaluationEpisodes} onChange={event => setEvaluationEpisodes(Math.max(1, Math.min(100, Math.floor(Number(event.target.value) || 1))))} />
                </label>
                <label className="fyp-field">Evaluation seed
                    <input aria-label="FYP evaluation seed" type="number" min={0} max={2147483647} step={1} value={evaluationSeed} onChange={event => setEvaluationSeed(Math.max(0, Math.min(2147483647, Math.floor(Number(event.target.value) || 0))))} />
                </label>
            </div>
            {completedRuns.length === 0 ? <p className="fg-muted">A completed run with an exported ONNX checkpoint is required before evaluation.</p> :
                <ul className="fyp-evaluation-list">{completedRuns.map(run => {
                    const runEvaluations = evaluations.filter(evaluation => evaluation.training_run_id === run.run_id);
                    const runIsActive = runEvaluations.some(evaluation => isActive(evaluation.state));
                    return <li className="fyp-evaluation-run" key={run.run_id}>
                        <div className="fyp-run-summary">
                            <div><strong>{run.preset === 'smoke' ? 'Smoke run' : run.preset === 'pilot_50k' ? '50k pilot' : run.preset}</strong><small>Run {run.run_id} · training seed {run.seed}</small></div>
                            <span className="fyp-state fyp-state-completed">Candidate checkpoint</span>
                        </div>
                        {runEvaluations.length > 0 && <ul className="fyp-evaluation-receipts" aria-label={`Evaluations for ${run.run_id}`}>
                            {runEvaluations.map(evaluation => <li key={evaluation.evaluation_id}>
                                <strong>{evaluation.state}</strong> · {evaluation.episodes_completed ?? 0}/{evaluation.requested_episodes} episodes
                                {evaluation.goals_scored != null ? ` · ${evaluation.goals_scored} goal${evaluation.goals_scored === 1 ? '' : 's'} (${Math.round((evaluation.goal_rate ?? 0) * 100)}%)` : ''}
                                {evaluation.seed != null ? ` · evaluation seed ${evaluation.seed}` : ''}
                                {evaluation.error ? ` · ${evaluation.error}` : ''}
                            </li>)}
                        </ul>}
                        <button className="fg-button" type="button" disabled={!canEvaluate || runIsActive} onClick={() => void evaluateRun(run.run_id)}>
                            {busy === `evaluate:${run.run_id}` ? 'Starting evaluation…' : `Evaluate ${evaluationEpisodes} episodes`}
                        </button>
                    </li>;
                })}</ul>}
            </div>
        </details>
    </div>;
}

function ReadinessItem({ label, value, state }: { label: string; value: string; state: string }) {
    return <div className="fyp-readiness-item">
        <span>{label}</span>
        <strong className={`fyp-indicator fyp-indicator-${state}`}>{value}</strong>
    </div>;
}
