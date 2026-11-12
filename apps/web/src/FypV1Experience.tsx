import { useCallback, useEffect, useState } from 'react';
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
type FypEvaluation = { evaluation_id: string; training_run_id: string; state: string; requested_episodes: number; episodes_completed?: number; goals_scored?: number; goal_rate?: number; error?: string };
type FypTicket = { accepted?: boolean; ticket: string; run_id?: string | null; action: string; status: string; result?: unknown; error?: string; note?: string };

export function FypV1Experience() {
    const [manifest, setManifest] = useState<FypManifest | null>(null);
    const [preflight, setPreflight] = useState<FypPreflight | null>(null);
    const [runs, setRuns] = useState<FypRun[]>([]);
    const [evaluations, setEvaluations] = useState<FypEvaluation[]>([]);
    const [seed, setSeed] = useState(63);
    const [evaluationEpisodes, setEvaluationEpisodes] = useState(10);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [ticket, setTicket] = useState<FypTicket | null>(null);

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
    }, []);
    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => { void refresh(); }, 3000);
        return () => window.clearInterval(timer);
    }, [refresh]);

    const perform = async (operation: 'build' | 'smoke' | 'pilot_50k') => {
        setBusy(operation); setError(''); setNotice('');
        try {
            const response = operation === 'build'
                ? await callTool<FypTicket>('football_fyp_build')
                : await callTool<FypTicket>('football_fyp_train', {
                    preset: operation, seed,
                });
            setTicket(response);
            setNotice(operation === 'build'
                ? 'Optional player build accepted. Editor training does not need it.'
                : 'Learner request accepted. In Unity, press Play on the FYP scene to connect; this panel will show when the trainer is connected.');
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(''); }
    };
    const evaluateRun = async (runId: string) => {
        setBusy(`evaluate:${runId}`); setError(''); setNotice('');
        try {
            const response = await callTool<FypTicket>('football_fyp_evaluate', {
                runId, episodes: evaluationEpisodes, seed,
            });
            setTicket(response);
            setNotice('Evaluation accepted. Stop Play Mode if needed; Atlas starts the checkpoint runner, then press Play in Unity. Episode outcomes appear in Unity Console and here.');
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setBusy(''); }
    };
    const inspect = async () => {
        if (!ticket) return;
        try {
            const response = await callTool<FypTicket>('football_fyp_task_status', { runId: ticket.ticket });
            setTicket(response);
            if (response.status === 'completed') await refresh();
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    };

    return <div className="fg-stack" aria-label="FYP v1 training">
        <section className="fg-panel">
            <h2>FYP — new Unity football project</h2>
            <p className="fg-muted">Canonical successor to AI Football. The FootballV1 25/8 policy is independent of historical V2 54/5 and experimental FootV1 54/7 models.</p>
            <div className="fg-stats">
                <div><small>Behavior</small><strong>{manifest?.contract.behavior ?? 'Unavailable'}</strong></div>
                <div><small>Observations</small><strong>{manifest?.contract.observations.size ?? '—'}</strong></div>
                <div><small>Actions</small><strong>{manifest?.contract.actions.continuous ?? '—'}</strong></div>
                <div><small>Trainer</small><strong>{manifest?.contract.trainer_kind ?? '—'}</strong></div>
            </div>
            <p className="fg-muted">Scene: {manifest?.contract.scene ?? 'FYP Unity Workspace not connected'}</p>
            {error && <p className="fg-error" role="alert">{error}</p>}
            {notice && <p className="fg-notice" role="status">{notice}</p>}
            <button className="fg-button" type="button" onClick={() => void refresh()} disabled={!!busy}>Refresh FYP preflight</button>
        </section>
        <section className="fg-panel">
            <h2>Local readiness</h2>
            <p>Editor process: <strong>{preflight?.editor_open ? 'Open' : preflight?.editor_available ? 'Installed; not reporting open' : 'Not detected'}</strong> · Play Mode: <strong>{preflight?.editor_playing ? 'Playing' : 'Not playing'}</strong> · FootballV1 scene: <strong>{preflight?.scene_ready ? 'Loaded' : 'Not loaded'}</strong></p>
            <p>ML-Agents trainer: <strong>{preflight?.trainer_available ? 'Ready' : 'Not installed'}</strong> · Unity connection: <strong>{preflight?.trainer_connected ? 'Connected' : 'Waiting'}</strong></p>
            <p className="fg-muted">{preflight?.active_scene ? `Editor scene: ${preflight.active_scene}` : 'Open the FYP project in Unity to start its local status heartbeat.'}{preflight?.heartbeat_age_seconds != null ? ` · Updated ${preflight.heartbeat_age_seconds}s ago` : ''}</p>
            {preflight?.environment_present && <>
                <p>Live episode: <strong>{preflight.episode ?? '—'}</strong> · Completed: <strong>{preflight.episodes_completed ?? '—'}</strong> · Goals: <strong>{preflight.goals ?? '—'}</strong> · Last outcome: <strong>{preflight.last_outcome ?? '—'}</strong></p>
                {preflight.recent_episodes?.length > 0 && <ul aria-label="Recent FYP Unity episodes">
                    {preflight.recent_episodes.slice(-5).map(event => <li key={event.sequence}>Episode {event.episode} · {event.outcome} · {event.goals} goals · seed {event.seed}</li>)}
                </ul>}
            </>}
            <p className="fg-muted">Source fingerprint: {preflight?.source_sha256?.slice(0, 14) ?? '—'} · A built player is optional. Start the learner with this scene open in Edit Mode, then press Play to connect Unity.</p>
        </section>
        <section className="fg-panel">
            <h2>Bounded MA-POCA training</h2>
            <div className="fg-actions">
                <label>Seed <input aria-label="FYP training seed" type="number" min={0} max={2147483647} value={seed} onChange={e => setSeed(Number(e.target.value))}/></label>
            </div>
            <div className="fg-actions">
                <button className="fg-button primary" type="button" disabled={!!busy || !preflight?.ready_to_train} onClick={() => void perform('smoke')}>Run 2,048-step smoke</button>
                <button className="fg-button" type="button" disabled={!!busy || !preflight?.ready_to_train} onClick={() => void perform('pilot_50k')}>Run 50k pilot</button>
            </div>
            <p className="fg-muted">Unity connects when you press Play after starting the learner. Per-episode outcomes are logged in the Unity Console. Training produces a candidate model only. There is no automatic evaluation, Watch approval, policy promotion or phase advancement.</p>
            {ticket && <div aria-label="FYP operation receipt">
                <p>Operation: <strong>{ticket.action}</strong> · State: <strong>{ticket.status}</strong> · Ticket: <code>{ticket.ticket}</code></p>
                {ticket.run_id && <p>Run: <code>{ticket.run_id}</code></p>}
                {ticket.error && <p className="fg-error">{ticket.error}</p>}
                <button type="button" className="fg-button" onClick={() => void inspect()}>Check operation receipt</button>
            </div>}
        </section>
        <section className="fg-panel">
            <h2>FYP training receipts</h2>
            {runs.length === 0 ? <p className="fg-muted">No FYP v1 training results recorded yet.</p> :
                <ul>{runs.map(run => <li key={run.run_id}>
                    <strong>{run.run_id}</strong> · {run.state} · {run.preset} · seed {run.seed}
                    {run.exported_model === true ? ' · ONNX exported' : ''}
                    {run.error ? ` · ${run.error}` : ''}
                </li>)}</ul>}
        </section>
        <section className="fg-panel">
            <h2>Editor checkpoint evaluation</h2>
            <p className="fg-muted">Evaluate a completed FootballV1 checkpoint in the visible Unity Editor. Start from Edit Mode, then press Play after Atlas starts the inference runner.</p>
            <label>Episodes <input aria-label="FYP evaluation episodes" type="number" min={1} max={100} value={evaluationEpisodes} onChange={e => setEvaluationEpisodes(Math.max(1, Math.min(100, Number(e.target.value))))}/></label>
            {runs.filter(run => run.state === 'completed' && run.exported_model === true).length === 0
                ? <p className="fg-muted">A completed FYP training run is required before evaluation.</p>
                : <ul>{runs.filter(run => run.state === 'completed' && run.exported_model === true).map(run => <li key={run.run_id}>
                    <strong>{run.run_id}</strong> · {evaluations.filter(evaluation => evaluation.training_run_id === run.run_id).length} evaluation(s) ·{' '}
                    <button className="fg-button" type="button" disabled={!!busy || !preflight?.ready_to_train} onClick={() => void evaluateRun(run.run_id)}>Evaluate {evaluationEpisodes} episodes in Editor</button>
                </li>)}</ul>}
            {evaluations.length > 0 && <ul aria-label="FYP evaluation receipts">{evaluations.map(evaluation => <li key={evaluation.evaluation_id}>
                {evaluation.training_run_id} · {evaluation.state} · {evaluation.episodes_completed ?? 0}/{evaluation.requested_episodes} episodes
                {evaluation.goals_scored != null ? ` · ${evaluation.goals_scored} goals (${Math.round((evaluation.goal_rate ?? 0) * 100)}%)` : ''}
                {evaluation.error ? ` · ${evaluation.error}` : ''}
            </li>)}</ul>}
        </section>
    </div>;
}
