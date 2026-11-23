import { FypPagination, FypReadMessage, useFypPage, useFypRead } from './fypHistory';
import { FypEvaluationDiagnostics, type EvaluationDiagnostics } from './FypEvaluationDiagnostics';
import { FypEnvironmentCard, type FypEnvironment } from './FypEnvironmentCatalog';

type Episode = { sequence?: number; index?: number; episode?: number; seed?: number; goals?: number; elapsed_seconds?: number; outcome?: string; trainer_connected?: boolean;
    time_cost_reward?: number; terminal_reward?: number; reward_total?: number; terminal_reward_type?: string };
type TrainingMetric = { step: number; elapsed_seconds: number; mean_reward: number; mean_group_reward: number };
export type FypRunSummary = {
    run_id: string; preset: string; steps: number; steps_completed?: number; episodes_completed?: number;
    goals_scored?: number; mean_reward?: number | null; seed: number; state: string; policy_id?: string;
    training_number?: number; checkpoint_number?: number; exported_model?: boolean; checkpoint_exported?: boolean;
    environment_reference?: string; notes?: string; started_at?: string; finished_at?: string;
};
export type FypRun = FypRunSummary & {
    checkpoint_mode?: 'fresh' | 'resume' | 'transfer'; parent_run_id?: string | null;
    parent_checkpoint_number?: number | null; starting_step?: number; additional_steps?: number;
    source_sha256: string; time_scale?: number; mean_episode_seconds?: number | null;
    policy_revision?: number; policy_record_sha256?: string; policy_snapshot?: Record<string, unknown>;
    environment?: FypEnvironment; model_sha256?: string | null; checkpoint_sha256?: string | null;
    exit_code?: number | null; error?: string;
};
export type FypEvaluationSummary = {
    evaluation_id: string; training_run_id: string; state: string; requested_episodes: number;
    policy_id?: string; evaluation_number?: number; episodes_completed?: number; goals_scored?: number;
    goal_rate?: number; seed?: number; started_at?: string; finished_at?: string; environment_reference?: string;
};
export type FypEvaluation = FypEvaluationSummary & {
    policy_revision?: number; policy_record_sha256?: string; policy_snapshot?: Record<string, unknown>;
    diagnostics?: EvaluationDiagnostics; time_scale?: number; evaluation_environment?: FypEnvironment;
    exit_code?: number | null; error?: string;
};
export type HistoryRow = FypRunSummary | FypEvaluationSummary;
export type HistoryPage = ReturnType<typeof useFypPage<HistoryRow>>;
type EvaluationControls = {
    episodes: number; seed: number; timeScale: number; canStart: boolean; starting: boolean; blocker: string;
    operationActive?: boolean; onViewHome?: () => void;
    onEpisodesChange: (value: number) => void; onSeedChange: (value: number) => void;
    onTimeScaleChange: (value: number) => void; onStart: () => void;
};

const labelForRun = (run: FypRunSummary) => run.preset === 'smoke' ? 'Smoke run' : run.preset === 'pilot_50k' ? '50k pilot' : run.preset === 'custom' ? 'Custom-budget run' : run.preset;
const trainingTag = (run: FypRunSummary) => run.training_number ? `T${run.training_number}` : undefined;
const evaluationTag = (evaluation: FypEvaluationSummary) => evaluation.evaluation_number ? `E${evaluation.evaluation_number}` : undefined;
const checkpointLabel = (run?: FypRunSummary) => run?.checkpoint_number ? `C${run.checkpoint_number}` : undefined;
const dateTime = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded';
const duration = (start?: string, end?: string) => {
    if (!start) return 'Not recorded';
    const seconds = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000));
    return Number.isFinite(seconds) ? seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s` : 'Not recorded';
};
const iso = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const format = (value: unknown) => value == null ? '—' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
const reward = (value?: number | null) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—';
const episodeDuration = (value?: number) => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}s` : '—';
const environmentReference = (environment?: FypEnvironment) => environment
    ? `${environment.name} · v${environment.version}`
    : 'Not recorded';

