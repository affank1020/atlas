import { useCallback, useEffect, useState } from 'react';
import { callTool } from './api';
import { FypEnvironmentCard, type FypEnvironment } from './FypEnvironmentCatalog';

type Episode = { index?: number; episode?: number; seed?: number; goals?: number; elapsed_seconds?: number; outcome?: string; trainer_connected?: boolean };
type FypRun = {
    run_id: string; preset: string; steps: number; seed: number; state: string; source_sha256: string;
    training_number?: number;
    exported_model?: boolean; checkpoint_number?: number; model_sha256?: string | null; checkpoint_sha256?: string | null;
    environment?: FypEnvironment;
    exit_code?: number | null; started_at?: string; finished_at?: string; error?: string;
};
type FypEvaluation = {
    evaluation_id: string; training_run_id: string; state: string; requested_episodes: number;
    evaluation_number?: number;
    episodes_completed?: number; goals_scored?: number; goal_rate?: number; seed?: number;
    training_environment?: FypEnvironment; evaluation_environment?: FypEnvironment;
    started_at?: string; finished_at?: string; exit_code?: number | null; error?: string; episodes?: Episode[];
};
type Detail = { kind: 'run'; id: string } | { kind: 'evaluation'; id: string };
type Focus = { kind: 'run' | 'evaluations'; runId: string } | { kind: 'evaluation'; runId: string; evaluationId: string; returnPage: 'runs' | 'run' | 'evaluations' | 'checkpoints' | 'checkpoint' | 'checkpoint-evaluations' };
type EvaluationControls = {
    episodes: number; seed: number; canStart: boolean; starting: boolean; blocker: string;
    operationActive?: boolean; onViewHome?: () => void;
    onEpisodesChange: (value: number) => void; onSeedChange: (value: number) => void; onStart: () => void;
};

