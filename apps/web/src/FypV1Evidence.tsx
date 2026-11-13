import { useCallback, useEffect, useState } from 'react';
import { callTool } from './api';
import type { FypEnvironment } from './FypEnvironmentCatalog';

type Episode = { index?: number; episode?: number; seed?: number; goals?: number; elapsed_seconds?: number; outcome?: string; trainer_connected?: boolean };
type FypRun = {
    run_id: string; preset: string; steps: number; seed: number; state: string; source_sha256: string;
    exported_model?: boolean; model_sha256?: string | null; checkpoint_sha256?: string | null;
    environment?: FypEnvironment;
    exit_code?: number | null; started_at?: string; finished_at?: string; error?: string;
};
type FypEvaluation = {
    evaluation_id: string; training_run_id: string; state: string; requested_episodes: number;
    episodes_completed?: number; goals_scored?: number; goal_rate?: number; seed?: number;
    training_environment?: FypEnvironment; evaluation_environment?: FypEnvironment;
    started_at?: string; finished_at?: string; exit_code?: number | null; error?: string; episodes?: Episode[];
};
type Detail = { kind: 'run'; id: string } | { kind: 'evaluation'; id: string };

const labelForRun = (run: FypRun) => run.preset === 'smoke' ? 'Smoke run' : run.preset === 'pilot_50k' ? '50k pilot' : run.preset;
const dateTime = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded';
const duration = (start?: string, end?: string) => {
    if (!start) return 'Not recorded';
    const seconds = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000));
    return Number.isFinite(seconds) ? seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s` : 'Not recorded';
};
const iso = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const format = (value: unknown) => value == null ? '—' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);

export function FypV1Evidence({ runs: providedRuns, evaluations: providedEvaluations, onOpenEnvironment }: {
    runs?: FypRun[]; evaluations?: FypEvaluation[]; onOpenEnvironment?: (environmentId: string) => void;
} = {}) {
    const [runs, setRuns] = useState<FypRun[]>(providedRuns ?? []);
    const [evaluations, setEvaluations] = useState<FypEvaluation[]>(providedEvaluations ?? []);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [updatedAt, setUpdatedAt] = useState('');
    const [detail, setDetail] = useState<Detail | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [runReceipts, evaluationReceipts] = await Promise.all([
                callTool<FypRun[]>('football_fyp_runs'),
                callTool<FypEvaluation[]>('football_fyp_evaluations'),
            ]);
            setRuns(runReceipts); setEvaluations(evaluationReceipts); setError(''); setUpdatedAt(new Date().toLocaleTimeString());
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setLoading(false); }
    }, []);
    useEffect(() => {
        if (providedRuns && providedEvaluations) {
            setRuns(providedRuns); setEvaluations(providedEvaluations); setLoading(false);
            return;
        }
        void refresh();
        const timer = window.setInterval(() => { void refresh(); }, 3000);
        return () => window.clearInterval(timer);
    }, [refresh, providedRuns, providedEvaluations]);

    const selectedRun = detail?.kind === 'run' ? runs.find(run => run.run_id === detail.id) : undefined;
    const selectedEvaluation = detail?.kind === 'evaluation' ? evaluations.find(item => item.evaluation_id === detail.id) : undefined;
    if (detail?.kind === 'run') return <section className="fg-panel fyp-evidence-page fyp-record-detail" aria-label="Training run details">
        <button type="button" className="fg-link" onClick={() => setDetail(null)}>← Recent activity</button>
        {!selectedRun ? <p className="fg-muted">This training receipt is no longer available.</p> : <>
            <div className="fg-panel-title"><div><h2>{labelForRun(selectedRun)}</h2><span className={`fyp-state fyp-state-${selectedRun.state.toLowerCase()}`}>{selectedRun.state}</span></div></div>
            <div className="fyp-record-grid">
                <Record label="Started" value={dateTime(selectedRun.started_at)} exact={iso(selectedRun.started_at)} />
                <Record label="Finished" value={dateTime(selectedRun.finished_at)} exact={iso(selectedRun.finished_at)} />
                <Record label={selectedRun.finished_at ? 'Duration' : 'Elapsed'} value={duration(selectedRun.started_at, selectedRun.finished_at)} />
                <Record label="Training steps" value={selectedRun.steps.toLocaleString()} />
                <Record label="Training seed" value={selectedRun.seed} />
                <Record label="Checkpoint exported" value={selectedRun.exported_model} />
                <Record label="Exit code" value={selectedRun.exit_code} />
                <Record label="Source SHA-256" value={selectedRun.source_sha256} />
                <Record label="Model SHA-256" value={selectedRun.model_sha256} />
                <Record label="Checkpoint SHA-256" value={selectedRun.checkpoint_sha256} />
                <Record label="Run ID" value={selectedRun.run_id} />
            </div>
            {selectedRun.environment && <EnvironmentButton environment={selectedRun.environment} onOpen={onOpenEnvironment} label="Training environment" />}
            {selectedRun.error && <p className="fg-error">{selectedRun.error}</p>}
            <h3>Evaluations for this checkpoint</h3>
            {evaluations.filter(item => item.training_run_id === selectedRun.run_id).length === 0
                ? <p className="fg-muted">No evaluations recorded for this checkpoint.</p>
                : evaluations.filter(item => item.training_run_id === selectedRun.run_id).map(item => <button key={item.evaluation_id} className="fyp-evidence-card" type="button" onClick={() => setDetail({ kind: 'evaluation', id: item.evaluation_id })}>
                    <span><strong>Evaluation</strong><small>{dateTime(item.started_at)}</small></span><span className={`fyp-state fyp-state-${item.state.toLowerCase()}`}>{item.state}</span>
                    <span>{item.episodes_completed ?? 0}/{item.requested_episodes} episodes · {item.goals_scored ?? '—'} goals</span>
                </button>)}
        </>}
    </section>;
    if (detail?.kind === 'evaluation') return <section className="fg-panel fyp-evidence-page fyp-record-detail" aria-label="Evaluation details">
        <button type="button" className="fg-link" onClick={() => setDetail(null)}>← Recent activity</button>
        {!selectedEvaluation ? <p className="fg-muted">This evaluation receipt is no longer available.</p> : <>
            <div className="fg-panel-title"><div><h2>Checkpoint evaluation</h2><span className={`fyp-state fyp-state-${selectedEvaluation.state.toLowerCase()}`}>{selectedEvaluation.state}</span></div></div>
            <div className="fyp-record-grid">
                <Record label="Started" value={dateTime(selectedEvaluation.started_at)} exact={iso(selectedEvaluation.started_at)} />
                <Record label="Finished" value={dateTime(selectedEvaluation.finished_at)} exact={iso(selectedEvaluation.finished_at)} />
                <Record label={selectedEvaluation.finished_at ? 'Duration' : 'Elapsed'} value={duration(selectedEvaluation.started_at, selectedEvaluation.finished_at)} />
                <Record label="Episodes" value={`${selectedEvaluation.episodes_completed ?? 0} / ${selectedEvaluation.requested_episodes}`} />
                <Record label="Goals scored" value={selectedEvaluation.goals_scored} />
                <Record label="Goal rate" value={selectedEvaluation.goal_rate == null ? undefined : `${(selectedEvaluation.goal_rate * 100).toFixed(1)}%`} />
                <Record label="Evaluation seed" value={selectedEvaluation.seed} />
                <Record label="Training run" value={labelForRun(runs.find(run => run.run_id === selectedEvaluation.training_run_id) ?? { run_id: selectedEvaluation.training_run_id, preset: 'Training run', steps: 0, seed: 0, state: '', source_sha256: '' })} />
                <Record label="Training run ID" value={selectedEvaluation.training_run_id} />
                <Record label="Evaluation ID" value={selectedEvaluation.evaluation_id} />
                <Record label="Exit code" value={selectedEvaluation.exit_code} />
            </div>
            {selectedEvaluation.training_environment && <EnvironmentButton environment={selectedEvaluation.training_environment} onOpen={onOpenEnvironment} label="Training environment" />}
            {selectedEvaluation.evaluation_environment && <EnvironmentButton environment={selectedEvaluation.evaluation_environment} onOpen={onOpenEnvironment} label="Evaluation environment" />}
            <p className="fg-muted">This evaluation runs the checkpoint in the open Unity Editor, so you can inspect the policy while episodes are played.</p>
            {selectedEvaluation.error && <p className="fg-error">{selectedEvaluation.error}</p>}
            <h3>Recorded episodes</h3>
            {!selectedEvaluation.episodes?.length ? <p className="fg-muted">No per-episode records were saved.</p> : <div className="fyp-episode-table" role="table" aria-label="Evaluation episode results">
                <div role="row" className="fyp-episode-head"><span>Episode</span><span>Seed</span><span>Goals</span><span>Duration</span><span>Outcome</span></div>
                {selectedEvaluation.episodes.map((episode, index) => <div role="row" key={episode.index ?? episode.episode ?? index}>
                    <span>{episode.episode ?? episode.index ?? index + 1}</span><span>{format(episode.seed)}</span><span>{format(episode.goals)}</span>
                    <span>{episode.elapsed_seconds == null ? '—' : `${episode.elapsed_seconds.toFixed(1)}s`}</span><span>{format(episode.outcome)}</span>
                </div>)}
            </div>}
        </>}
    </section>;

    return <section className="fg-panel fyp-evidence-page" aria-label="Recent training and evaluation activity">
        <div className="fg-panel-title"><h2>Recent activity</h2>
            {providedRuns && providedEvaluations
                ? <span>{runs.length} training · {evaluations.length} evaluations</span>
                : <div className="fg-refresh-controls"><span className="fg-refresh-status" role="status">{loading ? 'Loading…' : `Updated ${updatedAt || '—'}`}</span>
                    <button className="fg-button" type="button" onClick={() => void refresh()}>Refresh</button></div>}
        </div>
        {error && <p className="fg-error" role="alert">{error}</p>}
        {!loading && !runs.length && !evaluations.length && <p className="fg-muted">No training or evaluation receipts yet.</p>}
        <div className="fyp-evidence-runs">{runs.map(run => {
            const runEvaluations = evaluations.filter(evaluation => evaluation.training_run_id === run.run_id);
            return <article className="fyp-evidence-run" key={run.run_id}>
                <button className="fyp-evidence-card" type="button" onClick={() => setDetail({ kind: 'run', id: run.run_id })}>
                    <span><strong>{labelForRun(run)}</strong><small>{dateTime(run.started_at)}</small></span>
                    <span className={`fyp-state fyp-state-${run.state.toLowerCase()}`}>{run.state}</span>
                    <span>{run.steps.toLocaleString()} steps · seed {run.seed} · {run.exported_model === true ? 'Checkpoint exported' : 'No export recorded'}</span>
                    <span>{runEvaluations.length} evaluation{runEvaluations.length === 1 ? '' : 's'} · Open details →</span>
                </button>
                {run.environment && <EnvironmentButton environment={run.environment} onOpen={onOpenEnvironment} label="Training environment" />}
                {runEvaluations.map(evaluation => <button className="fyp-evidence-card fyp-evidence-child" type="button" key={evaluation.evaluation_id} onClick={() => setDetail({ kind: 'evaluation', id: evaluation.evaluation_id })}>
                    <span><strong>Evaluation</strong><small>{dateTime(evaluation.started_at)}</small></span>
                    <span className={`fyp-state fyp-state-${evaluation.state.toLowerCase()}`}>{evaluation.state}</span>
                    <span>{evaluation.episodes_completed ?? 0}/{evaluation.requested_episodes} episodes · {evaluation.goals_scored ?? '—'} goals · seed {evaluation.seed ?? '—'}</span>
                    <span>Open details →</span>
                </button>)}
                {runEvaluations.map(evaluation => evaluation.evaluation_environment && <EnvironmentButton key={evaluation.evaluation_id}
                    environment={evaluation.evaluation_environment} onOpen={onOpenEnvironment} label={`Evaluation · ${dateTime(evaluation.started_at)}`} />)}
            </article>;
        })}</div>
    </section>;
}

function Record({ label, value, exact }: { label: string; value: unknown; exact?: string }) {
    return <div className="fyp-record-field"><small>{label}</small><strong title={exact}>{format(value)}</strong>{exact && <code>{exact}</code>}</div>;
}

function EnvironmentButton({ environment, onOpen, label }: {
    environment: FypEnvironment; onOpen?: (environmentId: string) => void; label: string;
}) {
    const version = environment.snapshot_recorded === false ? 'historical settings not recorded' : `v${environment.version}`;
    const destination = environment.snapshot_recorded === false ? 'View current environment' : 'View environment';
    if (!onOpen) return <p className="fyp-environment-link-label">{label}: {environment.name} · {version}</p>;
    return <button className="fyp-environment-link-label" type="button" onClick={() => onOpen(environment.environment_id)}>
        {label}: {environment.name} · {version} · {destination} →
    </button>;
}