type EvidenceProps = {
    policyId: string;
    mode: 'activity' | 'run' | 'evaluation' | 'evaluations';
    run?: FypRun;
    evaluation?: FypEvaluation;
    history?: HistoryPage;
    live?: boolean;
    onOpenRun?: (runId: string) => void;
    onOpenEvaluation?: (evaluation: FypEvaluationSummary) => void;
    onOpenEnvironment?: (environmentId: string) => void;
    onOpenCheckpoint?: (runId: string) => void;
    evaluationControls?: EvaluationControls;
    onRefreshHistory?: () => void;
};

export function FypV1Evidence({ policyId, mode, run: selectedRun, evaluation: selectedEvaluation,
    history, live, onOpenRun, onOpenEvaluation, onOpenEnvironment, onOpenCheckpoint, evaluationControls, onRefreshHistory }: EvidenceProps) {
    const evaluationRun = selectedRun;
    const evaluationTrainingRun = evaluationRun ?? (selectedEvaluation && {
        run_id: selectedEvaluation.training_run_id, preset: 'Training run', steps: 0, seed: 0, state: '', source_sha256: '',
    });
    const graph = useFypRead<{ training_metrics: TrainingMetric[]; steps_completed: number }>(
        'football_fyp_run_chart', mode === 'run' && selectedRun ? { policyId, runId: selectedRun.run_id } : null,
        live ? 3000 : undefined,
    );
    const stepsCompleted = Math.max(graph.data?.steps_completed ?? 0,
        selectedRun?.steps_completed ?? (selectedRun?.state === 'completed' ? selectedRun.steps : 0));
    if (mode === 'run' && selectedRun) return <section className="fyp-evidence-page fyp-record-detail" aria-label="Training run details">
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
                <Record label="Steps completed" value={`${stepsCompleted.toLocaleString()} / ${selectedRun.steps.toLocaleString()}`} />
                <Record label="Episodes completed" value={selectedRun.episodes_completed} />
                <Record label="Goals scored" value={selectedRun.goals_scored} />
                <Record label="Mean episode reward" value={selectedRun.mean_reward?.toFixed(4)} />
                <Record label="Mean episode duration" value={selectedRun.mean_episode_seconds == null ? undefined : `${selectedRun.mean_episode_seconds.toFixed(1)}s`} />
                <Record label="Training name" value={selectedRun.training_number ? `T${selectedRun.training_number}` : undefined} />
                {selectedRun.parent_run_id && <>
                    <Record label="Checkpoint continuation" value={selectedRun.checkpoint_mode} />
                    <Record label="Parent checkpoint" value={selectedRun.parent_checkpoint_number ? `C${selectedRun.parent_checkpoint_number}` : selectedRun.parent_run_id} />
                    <Record label="Starting step" value={selectedRun.starting_step} />
                    <Record label="Additional steps" value={selectedRun.additional_steps} />
                </>}
                <Record label="Training seed" value={selectedRun.seed} />
                <Record label="Simulation speed" value={`${selectedRun.time_scale ?? 1}×`} />
                <Record label="Policy ID" value={selectedRun.policy_id} />
                <Record label="Policy revision" value={selectedRun.policy_revision} />
                <Record label="Policy record SHA-256" value={selectedRun.policy_record_sha256} />
                <Record label="Checkpoint exported" value={selectedRun.exported_model} />
                <Record label="Checkpoint ID" value={checkpointLabel(selectedRun)} />
                <Record label="Exit code" value={selectedRun.exit_code} />
                <Record label="Source SHA-256" value={selectedRun.source_sha256} />
                <Record label="Model SHA-256" value={selectedRun.model_sha256} />
                <Record label="Checkpoint SHA-256" value={selectedRun.checkpoint_sha256} />
                <Record label="Run ID" value={selectedRun.run_id} />
            </div>
            <div className="fyp-step-progress">
                <div className="fyp-step-progress-label"><strong>Training progress</strong><span>{stepsCompleted.toLocaleString()} / {selectedRun.steps.toLocaleString()} steps</span></div>
                <progress max={selectedRun.steps} value={Math.min(selectedRun.steps, stepsCompleted)} />
            </div>
            <section className="fyp-run-metrics" aria-label="Training reward metrics">
                <h3>Reward during training</h3>
                <p className="fg-muted">MA-POCA mean episode reward and mean group reward from trainer summaries, plotted against trainer steps.</p>
                <FypReadMessage label="Trainer reward summaries" read={graph} />
                {graph.data?.training_metrics.length ? <RewardChart points={graph.data.training_metrics} />
                    : graph.data && <p className="fg-muted">No trainer reward summaries have been recorded for this run.</p>}
                <div className="fyp-chart-legend"><span>Mean reward</span><span>Mean group reward</span></div>
            </section>
            <EpisodeBreakdowns policyId={policyId} runId={selectedRun.run_id} live={live} />
            {selectedRun.policy_snapshot && <details className="fyp-policy-raw"><summary>Plan snapshot used by this run</summary>
                <pre>{JSON.stringify(selectedRun.policy_snapshot, null, 2)}</pre></details>}
            {selectedRun.error && <p className="fg-error">{selectedRun.error}</p>}
    </section>;
    if (mode === 'evaluation' && selectedEvaluation) return <section className="fyp-evidence-page fyp-record-detail" aria-label="Evaluation details">
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
                <Record label="Simulation speed" value={`${selectedEvaluation.time_scale ?? 1}×`} />
                <Record label="Policy ID" value={selectedEvaluation.policy_id} />
                <Record label="Policy revision" value={selectedEvaluation.policy_revision} />
                <Record label="Policy record SHA-256" value={selectedEvaluation.policy_record_sha256} />
                <Record label="Evaluation name" value={selectedEvaluation.evaluation_number ? `E${selectedEvaluation.evaluation_number}` : undefined} />
                <Record label="Checkpoint ID" value={checkpointLabel(evaluationRun)} />
                <Record label="Training run" value={`${trainingTag(evaluationTrainingRun!) ? `${trainingTag(evaluationTrainingRun!)} · ` : ''}${labelForRun(evaluationTrainingRun!)}`} />
                <Record label="Training run ID" value={selectedEvaluation.training_run_id} />
                <Record label="Evaluation ID" value={selectedEvaluation.evaluation_id} />
                <Record label="Exit code" value={selectedEvaluation.exit_code} />
            </div>
            {selectedEvaluation.policy_snapshot && <details className="fyp-policy-raw"><summary>Plan snapshot used by this evaluation</summary>
                <pre>{JSON.stringify(selectedEvaluation.policy_snapshot, null, 2)}</pre></details>}
            {selectedEvaluation.error && <p className="fg-error">{selectedEvaluation.error}</p>}
            <FypEvaluationDiagnostics key={selectedEvaluation.evaluation_id} evaluationId={selectedEvaluation.evaluation_id}
                policyId={selectedEvaluation.policy_id} diagnostics={selectedEvaluation.diagnostics} />
            <EpisodeBreakdowns policyId={policyId} evaluationId={selectedEvaluation.evaluation_id} live={live} />
    </section>;

    if (mode === 'evaluations' && history) {
        return <section className="fyp-checkpoint-evaluations" aria-label="Checkpoint evaluations">
            <div className="fyp-episode-heading">
                <h2 className="fyp-checkpoint-section-title">Evaluations</h2>
                <button className="fg-button" type="button" onClick={() => { history.restart(); onRefreshHistory?.(); }}>Refresh evaluations</button>
            </div>
            {evaluationControls && <div className="fyp-evaluation-launcher">
                <h3>Start a new evaluation</h3>
                <div className="fyp-evaluation-settings">
                    <label className="fyp-field">Episodes
                        <input aria-label="FYP evaluation episodes" type="number" min={1} max={100} step={1} value={evaluationControls.episodes} onChange={event => evaluationControls.onEpisodesChange(Number(event.target.value))} />
                    </label>
                    <label className="fyp-field">Seed
                        <input aria-label="FYP evaluation seed" type="number" min={0} max={2147483647} step={1} value={evaluationControls.seed} onChange={event => evaluationControls.onSeedChange(Number(event.target.value))} />
                    </label>
                    <label className="fyp-field">Simulation speed
                        <select aria-label="FYP evaluation simulation speed" value={evaluationControls.timeScale}
                            onChange={event => evaluationControls.onTimeScaleChange(Number(event.target.value))}>
                            {[1, 2, 3, 5].map(value => <option key={value} value={value}>{value}×</option>)}
                        </select>
                    </label>
                </div>
                <button className="fg-button primary" type="button" disabled={!evaluationControls.canStart} onClick={evaluationControls.onStart}>
                    {evaluationControls.starting ? 'Starting evaluation…' : 'Start evaluation'}
                </button>
                {!evaluationControls.canStart && <p className="fyp-blocker" role="status">{evaluationControls.blocker}</p>}
                {evaluationControls.operationActive && evaluationControls.onViewHome &&
                    <button className="fg-link" type="button" onClick={evaluationControls.onViewHome}>View the active operation on Home →</button>}
            </div>}
            <HistoryRows history={history} onOpenEvaluation={onOpenEvaluation}
                empty="No evaluations recorded for this checkpoint yet." label="Evaluations" />
        </section>;
    }
    if (mode !== 'activity' || !history) return null;
    return <section className="fyp-evidence-page" aria-label="Recent training and evaluation runs">
        <HistoryRows history={history} onOpenRun={onOpenRun} onOpenEvaluation={onOpenEvaluation}
            empty="No training runs or evaluations recorded yet." label="Recent runs" />
    </section>;
}

