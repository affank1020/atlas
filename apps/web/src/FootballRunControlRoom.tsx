import { useEffect, useMemo, useRef, useState } from 'react';
import { callTool } from './api';
import './football-control-room.css';

export type RoomJob = {
    id: string; drill: string; preset: string; state: string; arenas: number;
    seed: number; base_port: number; started_at: string; curriculum_stage?: number;
    curriculum_stage_id?: string | null; config_sha256?: string;
};
export type RoomPolicy = { id: string; drill: string; source_run_id: string; artifacts?: { path: string; final: boolean }[] };
export type RoomEvaluation = {
    id: string; policy_id: string; drill: string; episodes: number; seed: number;
    success_rate?: number; mean_reward?: number; contact_episodes?: number;
    controlled_progress_mean_m?: number; curriculum_stage?: number;
};
type RoomProps = {
    runId: string; onBack: () => void; onWatch: (runId: string) => void;
    onStop: (runId: string) => void; onIndex: (runId: string) => void;
    onEvaluate: (policyId: string) => void;
    policies: RoomPolicy[]; evaluations: RoomEvaluation[];
};
type Sample = { step: number; seconds: number; reward: number; deviation: number };
type ParsedLog = { budget?: number; samples: Sample[]; checkpoints: { step?: number; filename: string }[]; finalModel?: string };

export function parseFootballTrainingLog(text: string): ParsedLog {
    const budget = Number(/max_steps:\s*(\d+)/.exec(text)?.[1]);
    const samples: Sample[] = [];
    const metric = /Step:\s*(\d+)\.\s*Time Elapsed:\s*([\d.]+)\s*s\.\s*Mean Reward:\s*([-\d.]+)\.\s*Std of Reward:\s*([-\d.]+)/g;
    for (const match of text.matchAll(metric)) samples.push({
        step: Number(match[1]), seconds: Number(match[2]), reward: Number(match[3]), deviation: Number(match[4]),
    });
    const checkpoints = [...text.matchAll(/\[INFO\] Exported\s+([^\n]+?\.onnx)/g)].map(match => ({
        filename: match[1].split('/').pop() ?? '',
        step: Number(/-(\d+)\.onnx$/.exec(match[1])?.[1]) || undefined,
    }));
    const finalModel = /\[INFO\] Copied\s+.+?\s+to\s+([^\n]+?\.onnx)/.exec(text)?.[1]?.split('/').pop();
    return { budget: Number.isFinite(budget) && budget > 0 ? budget : undefined, samples, checkpoints, finalModel };
}

function Completion({ job, log }: { job: RoomJob; log: ParsedLog }) {
    if (job.state === 'running') return <span className="football-room-state online">Running</span>;
    const lastStep = Math.max(0, ...log.samples.map(s => s.step), ...log.checkpoints.map(c => c.step ?? 0));
    if (log.budget && lastStep >= log.budget && log.finalModel) {
        return <span className="football-room-state done" title="Derived from step limit and final ONNX export; a structured driver completion reason is not yet available.">Likely completed</span>;
    }
    return <span className="football-room-state">Inactive — reason unknown</span>;
}