const labelForRun = (run: FypRun) => run.preset === 'smoke' ? 'Smoke run' : run.preset === 'pilot_50k' ? '50k pilot' : run.preset;
const trainingTag = (run: FypRun) => run.training_number ? `T${run.training_number}` : undefined;
const evaluationTag = (evaluation: FypEvaluation) => evaluation.evaluation_number ? `E${evaluation.evaluation_number}` : undefined;
const checkpointLabel = (run?: FypRun) => run?.checkpoint_number ? `C${run.checkpoint_number}` : undefined;
const dateTime = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded';
const startedAt = (run: FypRun) => {
    const value = Date.parse(run.started_at ?? run.finished_at ?? '');
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
};
const timestampFor = (started?: string, finished?: string) => {
    const value = Date.parse(started ?? finished ?? '');
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
};
const duration = (start?: string, end?: string) => {
    if (!start) return 'Not recorded';
    const seconds = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000));
    return Number.isFinite(seconds) ? seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s` : 'Not recorded';
};
const iso = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const format = (value: unknown) => value == null ? '—' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
const environmentReference = (environment?: FypEnvironment) => environment
    ? `${environment.name} · v${environment.version}`
    : 'Not recorded';

export function FypV1Evidence({ runs: providedRuns, evaluations: providedEvaluations, focus, onBack, onOpenRun, onOpenEvaluation, onOpenEnvironment, onOpenCheckpoint, evaluationControls, flat }: {
    runs?: FypRun[]; evaluations?: FypEvaluation[];
    focus?: Focus; onBack?: () => void;
    onOpenRun?: (runId: string) => void;
    onOpenEvaluation?: (evaluationId: string, source: 'runs' | 'run' | 'evaluations' | 'checkpoints') => void;
    onOpenEnvironment?: (environmentId: string) => void;
    onOpenCheckpoint?: (runId: string) => void;
    evaluationControls?: EvaluationControls;
    flat?: boolean;
} = {}) {
    const [runs, setRuns] = useState<FypRun[]>(providedRuns ?? []);
    const [evaluations, setEvaluations] = useState<FypEvaluation[]>(providedEvaluations ?? []);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [updatedAt, setUpdatedAt] = useState('');
    const [detail, setDetail] = useState<Detail | null>(() => focus?.kind === 'run' ? { kind: 'run', id: focus.runId }
        : focus?.kind === 'evaluation' ? { kind: 'evaluation', id: focus.evaluationId } : null);

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
    const evaluationRun = selectedEvaluation ? runs.find(run => run.run_id === selectedEvaluation.training_run_id) : undefined;
    const evaluationTrainingRun = selectedEvaluation ? evaluationRun ?? {
        run_id: selectedEvaluation.training_run_id, preset: 'Training run', steps: 0, seed: 0, state: '', source_sha256: '',
    } : undefined;
    if (detail?.kind === 'run') return <section className="fyp-evidence-page fyp-record-detail" aria-label="Training run details">
        {focus?.kind !== 'run' && <button type="button" className="fg-link" onClick={() => onBack ? onBack() : setDetail(null)}>← Recent Runs</button>}
        {!selectedRun ? <p className="fg-muted">This training receipt is no longer available.</p> : <>
            <div className="fyp-record-status"><span className={`fyp-state fyp-state-${selectedRun.state.toLowerCase()}`}>{selectedRun.state}</span></div>
            {selectedRun.environment && <div className="fyp-record-environment fyp-environment-cards">
                <FypEnvironmentCard environment={selectedRun.environment} onOpen={onOpenEnvironment} />
            </div>}
            {checkpointLabel(selectedRun) && onOpenCheckpoint && <button className="fg-link fyp-record-checkpoint-link" type="button"
                onClick={() => onOpenCheckpoint(selectedRun.run_id)}>View policy checkpoint {checkpointLabel(selectedRun)} →</button>}
            <div className="fyp-record-grid">
                <Record label="Started" value={dateTime(selectedRun.started_at)} exact={iso(selectedRun.started_at)} />
                <Record label="Finished" value={dateTime(selectedRun.finished_at)} exact={iso(selectedRun.finished_at)} />
                <Record label={selectedRun.finished_at ? 'Duration' : 'Elapsed'} value={duration(selectedRun.started_at, selectedRun.finished_at)} />
                <Record label="Training steps" value={selectedRun.steps.toLocaleString()} />
                <Record label="Training name" value={selectedRun.training_number ? `T${selectedRun.training_number}` : undefined} />
                <Record label="Training seed" value={selectedRun.seed} />
                <Record label="Checkpoint exported" value={selectedRun.exported_model} />
                <Record label="Checkpoint ID" value={checkpointLabel(selectedRun)} />
                <Record label="Exit code" value={selectedRun.exit_code} />
                <Record label="Source SHA-256" value={selectedRun.source_sha256} />
                <Record label="Model SHA-256" value={selectedRun.model_sha256} />
                <Record label="Checkpoint SHA-256" value={selectedRun.checkpoint_sha256} />
                <Record label="Run ID" value={selectedRun.run_id} />
            </div>
            {selectedRun.error && <p className="fg-error">{selectedRun.error}</p>}
        </>}
    </section>;
    if (detail?.kind === 'evaluation') return <section className="fyp-evidence-page fyp-record-detail" aria-label="Evaluation details">
        {focus?.kind !== 'evaluation' && <button type="button" className="fg-link" onClick={() => onBack ? onBack() : setDetail(null)}>← {focus?.kind === 'evaluations' ? 'Evaluations' : 'Recent Runs'}</button>}
        {!selectedEvaluation ? <p className="fg-muted">This evaluation receipt is no longer available.</p> : <>
            <div className="fyp-record-status"><span className={`fyp-state fyp-state-${selectedEvaluation.state.toLowerCase()}`}>{selectedEvaluation.state}</span></div>
            {selectedEvaluation.evaluation_environment && <div className="fyp-record-environment fyp-environment-cards">
                <FypEnvironmentCard environment={selectedEvaluation.evaluation_environment} onOpen={onOpenEnvironment} />
            </div>}
            {checkpointLabel(evaluationRun) && onOpenCheckpoint && <button className="fg-link fyp-record-checkpoint-link" type="button"
                onClick={() => onOpenCheckpoint(evaluationRun!.run_id)}>View policy checkpoint {checkpointLabel(evaluationRun)} →</button>}
            <div className="fyp-record-grid">
                <Record label="Started" value={dateTime(selectedEvaluation.started_at)} exact={iso(selectedEvaluation.started_at)} />
                <Record label="Finished" value={dateTime(selectedEvaluation.finished_at)} exact={iso(selectedEvaluation.finished_at)} />
                <Record label={selectedEvaluation.finished_at ? 'Duration' : 'Elapsed'} value={duration(selectedEvaluation.started_at, selectedEvaluation.finished_at)} />
                <Record label="Episodes" value={`${selectedEvaluation.episodes_completed ?? 0} / ${selectedEvaluation.requested_episodes}`} />
                <Record label="Goals scored" value={selectedEvaluation.goals_scored} />
                <Record label="Goal rate" value={selectedEvaluation.goal_rate == null ? undefined : `${(selectedEvaluation.goal_rate * 100).toFixed(1)}%`} />
                <Record label="Evaluation seed" value={selectedEvaluation.seed} />
                <Record label="Evaluation name" value={selectedEvaluation.evaluation_number ? `E${selectedEvaluation.evaluation_number}` : undefined} />
                <Record label="Checkpoint ID" value={checkpointLabel(evaluationRun)} />
                <Record label="Training run" value={`${trainingTag(evaluationTrainingRun!) ? `${trainingTag(evaluationTrainingRun!)} · ` : ''}${labelForRun(evaluationTrainingRun!)}`} />
                <Record label="Training run ID" value={selectedEvaluation.training_run_id} />
                <Record label="Evaluation ID" value={selectedEvaluation.evaluation_id} />
                <Record label="Exit code" value={selectedEvaluation.exit_code} />
            </div>
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

    if (focus?.kind === 'evaluations') {
        const runEvaluations = evaluations.filter(item => item.training_run_id === focus.runId);
        return <section className="fyp-checkpoint-evaluations" aria-label="Checkpoint evaluations">
            <h2 className="fyp-checkpoint-section-title">Evaluations</h2>
            {evaluationControls && <div className="fyp-evaluation-launcher">
                <h3>Start a new evaluation</h3>
                <div className="fyp-evaluation-settings">
                    <label className="fyp-field">Episodes
                        <input aria-label="FYP evaluation episodes" type="number" min={1} max={100} step={1} value={evaluationControls.episodes} onChange={event => evaluationControls.onEpisodesChange(Number(event.target.value))} />
                    </label>
                    <label className="fyp-field">Seed
                        <input aria-label="FYP evaluation seed" type="number" min={0} max={2147483647} step={1} value={evaluationControls.seed} onChange={event => evaluationControls.onSeedChange(Number(event.target.value))} />
                    </label>
                </div>
                <button className="fg-button primary" type="button" disabled={!evaluationControls.canStart} onClick={evaluationControls.onStart}>
                    {evaluationControls.starting ? 'Starting evaluation…' : 'Start evaluation'}
                </button>
                {!evaluationControls.canStart && <p className="fyp-blocker" role="status">{evaluationControls.blocker}</p>}
                {evaluationControls.operationActive && evaluationControls.onViewHome &&
                    <button className="fg-link" type="button" onClick={evaluationControls.onViewHome}>View the active operation on Home →</button>}
            </div>}
            {!runEvaluations.length ? <p className="fg-muted">No evaluations recorded for this checkpoint yet.</p> :
                <div className="fyp-evidence-runs" aria-label="Recorded evaluations">{runEvaluations.map(item => <EvaluationEvidenceCard key={item.evaluation_id} evaluation={item}
                    onOpen={() => onOpenEvaluation ? onOpenEvaluation(item.evaluation_id, 'checkpoints') : setDetail({ kind: 'evaluation', id: item.evaluation_id })} />)}</div>}
        </section>;
    }

    const recentActivity = [
        ...runs.map(run => ({ kind: 'training' as const, run, id: run.run_id, timestamp: startedAt(run) })),
        ...evaluations.map(evaluation => ({ kind: 'evaluation' as const, evaluation, id: evaluation.evaluation_id,
            timestamp: timestampFor(evaluation.started_at, evaluation.finished_at) })),
    ].sort((a, b) => {
        const difference = b.timestamp - a.timestamp;
        return Number.isNaN(difference) || difference === 0 ? a.id.localeCompare(b.id) : difference;
    });

    return <section className={`${flat ? '' : 'fg-panel '}fyp-evidence-page`} aria-label="Recent training and evaluation runs">
        {!flat && <div className="fg-panel-title"><h2>Run timeline</h2>
            {providedRuns && providedEvaluations
                ? <span>{recentActivity.length} entries</span>
                : <div className="fg-refresh-controls"><span className="fg-refresh-status" role="status">{loading ? 'Loading…' : `Updated ${updatedAt || '—'}`}</span>
                    <button className="fg-button" type="button" onClick={() => void refresh()}>Refresh</button></div>}
        </div>}
        {error && <p className="fg-error" role="alert">{error}</p>}
        {!loading && !recentActivity.length && <p className="fg-muted">No training runs or evaluations recorded yet.</p>}
        <div className="fyp-evidence-runs">{recentActivity.map(item => item.kind === 'training'
            ? <TrainingEvidenceCard key={`training:${item.id}`} run={item.run}
                onOpen={() => onOpenRun ? onOpenRun(item.id) : setDetail({ kind: 'run', id: item.id })} />
            : <EvaluationEvidenceCard key={`evaluation:${item.id}`} evaluation={item.evaluation}
                onOpen={() => onOpenEvaluation ? onOpenEvaluation(item.id, 'runs') : setDetail({ kind: 'evaluation', id: item.id })} />)}</div>
    </section>;
}

function Record({ label, value, exact }: { label: string; value: unknown; exact?: string }) {
    return <div className="fyp-record-field"><small>{label}</small><strong title={exact}>{format(value)}</strong>{exact && <code>{exact}</code>}</div>;
}

function IndexPill({ children, kind }: { children?: string; kind: 'training' | 'evaluation' }) {
    return <span className={`fyp-index-pill fyp-${kind}-pill`}>{children}</span>;
}

export function TrainingEvidenceCard({ run, onOpen }: { run: FypRun; onOpen: () => void }) {
    return <button className="fyp-evidence-card" type="button" onClick={onOpen}>
        <span><strong>{trainingTag(run) && <IndexPill kind="training">{trainingTag(run)}</IndexPill>}{labelForRun(run)}</strong>
            <small>{dateTime(run.started_at ?? run.finished_at)}</small>
            <small>{environmentReference(run.environment)}</small></span>
        <span className={`fyp-state fyp-state-${run.state.toLowerCase()}`}>{run.state}</span>
        <span>{run.steps.toLocaleString()} steps · seed {run.seed}</span>
    </button>;
}

function EvaluationEvidenceCard({ evaluation, onOpen }: { evaluation: FypEvaluation; onOpen: () => void }) {
    return <button className="fyp-evidence-card" type="button" onClick={onOpen}>
        <span><strong>{evaluationTag(evaluation) && <IndexPill kind="evaluation">{evaluationTag(evaluation)}</IndexPill>}Evaluation</strong>
            <small>{dateTime(evaluation.started_at ?? evaluation.finished_at)}</small>
            <small>{environmentReference(evaluation.evaluation_environment)}</small></span>
        <span className={`fyp-state fyp-state-${evaluation.state.toLowerCase()}`}>{evaluation.state}</span>
        <span>{evaluation.episodes_completed ?? 0}/{evaluation.requested_episodes} episodes · {evaluation.goals_scored ?? '—'} goals · seed {evaluation.seed ?? '—'}</span>
    </button>;
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