function HistoryRows({ history, empty, label, onOpenRun, onOpenEvaluation }: {
    history: HistoryPage; empty: string; label: string;
    onOpenRun?: EvidenceProps['onOpenRun']; onOpenEvaluation?: EvidenceProps['onOpenEvaluation'];
}) {
    return <>
        <FypReadMessage label={label} read={history} />
        {history.data && !history.items.length && <p className="fg-muted">{empty}</p>}
        <div className="fyp-evidence-runs" aria-busy={history.loading}>
            {history.items.map(item => 'run_id' in item
                ? <TrainingEvidenceCard key={item.run_id} run={item} onOpen={() => onOpenRun?.(item.run_id)} />
                : <EvaluationEvidenceCard key={item.evaluation_id} evaluation={item} onOpen={() => onOpenEvaluation?.(item)} />)}
        </div>
        <FypPagination label={`${label} pagination`} page={history} />
    </>;
}

function EpisodeBreakdowns({ policyId, runId, evaluationId, live }: {
    policyId: string; runId?: string; evaluationId?: string; live?: boolean;
}) {
    const page = useFypPage<Episode>('football_fyp_episode_page', { policyId, runId, evaluationId, limit: 25 },
        true, live ? 3000 : undefined);
    const label = evaluationId ? 'Recorded episodes' : 'Episode reward breakdowns';
    return <section aria-label={label}>
        <div className="fyp-episode-heading">
            <h3>{label}</h3>
            {!page.followingLatest && <button className="fg-button" type="button" onClick={page.restart}>Refresh episodes</button>}
        </div>
        <FypReadMessage label={label} read={page} />
        {page.data && !page.items.length && <p className="fg-muted">No episode outcomes have been recorded yet.</p>}
        <div className="fyp-episode-breakdown-list" aria-busy={page.loading}>
            {page.items.map((episode, index) => <details className="fyp-episode-breakdown" key={episode.sequence ?? episode.episode ?? episode.index ?? index}>
                <summary><strong>Episode {episode.episode ?? episode.index ?? page.index * 25 + index + 1}</strong>
                    <span>{format(episode.outcome)}</span><span>{episodeDuration(episode.elapsed_seconds)}</span>
                    <span>Total {episode.reward_total == null ? '—' : episode.reward_total.toFixed(4)}</span></summary>
                <div className="fyp-episode-reward-parts">
                    <Record label="Time cost reward" value={episode.time_cost_reward?.toFixed(4)} />
                    <Record label={episode.terminal_reward_type === 'goal' ? 'Goal reward' : 'Terminal reward'} value={episode.terminal_reward?.toFixed(4)} />
                    <Record label="Total reward" value={episode.reward_total?.toFixed(4)} />
                    <Record label="Goals" value={episode.goals} />
                    <Record label="Episode seed" value={episode.seed} />
                </div>
            </details>)}
        </div>
        <FypPagination label={`${label} pagination`} page={page} />
    </section>;
}

