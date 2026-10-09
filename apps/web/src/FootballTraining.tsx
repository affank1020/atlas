import { useCallback, useEffect, useMemo, useState } from 'react';
import { callTool } from './api';
import './football-training.css';

type Drill = { id: string; behavior: string; scene: string; observation_size: number; continuous_actions: number; configs: Record<string, string> };
type Job = { id: string; drill: string; preset: string; state: string; mode: string; arenas: number; base_port: number; seed: number; started_at: string };
type Policy = { id: string; drill: string; role: string; source_run_id: string; artifacts: { path: string; final: boolean }[]; indexed_at: string; evaluation: string };
type Launch = { accepted: boolean; ticket: string; drill: string; status: string; note: string };
type LaunchStatus = { ticket: string; state: string; output: string; error: string; note: string; run?: { id?: string } };
const date = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const stateLabel = (value?: string) => (value ?? 'unknown').replaceAll('_', ' ');

export function FootballTraining() {
    const [drills, setDrills] = useState<Drill[]>([]);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [policies, setPolicies] = useState<Policy[]>([]);
    const [selectedDrill, setSelectedDrill] = useState('');
    const [preset, setPreset] = useState<'smoke' | 'full'>('smoke');
    const [arenas, setArenas] = useState(1);
    const [basePort, setBasePort] = useState(5005);
    const [seed, setSeed] = useState(42);
    const [selectedJob, setSelectedJob] = useState('');
    const [selectedPolicy, setSelectedPolicy] = useState('');
    const [logs, setLogs] = useState('');
    const [evalPlan, setEvalPlan] = useState<unknown>();
    const [launch, setLaunch] = useState<Launch>();
    const [launchStatus, setLaunchStatus] = useState<LaunchStatus>();
    const [busy, setBusy] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const refresh = useCallback(async () => {
        const [d, j, p] = await Promise.all([
            callTool<Drill[]>('football_list_drills'),
            callTool<Job[]>('football_list_jobs'),
            callTool<Policy[]>('football_list_policies'),
        ]);
        setDrills(d); setJobs([...j].sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? '')));
        setPolicies(p);
        setSelectedDrill(previous => previous || d[0]?.id || '');
        setSelectedJob(previous => previous || j[0]?.id || '');
        setSelectedPolicy(previous => previous || p[0]?.id || '');
        setError('');
    }, []);
    useEffect(() => {
        let current = true;
        setLoading(true);
        void refresh().catch(e => { if (current) setError(e instanceof Error ? e.message : String(e)); }).finally(() => { if (current) setLoading(false); });
        return () => { current = false; };
    }, [refresh]);
    const currentJob = jobs.find(j => j.id === selectedJob);
    const currentPolicy = policies.find(p => p.id === selectedPolicy);
    const currentDrill = drills.find(d => d.id === selectedDrill);
    const running = useMemo(() => jobs.filter(j => j.state === 'running'), [jobs]);
    const act = async (key: string, work: () => Promise<void>) => {
        setBusy(key); setError(''); setNotice('');
        try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(''); }
    };
    const loadLogs = (runId: string) => act('logs', async () => {
        const result = await callTool<{ text: string }>('football_get_job_logs', { runId, lines: 120 });
        setLogs(result.text); setNotice('Loaded the latest trainer output.');
    });
    const checkLaunch = () => {
        if (!launch) return;
        void act('receipt', async () => {
            const status = await callTool<LaunchStatus>('football_get_launch_status', { runId: launch.ticket });
            setLaunchStatus(status);
            if (status.state === 'submitted') await refresh();
        });
    };
    return <div className="football-app">
        <header className="football-header">
            <div><span className="football-kicker">AI FOOTBALL / TRAINING</span><h1>Training control</h1>
                <p>Local Unity ML-Agents experiments, controlled through the Atlas Node on your Mac.</p></div>
            <button className="football-button quiet" disabled={!!busy || loading} onClick={() => void act('refresh', async () => { await refresh(); setNotice('Training data refreshed.'); })}>↻ Refresh</button>
        </header>
        {error && <div role="alert" className="football-alert error">{error}<small>Ensure the AI Football Workspace is connected and the hosted Mac Node is running the updated football capability.</small></div>}
        {notice && <div role="status" className="football-alert">{notice}</div>}
        {loading && <p role="status" className="football-muted">Connecting to the AI Football Workspace…</p>}
        <div className="football-stats">
            <div><small>Available drills</small><strong>{drills.length}</strong></div>
            <div><small>Running jobs</small><strong>{running.length}</strong></div>
            <div><small>Tracked jobs</small><strong>{jobs.length}</strong></div>
            <div><small>Indexed policies</small><strong>{policies.length}</strong></div>
        </div>
        <div className="football-columns">
            <div className="football-main-column">
                <section className="football-panel">
                    <div className="football-panel-head"><div><span className="football-kicker">01 / TRAIN</span><h2>Launch a headless run</h2></div></div>
                    <p className="football-muted">Choose the drill and a PPO preset. A launch request can take time to build a Unity runner; an accepted request isn't proof training has started.</p>
                    <div className="football-fields">
                        <label className="wide">Drill<select value={selectedDrill} onChange={e => setSelectedDrill(e.target.value)} disabled={!drills.length}>{drills.map(d => <option key={d.id} value={d.id}>{d.id} · {d.behavior}</option>)}</select></label>
                        <label>Preset<select value={preset} onChange={e => setPreset(e.target.value as 'smoke'|'full')}><option value="smoke">Smoke / short</option><option value="full">Full</option></select></label>
                        <label>Arenas<input type="number" min={1} max={16} value={arenas} onChange={e => setArenas(Number(e.target.value))} /></label>
                        <label>Base port<input type="number" min={1024} max={65519} value={basePort} onChange={e => setBasePort(Number(e.target.value))} /></label>
                        <label>Seed<input type="number" min={0} max={2147483647} value={seed} onChange={e => setSeed(Number(e.target.value))} /></label>
                    </div>
                    {currentDrill && <div className="football-contract"><span>Scene: {currentDrill.scene}</span><span>{currentDrill.observation_size} observations</span><span>{currentDrill.continuous_actions} actions</span></div>}
                    <div className="football-actions">
                        <button className="football-button primary" disabled={!selectedDrill || !!busy || loading || !Number.isInteger(arenas) || arenas < 1 || arenas > 16 || !Number.isInteger(basePort) || basePort < 1024 || basePort > 65519 || !Number.isInteger(seed) || seed < 0} onClick={() => void act('launch', async () => {
                            if (!window.confirm(`Request a ${preset} training run for ${selectedDrill} (${arenas} arena${arenas === 1 ? '' : 's'}) on your Mac?`)) return;
                            const result = await callTool<Launch>('football_launch_training', { drill: selectedDrill, preset, arenas, basePort, seed });
                            setLaunch(result); setLaunchStatus(undefined); setNotice('Launch requested. Check the receipt for build or trainer progress.');
                        })}>{busy === 'launch' ? 'Submitting…' : 'Launch training ↗'}</button>
                        <span className="football-muted">Uses the cached standalone Unity training runner where available.</span>
                    </div>
                    {launch && <div className="football-receipt">
                        <div><strong>Latest launch · {launch.drill}</strong><small>Ticket {launch.ticket}</small></div>
                        <button className="football-button quiet" disabled={!!busy} onClick={checkLaunch}>Check receipt</button>
                        {launchStatus && <div className="football-receipt-details"><span>Status: {stateLabel(launchStatus.state)}</span><p>{launchStatus.note}</p>{launchStatus.run?.id && <small>Run: {launchStatus.run.id}</small>}{launchStatus.error && <pre>{launchStatus.error}</pre>}</div>}
                    </div>}
                </section>
                <section className="football-panel">
                    <div className="football-panel-head"><div><span className="football-kicker">02 / MONITOR</span><h2>Training jobs</h2></div><span>{jobs.length} total</span></div>
                    <div className="football-job-list">
                        {jobs.map(job => <button className={`football-job ${selectedJob === job.id ? 'active' : ''}`} key={job.id} onClick={() => { setSelectedJob(job.id); setLogs(''); }}>
                            <span><strong>{job.id}</strong><small>{job.drill} · {job.preset} · {job.arenas} arena{job.arenas === 1 ? '' : 's'}</small></span>
                            <span className={`football-state ${job.state === 'running' ? 'active' : ''}`}>{stateLabel(job.state)}</span>
                        </button>)}
                        {!loading && !jobs.length && <div className="football-empty">No headless training jobs found. Launch a smoke run to get started.</div>}
                    </div>
                    {currentJob && <div className="football-inspector"><h3>{currentJob.id}</h3><p className="football-muted">Started {date(currentJob.started_at)} · port {currentJob.base_port} · seed {currentJob.seed}</p>
                        <div className="football-actions"><button className="football-button quiet" disabled={!!busy} onClick={() => void loadLogs(currentJob.id)}>{busy === 'logs' ? 'Loading…' : 'View latest logs'}</button>
                        <button className="football-button danger" disabled={!!busy || currentJob.state !== 'running'} onClick={() => void act('stop', async () => {
                            if (!window.confirm(`Request a graceful stop for ${currentJob.id}? A checkpoint might be written before exit.`)) return;
                            await callTool('football_stop_training', { runId: currentJob.id });
                            setNotice('Stop signal sent. Refresh jobs and inspect the trainer log before treating the run as stopped.'); await refresh();
                        })}>Stop run</button>
                        <button className="football-button quiet" disabled={!!busy || currentJob.state === 'running'} onClick={() => void act('index', async () => {
                            await callTool('football_index_policy', { runId: currentJob.id });
                            setNotice('Policy artifacts indexed.'); await refresh();
                        })}>Index policy</button></div>
                        {logs && <pre className="football-log">{logs}</pre>}
                    </div>}
                </section>
            </div>
            <div className="football-side-column">
                <section className="football-panel">
                    <div className="football-panel-head"><div><span className="football-kicker">03 / ARTIFACTS</span><h2>Policy library</h2></div></div>
                    {!policies.length && <p className="football-muted">No indexed policies yet. Index a run after an ONNX export becomes available.</p>}
                    {policies.length > 0 && <select className="football-policy-select" value={selectedPolicy} onChange={e => { setSelectedPolicy(e.target.value); setEvalPlan(undefined); }}>{policies.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}</select>}
                    {currentPolicy && <div className="football-policy"><p><strong>Drill</strong><span>{currentPolicy.drill}</span></p><p><strong>Role</strong><span>{currentPolicy.role || 'unassigned'}</span></p><p><strong>Exported artifacts</strong><span>{currentPolicy.artifacts.length}</span></p><p><strong>Evaluated</strong><span>{stateLabel(currentPolicy.evaluation)}</span></p>
                        <button className="football-button quiet" disabled={!!busy} onClick={() => void act('plan', async () => {
                            setEvalPlan(await callTool('football_plan_evaluation', { policyId: currentPolicy.id, episodes: 100, seed: 42 }));
                        })}>Prepare evaluation plan</button>
                        {evalPlan !== undefined && <pre className="football-log">{JSON.stringify(evalPlan, null, 2)}</pre>}
                    </div>}
                </section>
                <section className="football-panel">
                    <div className="football-panel-head"><div><span className="football-kicker">WORKFLOW</span><h2>How it connects</h2></div></div>
                    <div className="football-flow"><p><strong>Atlas Web</strong><small>Launch and monitor experiments</small></p><span>↓</span><p><strong>Atlas Server + MCP</strong><small>Typed operations, project ownership and audit</small></p><span>↓</span><p><strong>Mac Node</strong><small>Executes the existing Python driver</small></p><span>↓</span><p><strong>Unity ML-Agents</strong><small>Standalone arenas, PPO checkpoints and results</small></p></div>
                    <p className="football-muted">Evaluation planning is available now. This interface does not claim accuracy metrics until a real evaluation run has produced them.</p>
                </section>
            </div>
        </div>
    </div>;
}
