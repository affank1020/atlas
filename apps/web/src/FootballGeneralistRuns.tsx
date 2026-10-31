import { useEffect, useState } from 'react';
import { callTool } from './api';
import { SkeletonRows } from './Skeletons';

type Run = {
    id: string; family: string; scenario?: string; state: string;
    started_at?: string; seed?: number; num_envs?: number;
    checkpoints?: number; output_dir?: string;
};

/** Generalist-only run catalogue. The old specialist driver is not queried here. */
export function FootballGeneralistRuns() {
    const [runs, setRuns] = useState<Run[]>([]);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let mounted = true;
        const load = () => void callTool<Run[]>('football_generalist_runs').then(data => {
            if (mounted) { setRuns(data); setError(''); setLoading(false); }
        }).catch(e => {
            if (mounted) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
        });
        load();
        const interval = window.setInterval(load, 10000);
        return () => { mounted = false; window.clearInterval(interval); };
    }, []);
    return <section className="football-panel" aria-label="Generalist training runs">
        <div className="football-panel-head"><h2>Generalist runs</h2><span>{loading && !runs.length ? "—" : runs.length} discovered</span></div>
        <p className="football-muted">Runs are discovered from the generalist trainer receipts, including those started outside Atlas. Unknown means process state has not been verified.</p>
        {loading && !runs.length && !error && <SkeletonRows label="Loading generalist runs" variant="run" rows={4} />}
        {error && <p role="alert">{error}</p>}
        {!loading && !error && runs.length === 0 && <p>No generalist training receipts found.</p>}
        {runs.length > 0 && <div className="football-run-list">{runs.map(run =>
            <div key={run.id} className="football-run-row">
                <strong>{run.id}</strong>
                <span>{run.scenario ?? 'Scenario unavailable'}</span>
                <span>{run.state}</span>
                <span>{run.checkpoints ?? 0} ONNX files detected</span>
                <small>{run.output_dir}</small>
            </div>)}</div>}
    </section>;
}