function Record({ label, value, exact }: { label: string; value: unknown; exact?: string }) {
    return <div className="fyp-record-field"><small>{label}</small><strong title={exact}>{format(value)}</strong>{exact && <code>{exact}</code>}</div>;
}

function RewardChart({ points }: { points: TrainingMetric[] }) {
    const width = 760, height = 190, left = 48, right = 12, top = 12, bottom = 28;
    const values = points.flatMap(point => [point.mean_reward, point.mean_group_reward]).filter(Number.isFinite);
    let min = Math.min(...values), max = Math.max(...values);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (max - min < 0.001) { min -= 0.05; max += 0.05; }
    else { const pad = (max - min) * .12; min -= pad; max += pad; }
    const x = (index: number) => left + index * (width - left - right) / Math.max(points.length - 1, 1);
    const y = (value: number) => top + (max - value) * (height - top - bottom) / (max - min);
    const polyline = (key: 'mean_reward' | 'mean_group_reward') => points
        .map((point, index) => `${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ');
    const first = points[0], last = points[points.length - 1];
    return <svg className="fyp-reward-chart" viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`Training reward by steps from ${first.step.toLocaleString()} to ${last.step.toLocaleString()}`}>
        <title>Mean training reward by trainer step</title>
        {[0, .5, 1].map(t => {
            const yy = top + t * (height - top - bottom);
            const value = max - t * (max - min);
            return <g key={t}><line className="fyp-reward-chart-grid" x1={left} x2={width - right} y1={yy} y2={yy} />
                <text x={left - 7} y={yy + 4} textAnchor="end">{value.toFixed(2)}</text></g>;
        })}
        <polyline className="fyp-reward-chart-line" points={polyline('mean_reward')} />
        <polyline className="fyp-reward-chart-line group" points={polyline('mean_group_reward')} />
        <text x={left} y={height - 6}>{first.step.toLocaleString()} steps</text>
        <text x={width - right} y={height - 6} textAnchor="end">{last.step.toLocaleString()} steps</text>
    </svg>;
}

function IndexPill({ children, kind }: { children?: string; kind: 'training' | 'evaluation' }) {
    return <span className={`fyp-index-pill fyp-${kind}-pill`}>{children}</span>;
}

export function TrainingEvidenceCard({ run, onOpen }: { run: FypRunSummary & { environment?: FypEnvironment }; onOpen: () => void }) {
    const episodeSummary = `${run.episodes_completed ?? 0} episodes · mean reward ${reward(run.mean_reward)}`;
    return <button className="fyp-evidence-card" type="button" onClick={onOpen}>
        <span><strong>{trainingTag(run) && <IndexPill kind="training">{trainingTag(run)}</IndexPill>}{labelForRun(run)}</strong>
            <small>{dateTime(run.started_at ?? run.finished_at)}</small>
            <small>{run.environment_reference ?? environmentReference(run.environment)}</small></span>
        <span className={`fyp-state fyp-state-${run.state.toLowerCase()}`}>{run.state}</span>
        <span>{run.state === 'completed' ? run.steps.toLocaleString() : `${(run.steps_completed ?? 0).toLocaleString()} / ${run.steps.toLocaleString()}`} steps · {episodeSummary} · seed {run.seed}</span>
    </button>;
}

function EvaluationEvidenceCard({ evaluation, onOpen }: { evaluation: FypEvaluationSummary; onOpen: () => void }) {
    return <button className="fyp-evidence-card" type="button" onClick={onOpen}>
        <span><strong>{evaluationTag(evaluation) && <IndexPill kind="evaluation">{evaluationTag(evaluation)}</IndexPill>}Evaluation</strong>
            <small>{dateTime(evaluation.started_at ?? evaluation.finished_at)}</small>
            <small>{evaluation.environment_reference ?? 'Not recorded'}</small></span>
        <span className={`fyp-state fyp-state-${evaluation.state.toLowerCase()}`}>{evaluation.state}</span>
        <span>{evaluation.episodes_completed ?? 0}/{evaluation.requested_episodes} episodes · {evaluation.goals_scored ?? '—'} goals · seed {evaluation.seed ?? '—'}</span>
    </button>;
}