function formatDuration(seconds?: number) {
    if (seconds === undefined || !Number.isFinite(seconds)) return '—';
    return seconds >= 60 ? String(Math.floor(seconds / 60)) + 'm ' + String(Math.round(seconds % 60)) + 's' : seconds.toFixed(1) + 's';
}
function number(value?: number, digits = 0) {
    return value === undefined || !Number.isFinite(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function RewardChart({ samples }: { samples: Sample[] }) {
    if (!samples.length) return <p className="football-room-empty">No training metric samples have been reported yet.</p>;
    const width = 750, height = 210, pad = 28;
    const minX = Math.min(0, ...samples.map(s => s.step)), maxX = Math.max(1, ...samples.map(s => s.step));
    const rawMin = Math.min(...samples.map(s => s.reward)), rawMax = Math.max(...samples.map(s => s.reward));
    const range = Math.max(0.08, rawMax - rawMin), minY = rawMin - range * .2, maxY = rawMax + range * .2;
    const x = (v: number) => pad + (v - minX) / Math.max(1, maxX - minX) * (width - pad * 2);
    const y = (v: number) => height - pad - (v - minY) / (maxY - minY) * (height - pad * 2);
    const points = samples.map(s => String(x(s.step)) + ',' + String(y(s.reward))).join(' ');
    return <svg className="football-room-chart" viewBox={'0 0 ' + width + ' ' + height} role="img" aria-label="Mean reward by training step">
        {[0, .5, 1].map(r => <g key={r}>
            <line x1={pad} x2={width - pad} y1={pad + r * (height - pad * 2)} y2={pad + r * (height - pad * 2)} stroke="currentColor" opacity=".11" />
        </g>)}
        <polyline points={points} fill="none" stroke="var(--accent, #818cf8)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
        {samples.map(s => <circle key={s.step} cx={x(s.step)} cy={y(s.reward)} r="3.7" fill="var(--accent, #818cf8)"><title>{number(s.step)} steps · reward {number(s.reward, 3)}</title></circle>)}
        <text x={pad} y={height - 5} fill="currentColor" fontSize="11">{number(minX)} steps</text>
        <text x={width - pad} y={height - 5} fill="currentColor" fontSize="11" textAnchor="end">{number(maxX)} steps</text>
        <text x={pad + 3} y={17} fill="currentColor" fontSize="11">{number(maxY, 3)}</text>
    </svg>;
}

export function FootballRunControlRoom({ runId, onBack, onWatch, onStop, onIndex, onEvaluate, policies, evaluations }: RoomProps) {
    const [job, setJob] = useState<RoomJob | undefined>();
    const [logText, setLogText] = useState('');
    const [error, setError] = useState('');
    const [lastUpdated, setLastUpdated] = useState<Date | undefined>();
    const [following, setFollowing] = useState(true);
    const [search, setSearch] = useState('');
    const [activeTab, setActiveTab] = useState<'logs' | 'checkpoints'>('logs');
    const [showInfo, setShowInfo] = useState(true);
    const consoleRef = useRef<HTMLDivElement>(null);
    const parsed = useMemo(() => parseFootballTrainingLog(logText), [logText]);
    const last = parsed.samples[parsed.samples.length - 1];
    const step = Math.max(0, last?.step ?? 0, ...parsed.checkpoints.map(c => c.step ?? 0));
    const progress = parsed.budget ? Math.min(100, 100 * step / parsed.budget) : undefined;
    const linked = policies.find(p => p.source_run_id === runId);
    const linkedEvaluations = linked ? evaluations.filter(e => e.policy_id === linked.id) : [];
    const lines = useMemo(() => logText.split(/\r?\n/).filter(line => {
        return (!search || line.toLowerCase().includes(search.toLowerCase())) && (showInfo || !line.startsWith('[INFO]'));
    }), [logText, search, showInfo]);

    useEffect(() => {
        let disposed = false;
        let working = false;
        const poll = async () => {
            if (working) return;
            working = true;
            try {
                const [jobs, logs] = await Promise.all([
                    callTool<RoomJob[]>('football_list_jobs'),
                    callTool<{ text: string }>('football_get_job_logs', { runId, lines: 200 }),
                ]);
                if (!disposed) {
                    setJob(jobs.find(j => j.id === runId));
                    setLogText(logs.text ?? '');
                    setLastUpdated(new Date());
                    setError('');
                }
            } catch (e) {
                if (!disposed) setError(e instanceof Error ? e.message : String(e));
            } finally { working = false; }
        };
        void poll();
        const timer = window.setInterval(() => { if (!document.hidden) void poll(); }, 3500);
        return () => { disposed = true; window.clearInterval(timer); };
    }, [runId]);

    useEffect(() => {
        if (following && activeTab === 'logs' && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }, [logText, following, activeTab]);

    return <main className="football-room">
        <div className="football-room-heading">
            <div>
                <button className="football-room-back" onClick={onBack}>← All runs</button>
                <span className="football-kicker">EXPERIMENT CONTROL ROOM</span>
                <h2>{job ? job.drill.replaceAll('_', ' ') : 'Training run'}</h2>
                <p>{job?.curriculum_stage_id ? 'Stage ' + job.curriculum_stage + ' · ' + job.curriculum_stage_id.replaceAll('_', ' ') : job?.preset ?? 'Loading'} · {runId}</p>
            </div>
            <div className="football-room-actions">
                {job && <Completion job={job} log={parsed} />}
                <button className="football-button quiet" disabled={job?.state !== 'running'} onClick={() => onWatch(runId)}>Watch on Mac ↗</button>
                {job?.state === 'running' && <button className="football-button danger" onClick={() => onStop(runId)}>Stop run</button>}
                {job?.state !== 'running' && <button className="football-button quiet" onClick={() => onIndex(runId)}>Index policy</button>}
            </div>
        </div>
        {error && <div className="football-alert error" role="alert">Unable to refresh live data: {error}. Last available data is retained.</div>}
        <div className="football-room-meta">
            <span>{job?.arenas ?? '—'} arenas</span><span>Seed {job?.seed ?? '—'}</span><span>Port {job?.base_port ?? '—'}</span>
            <span>{job?.started_at ? new Date(job.started_at).toLocaleString() : '—'}</span>
            <span>{lastUpdated ? 'Updated ' + lastUpdated.toLocaleTimeString() : 'Connecting…'}</span>
        </div>
        <div className="football-room-metrics">
            <div><small>Training steps</small><strong>{number(step)} <em>/ {number(parsed.budget)}</em></strong></div>
            <div><small>Reported elapsed</small><strong>{formatDuration(last?.seconds)}</strong></div>
            <div><small>Steps per second</small><strong>{last?.seconds ? number(last.step / last.seconds, 1) : '—'}</strong></div>
            <div><small>Latest mean reward</small><strong>{number(last?.reward, 3)}</strong></div>
            <div><small>Physical contact success</small><strong>—</strong><small>Not exposed by trainer logs</small></div>
        </div>
        <div className="football-room-progress"><div style={{ width: String(progress ?? 0) + '%' }} /></div>
        <div className="football-room-grid">
            <section className="football-room-panel">
                <header><h3>Reward over time</h3><span>Training · not evaluation</span></header>
                <RewardChart samples={parsed.samples} />
                <div className="football-room-note">These are ML-Agents training summaries. They do not establish contact success or curriculum readiness.</div>
            </section>
            <section className="football-room-panel">
                <header><h3>Run details</h3><span>Reproducibility</span></header>
                <dl className="football-room-details">
                    <dt>Drill / preset</dt><dd>{job?.drill ?? '—'} / {job?.preset ?? '—'}</dd>
                    <dt>Final export</dt><dd>{parsed.finalModel ?? 'Not reported'}</dd>
                    <dt>Config hash</dt><dd className="football-room-hash">{job?.config_sha256 ?? '—'}</dd>
                    <dt>Indexed policy</dt><dd>{linked?.id ?? 'Not indexed'}</dd>
                    <dt>Evaluations</dt><dd>{linkedEvaluations.length}</dd>
                </dl>
                {linked && <button className="football-button primary" onClick={() => onEvaluate(linked.id)}>Evaluate indexed policy →</button>}
            </section>
        </div>
        <section className="football-room-panel">
            <header>
                <div className="football-room-tabs">
                    <button className={activeTab === 'logs' ? 'selected' : ''} onClick={() => setActiveTab('logs')}>Trainer console</button>
                    <button className={activeTab === 'checkpoints' ? 'selected' : ''} onClick={() => setActiveTab('checkpoints')}>Checkpoint timeline ({parsed.checkpoints.length})</button>
                </div>
                <span>{job?.state === 'running' ? 'Auto-refresh every 3.5s' : 'Historical logs · refreshes every 3.5s'}</span>
            </header>
            {activeTab === 'logs' ? <>
                <div className="football-room-log-controls">
                    <label><input type="checkbox" checked={following} onChange={e => setFollowing(e.target.checked)} /> Follow latest</label>
                    <label><input type="checkbox" checked={showInfo} onChange={e => setShowInfo(e.target.checked)} /> Show INFO</label>
                    <input aria-label="Search training logs" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search output…" />
                    <button className="football-button quiet" onClick={() => navigator.clipboard?.writeText(logText)}>Copy logs</button>
                </div>
                <div className="football-room-console" ref={consoleRef} role="log" aria-live="off">
                    <pre>{lines.join('\n') || 'No matching logs yet.'}</pre>
                </div>
            </> : <div className="football-room-timeline">
                {parsed.checkpoints.map((c, i) => <div key={i}><span>●</span><strong>{c.step ? number(c.step) + ' steps' : 'Final artifact'}</strong><code>{c.filename}</code></div>)}
                {!parsed.checkpoints.length && <p>No exported checkpoints reported yet.</p>}
            </div>}
        </section>
        <p className="football-room-footnote">Telemetry is currently near-live polling of bounded trainer logs. Structured per-episode measurements, terminal reasons and server-pushed events need driver/backend support.</p>
    </main>;
}

export function FootballEvaluationControlRoom({ evaluation, onBack }: { evaluation: RoomEvaluation; onBack: () => void }) {
    return <main className="football-room">
        <div className="football-room-heading">
            <div><button className="football-room-back" onClick={onBack}>← Evaluation history</button>
                <span className="football-kicker">EVALUATION CONTROL ROOM</span>
                <h2>{evaluation.drill.replaceAll('_', ' ')}</h2>
                <p>{evaluation.id} · policy {evaluation.policy_id}</p>
            </div>
            <span className="football-room-state done">Result recorded</span>
        </div>
        <div className="football-room-metrics">
            <div><small>Episodes</small><strong>{number(evaluation.episodes)}</strong></div>
            <div><small>Success rate</small><strong>{number(evaluation.success_rate === undefined ? undefined : evaluation.success_rate * 100, 1)}%</strong></div>
            <div><small>Mean reward</small><strong>{number(evaluation.mean_reward, 3)}</strong></div>
            <div><small>Physical contact episodes</small><strong>{number(evaluation.contact_episodes)} <em>/ {number(evaluation.episodes)}</em></strong></div>
            <div><small>Controlled progress</small><strong>{number(evaluation.controlled_progress_mean_m, 3)} m</strong></div>
        </div>
        <section className="football-room-panel">
            <header><h3>Evaluation record</h3><span>Seeded inference · final results</span></header>
            <dl className="football-room-details">
                <dt>Seed</dt><dd>{evaluation.seed}</dd>
                <dt>Curriculum stage</dt><dd>{evaluation.curriculum_stage || 'Legacy baseline'}</dd>
                <dt>Policy ID</dt><dd className="football-room-hash">{evaluation.policy_id}</dd>
                <dt>Result ID</dt><dd className="football-room-hash">{evaluation.id}</dd>
            </dl>
            <p className="football-room-note">Episode-by-episode live progress is not yet emitted by the current evaluator. This page displays its saved measured result, not inferred intermediate values.</p>
        </section>
    </main>;
}
