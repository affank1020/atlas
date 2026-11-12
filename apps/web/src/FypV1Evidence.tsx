import { useCallback, useEffect, useState } from 'react';
import { callTool } from './api';

type FypRun = { run_id: string; preset: string; steps: number; seed: number; state: string; source_sha256: string; exported_model?: boolean; error?: string };
type FypEvaluation = { evaluation_id: string; training_run_id: string; state: string; requested_episodes: number; episodes_completed?: number; goals_scored?: number; goal_rate?: number; seed?: number; error?: string };

export function FypV1Evidence() {
    const [runs, setRuns] = useState<FypRun[]>([]);
    const [evaluations, setEvaluations] = useState<FypEvaluation[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [updatedAt, setUpdatedAt] = useState('');

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
        void refresh();
        const timer = window.setInterval(() => { void refresh(); }, 3000);
        return () => window.clearInterval(timer);
    }, [refresh]);

    return <section className="fg-panel fyp-evidence-page" aria-label="FYP checkpoint evidence">
        <div className="fg-panel-title">
            <div><p className="fg-eyebrow">FOOTBALLV1 · 25/8</p><h2>FYP checkpoints and evaluations</h2></div>
            <div className="fg-refresh-controls"><span className="fg-refresh-status" role="status">{loading ? 'Loading receipts…' : `Updated ${updatedAt || '—'}`}</span>
                <button className="fg-button" type="button" onClick={() => void refresh()}>Refresh evidence</button></div>
        </div>
        <p className="fg-muted">Training and evaluation receipts are grouped by their source checkpoint. A completed export is a candidate model; these results do not approve or promote it.</p>
        {error && <p className="fg-error" role="alert">{error}</p>}
        {!loading && !runs.length && <p className="fg-muted">No FYP FootballV1 training receipts are available yet.</p>}
        <div className="fyp-evidence-runs">{runs.map(run => {
            const runEvaluations = evaluations.filter(evaluation => evaluation.training_run_id === run.run_id);
            return <article className="fyp-evidence-run" key={run.run_id}>
                <div className="fyp-run-summary">
                    <div><strong>{run.preset === 'smoke' ? 'Smoke run' : run.preset === 'pilot_50k' ? '50k pilot' : run.preset}</strong>
                        <small>{run.run_id}</small></div>
                    <span className={`fyp-state fyp-state-${run.state.toLowerCase()}`}>{run.state}</span>
                </div>
                <div className="fyp-evidence-metadata">
                    <span>{run.steps.toLocaleString()} steps</span><span>Training seed {run.seed}</span>
                    <span>{run.exported_model === true ? 'ONNX exported' : 'No ONNX export recorded'}</span>
                    <span>Source {run.source_sha256.slice(0, 14)}</span>
                </div>
                {run.error && <p className="fg-error">{run.error}</p>}
                <h3>Checkpoint evaluations</h3>
                {!runEvaluations.length ? <p className="fg-muted">No evaluation receipt is linked to this checkpoint.</p> :
                    <ul className="fyp-evaluation-receipts">{runEvaluations.map(evaluation => <li key={evaluation.evaluation_id}>
                        <div className="fyp-run-summary"><strong>{evaluation.state}</strong><small>{evaluation.evaluation_id}</small></div>
                        <span>{evaluation.episodes_completed ?? 0}/{evaluation.requested_episodes} episodes</span>
                        {evaluation.goals_scored != null && <span> · {evaluation.goals_scored} goals ({Math.round((evaluation.goal_rate ?? 0) * 100)}%)</span>}
                        {evaluation.seed != null && <span> · evaluation seed {evaluation.seed}</span>}
                        {evaluation.error && <p className="fg-error">{evaluation.error}</p>}
                    </li>)}</ul>}
            </article>;
        })}</div>
    </section>;
}
