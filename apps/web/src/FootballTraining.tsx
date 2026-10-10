import { useCallback, useEffect, useMemo, useState } from 'react';
import { callTool } from './api';
import { FootballRunControlRoom, FootballEvaluationControlRoom } from './FootballRunControlRoom';
import './football-training.css';

type CurriculumStage = { id: string; preset: string; stage: number; title: string; description: string; metric: string };
type Drill = { id: string; behavior: string; scene: string; observation_size: number; continuous_actions: number; configs: Record<string, string>; curriculum?: { version: number; mode: string; stages: CurriculumStage[] } };
type Job = { id: string; drill: string; preset: string; state: string; mode: string; arenas: number; base_port: number; seed: number; started_at: string; curriculum_stage?: number; curriculum_stage_id?: string | null };
type Policy = { id: string; drill: string; role: string; source_run_id: string; artifacts: { path: string; final: boolean }[]; indexed_at: string; evaluation: string };
type Launch = { accepted: boolean; ticket: string; drill: string; status: string; note: string };
type LaunchStatus = { ticket: string; state: string; output: string; error: string; note: string; run?: { id?: string; state?: string } };
type Evaluation = { id: string; policy_id: string; drill: string; seed: number; episodes: number; success_rate: number; mean_reward: number; curriculum_stage?: number; contact_episodes?: number; controlled_progress_mean_m?: number; scenario_version?: number; evaluation_kind?: string; baseline_mode?: string };
type Viewer = { id: string; mode: string; policy_id?: string; source_run_id?: string; drill?: string; arenas?: number; state: string; started_at: string };
type Screen = 'overview' | 'drills' | 'train' | 'runs' | 'evaluation' | 'policies' | 'viewer';
const screens: { id: Screen; label: string; note: string }[] = [
    { id: 'overview', label: 'Overview', note: 'Lab activity' },
    { id: 'drills', label: 'Drills', note: 'Skill catalogue' },
    { id: 'train', label: 'Train', note: 'New experiment' },
    { id: 'runs', label: 'Runs', note: 'Monitor & archive' },
    { id: 'evaluation', label: 'Evaluation', note: 'Benchmark policies' },
    { id: 'policies', label: 'Policies', note: 'Model library' },
    { id: 'viewer', label: 'Watch', note: 'Visual playback' },
];
const drillInfo: Record<string, { title: string; description: string; diagram: string }> = {
    movement_v1: { title: 'Movement', description: 'Navigate changing waypoints while learning control and orientation.', diagram: 'WAYPOINT' },
    ball_control_v1: { title: 'Ball control', description: 'Approach and guide the ball into a target area using controlled touches.', diagram: 'CONTROL' },
    shooting_v1: { title: 'Shooting', description: 'Position, approach and strike the ball towards goal.', diagram: 'GOAL' },
    passing_v1: { title: 'Passing', description: 'Deliver the ball into a target zone. Currently a zone-based drill, not a teammate receiver.', diagram: 'TARGET' },
    defending_v1: { title: 'Defending', description: 'Intercept a moving ball before it escapes. Currently no intelligent opponent.', diagram: 'INTERCEPT' },
    receiving_v1: { title: 'Receiving', description: 'Move into a seeded incoming pass and make a real physical reception. Uses a virtual scripted feed.', diagram: 'RECEIVE' },
};
const titleFor = (id: string) => drillInfo[id]?.title ?? id.replaceAll('_', ' ');
const scenarioLabel = (version?: number) => version === 3 ? 'Scenario v3 · wide-angle holdout' : version === 2 ? 'Scenario v2 · centred' : version ? `Scenario v${version}` : 'Legacy scenario';
const date = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const stateLabel = (value?: string) => (value ?? 'unknown').replaceAll('_', ' ');

export function FootballTraining() {
    const [drills, setDrills] = useState<Drill[]>([]);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [policies, setPolicies] = useState<Policy[]>([]);
    const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
    const [viewers, setViewers] = useState<Viewer[]>([]);
    const [screen, setScreen] = useState<Screen>(() => new URLSearchParams(window.location.search).has('run') ? 'runs' : 'overview');
    const [openRunId, setOpenRunId] = useState(() => new URLSearchParams(window.location.search).get('run') ?? '');
    const [openEvaluationId, setOpenEvaluationId] = useState('');
    const [runFilter, setRunFilter] = useState<'active' | 'recent' | 'archive' | 'all'>('active');
    const [runSearch, setRunSearch] = useState('');
    const [filterDrill, setFilterDrill] = useState('');
    const [policySearch, setPolicySearch] = useState('');
    const [episodes, setEpisodes] = useState(100);
    const [evalSeed, setEvalSeed] = useState(123);
    const [viewerArenas, setViewerArenas] = useState(1);
    const [viewerSeed, setViewerSeed] = useState(42);
    const [evaluationLaunch, setEvaluationLaunch] = useState<Launch>();
    const [evaluationStatus, setEvaluationStatus] = useState<LaunchStatus>();
    const [viewerLaunch, setViewerLaunch] = useState<Launch>();
    const [viewerStatus, setViewerStatus] = useState<LaunchStatus>();
    const [selectedDrill, setSelectedDrill] = useState('');
    const [preset, setPreset] = useState('smoke');
    const [arenas, setArenas] = useState(1);
    const [basePort, setBasePort] = useState(5005);
    const [seed, setSeed] = useState(42);
    const [selectedJob, setSelectedJob] = useState('');
    const [selectedPolicy, setSelectedPolicy] = useState('');
    const [logs, setLogs] = useState('');
    const [evalPlan, setEvalPlan] = useState<unknown>();
    const [baselineMode, setBaselineMode] = useState<'zero' | 'random' | 'forward' | 'scripted'>('forward');
    const [replayEpisode, setReplayEpisode] = useState(0);
    const [launch, setLaunch] = useState<Launch>();
    const [launchStatus, setLaunchStatus] = useState<LaunchStatus>();
    const [busy, setBusy] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const refresh = useCallback(async () => {
        const [d, j, p, e, v] = await Promise.all([
            callTool<Drill[]>('football_list_drills'),
            callTool<Job[]>('football_list_jobs'),
            callTool<Policy[]>('football_list_policies'),
            callTool<Evaluation[]>('football_list_evaluations'),
            callTool<Viewer[]>('football_list_viewers'),
        ]);
        setDrills(d); setJobs([...j].sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? '')));
        setPolicies(p);
        setEvaluations(e); setViewers(v);
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
    // Preset labels and curriculum definitions come from the Mac's registry,
    // not from a second set of frontend hardcoded scenario settings.
    const selectedPreset = currentDrill?.configs[preset] ? preset : 'smoke';
    const selectedStage = currentDrill?.curriculum?.stages.find(s => s.preset === selectedPreset);
    const presetLabel = (value: string) => currentDrill?.curriculum?.stages.find(s => s.preset === value)?.title ??
        (value === 'smoke' ? (currentDrill?.curriculum ? 'Smoke / short (legacy v1)' : 'Smoke / short') :
        value === 'full' ? (currentDrill?.curriculum ? 'Full (legacy v1)' : 'Full') : value.replaceAll('_', ' '));
    const running = useMemo(() => jobs.filter(j => j.state === 'running'), [jobs]);
    const recentCutoff = Date.now() - 7 * 86400_000;
    const filteredJobs = jobs.filter(job => {
        const isActive = job.state === 'running';
        const isRecent = !!job.started_at && Date.parse(job.started_at) >= recentCutoff;
        const sectionMatch = runFilter === 'all' || (runFilter === 'active' && isActive) ||
            (runFilter === 'recent' && isRecent) || (runFilter === 'archive' && !isActive && !isRecent);
        return sectionMatch && (!filterDrill || job.drill === filterDrill) &&
            (job.id + ' ' + job.drill + ' ' + job.preset).toLowerCase().includes(runSearch.toLowerCase());
    });
    const visiblePolicies = policies.filter(policy =>
        (!filterDrill || policy.drill === filterDrill) &&
        (policy.id + ' ' + policy.drill + ' ' + policy.source_run_id).toLowerCase().includes(policySearch.toLowerCase()));
    const openRun = (id: string) => {
        setOpenRunId(id); setSelectedJob(id); setScreen('runs');
        const url = new URL(window.location.href); url.searchParams.set('run', id);
        window.history.replaceState(window.history.state, '', url);
    };
    const closeRun = () => {
        setOpenRunId(''); const url = new URL(window.location.href);
        url.searchParams.delete('run'); window.history.replaceState(window.history.state, '', url);
    };
    const navigate = (to: Screen) => { closeRun(); setOpenEvaluationId(''); setScreen(to); setError(''); setNotice(''); };
    const act = async (key: string, work: () => Promise<void>) => {
        setBusy(key); setError(''); setNotice('');
        try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(''); }
    };
    const loadLogs = (runId: string) => act('logs', async () => {
        const result = await callTool<{ text: string }>('football_get_job_logs', { runId, lines: 120 });
        setLogs(result.text); setNotice('Loaded the latest trainer output.');
    });
    const launchViewer = (mode: 'live' | 'policy', id: string) => void act('viewer', async () => {
        if (!window.confirm(mode === 'live'
            ? 'Open a live telemetry viewer for ' + id + ' on your connected Mac? PPO will continue independently.'
            : 'Launch the graphical policy viewer for ' + id + ' on your connected Mac?')) return;
        const result = mode === 'live'
            ? await callTool<Launch>('football_watch_live', { runId: id })
            : await callTool<Launch>('football_open_policy_viewer', { policyId: id, arenas: viewerArenas, seed: viewerSeed });
        setViewerLaunch(result); setViewerStatus(undefined);
        setNotice('Viewer requested on the Mac. Check its launch receipt for progress.');
        setScreen('viewer');
    });
    const checkViewer = () => {
        if (!viewerLaunch) return;
        void act('viewer_status', async () => {
            const status = await callTool<LaunchStatus>('football_get_viewer_launch_status', { runId: viewerLaunch.ticket });
            setViewerStatus(status); if (status.state === 'completed') await refresh();
        });
    };
    useEffect(() => {
        if (!evaluationLaunch?.ticket) return;
        let disposed = false;
        let fetching = false;
        const poll = async () => {
            if (fetching || disposed) return;
            fetching = true;
            try {
                const status = await callTool<LaunchStatus>('football_get_evaluation_status', { runId: evaluationLaunch.ticket });
                if (!disposed) {
                    setEvaluationStatus(status);
                    if (status.state === 'completed') {
                        window.clearInterval(timer);
                        await refresh();
                    } else if (status.state === 'stopped_or_failed') window.clearInterval(timer);
                }
            } catch (e) {
                if (!disposed) setError(e instanceof Error ? e.message : String(e));
            } finally { fetching = false; }
        };
        const timer = window.setInterval(() => { if (!document.hidden) void poll(); }, 4000);
        void poll();
        return () => { disposed = true; window.clearInterval(timer); };
    }, [evaluationLaunch?.ticket, refresh]);
    const checkEvaluation = () => {
        if (!evaluationLaunch) return;
        void act('evaluation_status', async () => {
            const status = await callTool<LaunchStatus>('football_get_evaluation_status', { runId: evaluationLaunch.ticket });
            setEvaluationStatus(status); if (status.state === 'completed') await refresh();
        });
    };
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
            <div><span className="football-kicker">AI FOOTBALL / LAB</span><h1>Football Training</h1>
                <p>Train, evaluate and inspect your Unity football agents from one research workspace.</p></div>
            <button className="football-button quiet" disabled={!!busy || loading} onClick={() => void act('refresh', async () => { await refresh(); setNotice('Training data refreshed.'); })}>↻ Refresh</button>
        </header>
        {error && <div role="alert" className="football-alert error">{error}<small>Ensure the AI Football Workspace is connected and the hosted Mac Node is running the updated football capability.</small></div>}
        {notice && <div role="status" className="football-alert">{notice}</div>}
        {loading && <p role="status" className="football-muted">Connecting to the AI Football Workspace…</p>}
        <nav className="football-navigation" aria-label="Football Training sections">
            {screens.map(item => <button type="button" key={item.id} className={screen === item.id ? 'selected' : ''} aria-current={screen === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
                <strong>{item.label}</strong><small>{item.note}</small>
            </button>)}
        </nav>
        {screen === 'overview' && <div className="football-welcome">
            <span className="football-kicker">RESEARCH WORKSPACE</span>
            <h2>Training pipeline</h2>
            <p>Configure a drill, launch PPO training, inspect checkpoints, measure inference performance and open a separate Unity visualiser on the connected Mac.</p>
            <div className="football-actions">
                <button className="football-button primary" onClick={() => navigate('train')}>New training run →</button>
                <button className="football-button quiet" onClick={() => navigate('runs')}>Monitor runs →</button>
                <button className="football-button quiet" onClick={() => navigate('viewer')}>Open viewer →</button>
            </div>
        </div>}
        {screen === 'overview' && <div className="football-stats">
            <div><small>Available drills</small><strong>{drills.length}</strong></div>
            <div><small>Running jobs</small><strong>{running.length}</strong></div>
            <div><small>Tracked jobs</small><strong>{jobs.length}</strong></div>
            <div><small>Indexed policies</small><strong>{policies.length}</strong></div>
        </div>}
        {screen === 'drills' && <section className="football-panel football-overview-panel">
            <div className="football-panel-head"><div><span className="football-kicker">SKILL DEVELOPMENT</span><h2>Training drills</h2></div><span>{drills.length} scenarios</span></div>
            <div className="football-card-grid">
                {drills.map((drill, i) => <button type="button" key={drill.id} className={`football-drill-card ${selectedDrill === drill.id ? 'selected' : ''}`} onClick={() => setSelectedDrill(drill.id)}>
                    <div className="football-card-top"><span className="football-card-number">{String(i + 1).padStart(2, '0')}</span><span className="football-card-tag">{drill.observation_size} obs · {drill.continuous_actions} actions</span></div>
                    <svg className="football-mini-pitch" viewBox="0 0 240 110" role="img" aria-label={`Diagram of ${titleFor(drill.id)} practice`}>
                        <rect x="7" y="7" width="226" height="96" rx="5" fill="none" stroke="currentColor" strokeOpacity=".23" strokeWidth="1.5"/>
                        <path d="M120 7 V103" stroke="currentColor" strokeOpacity=".18"/><circle cx="120" cy="55" r="19" fill="none" stroke="currentColor" strokeOpacity=".18"/>
                        {drill.id === 'movement_v1' && <><circle cx="40" cy="76" r="8" fill="#8eb0f4"/><circle cx="190" cy="27" r="9" fill="none" stroke="#85baa5" strokeWidth="2"/><path d="M52 73 Q100 65 115 37 T181 29" fill="none" stroke="#85baa5" strokeDasharray="6 5" strokeWidth="2.5"/></>}
                        {drill.id === 'ball_control_v1' && <><circle cx="49" cy="72" r="8" fill="#8eb0f4"/><circle cx="68" cy="65" r="4" fill="#e6e9ed"/><rect x="174" y="18" width="34" height="34" rx="4" fill="none" stroke="#85baa5" strokeWidth="2"/><path d="M71 65 Q101 79 116 54 T190 36" fill="none" stroke="#85baa5" strokeDasharray="5 5" strokeWidth="2.5"/></>}
                        {drill.id === 'shooting_v1' && <><circle cx="48" cy="77" r="8" fill="#8eb0f4"/><circle cx="76" cy="65" r="4" fill="#e6e9ed"/><rect x="225" y="38" width="9" height="35" fill="none" stroke="#85baa5" strokeWidth="2"/><path d="M81 63 L221 54" fill="none" stroke="#85baa5" strokeWidth="2.5"/><path d="M211 49 L222 54 L211 60" fill="none" stroke="#85baa5" strokeWidth="2"/></>}
                        {drill.id === 'passing_v1' && <><circle cx="38" cy="60" r="8" fill="#8eb0f4"/><circle cx="56" cy="56" r="4" fill="#e6e9ed"/><circle cx="181" cy="39" r="19" fill="none" stroke="#85baa5" strokeWidth="2" strokeDasharray="4 3"/><path d="M61 55 L159 42" fill="none" stroke="#85baa5" strokeWidth="2.5"/><path d="M151 37 L161 41 L153 48" fill="none" stroke="#85baa5" strokeWidth="2"/></>}
                        {drill.id === 'defending_v1' && <><circle cx="75" cy="78" r="8" fill="#8eb0f4"/><circle cx="181" cy="27" r="4" fill="#e6e9ed"/><path d="M179 31 L95 84" fill="none" stroke="#e6e9ed" strokeDasharray="4 5" strokeWidth="2"/><path d="M80 72 L110 54" fill="none" stroke="#85baa5" strokeWidth="2.5"/><circle cx="115" cy="52" r="11" fill="none" stroke="#85baa5" strokeWidth="2"/></>}
                        {drill.id === 'receiving_v1' && <><circle cx="92" cy="72" r="8" fill="#8eb0f4"/><circle cx="190" cy="37" r="4.5" fill="#e6e9ed"/><circle cx="111" cy="67" r="16" fill="none" stroke="#85baa5" strokeWidth="2"/><path d="M188 37 Q156 42 115 63" fill="none" stroke="#e6e9ed" strokeDasharray="5 4" strokeWidth="2.5"/><path d="M99 72 L112 67" fill="none" stroke="#85baa5" strokeWidth="2.5"/></>}
                        <text x="120" y="98" fill="currentColor" fillOpacity=".45" fontSize="8" textAnchor="middle" letterSpacing="2">{drillInfo[drill.id]?.diagram ?? 'DRILL'}</text>
                    </svg>
                    <strong>{titleFor(drill.id)}</strong><p>{drillInfo[drill.id]?.description ?? drill.behavior}</p>
                    {drill.curriculum && <small className="football-muted">{drill.curriculum.stages.length} selectable curriculum stages · manual</small>}
                    <div className="football-card-foot"><span>{drill.behavior}</span><span>{selectedDrill === drill.id ? 'Selected ✓' : 'Select ↗'}</span></div>
                </button>)}
                {!loading && drills.length === 0 && <div className="football-empty">No drills returned by the connected Mac Node.</div>}
            </div>
            <div className="football-actions"><button className="football-button primary" onClick={() => navigate('train')}>Configure selected drill →</button></div>
        </section>}
        {screen === 'policies' && <section className="football-panel football-overview-panel">
            <div className="football-panel-head"><div><span className="football-kicker">MODEL ARTEFACTS</span><h2>Policy library</h2></div><span>{policies.length} indexed</span></div>
            <p className="football-muted">Exported ONNX policies remain linked to their original training runs. Select a model to inspect its artefacts and prepare an evaluation.</p>
            <div className="football-search-controls">
                <input aria-label="Search policies" placeholder="Search policies or source runs" value={policySearch} onChange={e => setPolicySearch(e.target.value)} />
                <select aria-label="Filter policies by drill" value={filterDrill} onChange={e => setFilterDrill(e.target.value)}><option value="">All drills</option>{drills.map(d => <option key={d.id} value={d.id}>{titleFor(d.id)}</option>)}</select>
            </div>
            <div className="football-policy-grid">
                {visiblePolicies.map(policy => <button type="button" key={policy.id} className={`football-policy-card ${selectedPolicy === policy.id ? 'selected' : ''}`} onClick={() => {setSelectedPolicy(policy.id);setEvalPlan(undefined);}}>
                    <div className="football-card-top"><span className="football-card-tag">{titleFor(policy.drill)}</span><span className="football-artifact-type">ONNX</span></div>
                    <div className="football-policy-glyph" aria-hidden="true">◇ <span>┄┄┄</span></div>
                    <strong title={policy.id}>{policy.id}</strong><small title={policy.source_run_id}>Source · {policy.source_run_id}{jobs.find(job => job.id === policy.source_run_id)?.curriculum_stage ? ` · Stage ${jobs.find(job => job.id === policy.source_run_id)?.curriculum_stage}` : ''}</small>
                    <div className="football-card-foot"><span>{policy.artifacts.filter(a => a.final).length} final export(s)</span><span>{selectedPolicy === policy.id ? 'Selected ✓' : 'Inspect ↗'}</span></div>
                </button>)}
                {!loading && visiblePolicies.length === 0 && <div className="football-empty">No matching policies. Index a completed run to add a policy to the library.</div>}
            </div>
            {currentPolicy && <div className="football-selected-policy">
                <div><span className="football-kicker">SELECTED POLICY</span><strong>{currentPolicy.id}</strong><small>{titleFor(currentPolicy.drill)} · {currentPolicy.artifacts.length} artefacts · {stateLabel(currentPolicy.evaluation)}{jobs.find(job => job.id === currentPolicy.source_run_id)?.curriculum_stage ? ` · Stage ${jobs.find(job => job.id === currentPolicy.source_run_id)?.curriculum_stage}` : ''}</small></div>
                <button className="football-button primary" disabled={!!busy} onClick={() => { setScreen('evaluation'); }}>Evaluate policy →</button>
                <button className="football-button quiet" disabled={!!busy} onClick={() => { setScreen('viewer'); }}>Open policy viewer →</button>
                <button className="football-button quiet" disabled={!!busy} onClick={() => void act('plan', async () => {
                    setEvalPlan(await callTool('football_plan_evaluation', { policyId: currentPolicy.id, episodes: 100, seed: 123 }));
                })}>Prepare 100-episode evaluation ↗</button>
            </div>}
            {evalPlan !== undefined && <pre className="football-log">{JSON.stringify(evalPlan,null,2)}</pre>}
        </section>}
        {screen === 'overview' && <div className="football-overview-grid">
            <section className="football-panel"><div className="football-panel-head"><div><span className="football-kicker">NOW RUNNING</span><h2>Active experiments</h2></div><span>{running.length}</span></div>
                {running.slice(0, 5).map(job => <div className="football-overview-row" key={job.id}><strong>{job.id}</strong><small>{titleFor(job.drill)} · {job.arenas} arena(s)</small></div>)}
                {!running.length && <p className="football-muted">No training is currently running.</p>}
                <button className="football-button quiet" onClick={() => navigate('runs')}>View run history →</button>
            </section>
            <section className="football-panel"><div className="football-panel-head"><div><span className="football-kicker">MEASURED OUTPUT</span><h2>Recent evaluations</h2></div><span>{evaluations.length}</span></div>
                {evaluations.slice(-4).reverse().map(item => <div className="football-overview-row" key={item.id}><strong>{item.policy_id}</strong><small>{typeof item.success_rate === 'number' ? (item.success_rate * 100).toFixed(1) + '% success' : 'No result'} · {item.episodes} episodes</small></div>)}
                {!evaluations.length && <p className="football-muted">No completed evaluations yet. Select a saved policy to establish a baseline.</p>}
                <button className="football-button quiet" onClick={() => navigate('evaluation')}>Open evaluation →</button>
            </section>
        </div>}
        {(screen === 'train' || screen === 'runs') && <div className="football-columns">
            <div className="football-main-column">
                {screen === 'train' && <section className="football-panel">
                    <div className="football-panel-head"><div><span className="football-kicker">01 / TRAIN</span><h2>Launch a headless run</h2></div></div>
                    <p className="football-muted">Choose the drill and a PPO preset. A launch request can take time to build a Unity runner; an accepted request isn't proof training has started.</p>
                    <div className="football-fields">
                        <label className="wide">Drill<select value={selectedDrill} onChange={e => { setSelectedDrill(e.target.value); setPreset('smoke'); }} disabled={!drills.length}>{drills.map(d => <option key={d.id} value={d.id}>{titleFor(d.id)} · {d.behavior}</option>)}</select></label>
                        <label>Training preset<select aria-label="Training preset" value={selectedPreset} onChange={e => setPreset(e.target.value)}>
                            {Object.keys(currentDrill?.configs ?? {}).map(key => <option key={key} value={key}>{presetLabel(key)}</option>)}
                        </select></label>
                        <label>Arenas<input type="number" min={1} max={16} value={arenas} onChange={e => setArenas(Number(e.target.value))} /></label>
                        <label>Base port<input type="number" min={1024} max={65519} value={basePort} onChange={e => setBasePort(Number(e.target.value))} /></label>
                        <label>Seed<input type="number" min={0} max={2147483647} value={seed} onChange={e => setSeed(Number(e.target.value))} /></label>
                    </div>
                    {currentDrill && <div className="football-contract"><span>Scene: {currentDrill.scene}</span><span>{currentDrill.observation_size} observations</span><span>{currentDrill.continuous_actions} actions</span></div>}
                    {currentDrill?.curriculum && <div className="football-curriculum" aria-label="Curriculum stages">
                        <strong>Ball-control curriculum <small>Manual stages · v{currentDrill.curriculum.version}</small></strong>
                        <p className="football-muted">Choose a stage with the training preset above. Each stage is a separately recorded training run; automatic promotion and checkpoint transfer are not enabled yet.</p>
                        <div className="football-curriculum-stages">
                            {currentDrill.curriculum.stages.map(stage => <button type="button" key={stage.id} className={selectedPreset === stage.preset ? 'selected' : ''} aria-pressed={selectedPreset === stage.preset} onClick={() => setPreset(stage.preset)}>
                                <span>{stage.stage}. {stage.title}</span><small>{stage.description}</small>
                            </button>)}
                        </div>
                        {selectedStage && <small className="football-muted">Measured outcome: {selectedStage.metric.replaceAll('_', ' ')} · {selectedStage.description}</small>}
                    </div>}
                    <div className="football-actions">
                        <button className="football-button primary" disabled={!selectedDrill || !!busy || loading || !Number.isInteger(arenas) || arenas < 1 || arenas > 16 || !Number.isInteger(basePort) || basePort < 1024 || basePort > 65519 || !Number.isInteger(seed) || seed < 0} onClick={() => void act('launch', async () => {
                            if (!window.confirm(`Request a ${selectedPreset} training run for ${selectedDrill} (${arenas} arena${arenas === 1 ? '' : 's'}) on your Mac?`)) return;
                            const result = await callTool<Launch>('football_launch_training', { drill: selectedDrill, preset: selectedPreset, arenas, basePort, seed });
                            setLaunch(result); setLaunchStatus(undefined); setNotice('Launch requested. Check the receipt for build or trainer progress.');
                        })}>{busy === 'launch' ? 'Submitting…' : 'Launch training ↗'}</button>
                        <span className="football-muted">Uses the cached standalone Unity training runner where available.</span>
                    </div>
                    {launch && <div className="football-receipt">
                        <div><strong>Latest launch · {launch.drill}</strong><small>Ticket {launch.ticket}</small></div>
                        <button className="football-button quiet" disabled={!!busy} onClick={checkLaunch}>Check receipt</button>
                        {launchStatus && <div className="football-receipt-details"><span>Status: {stateLabel(launchStatus.state)}</span><p>{launchStatus.note}</p>{launchStatus.run?.id && <small>Run: {launchStatus.run.id}</small>}{launchStatus.error && <pre>{launchStatus.error}</pre>}</div>}
                    </div>}
                </section>}
                {screen === 'runs' && openRunId && <FootballRunControlRoom runId={openRunId} policies={policies} evaluations={evaluations}
                    onBack={closeRun} onWatch={id => launchViewer('live', id)}
                    onStop={id => void act('stop', async () => {
                        if (!window.confirm('Gracefully stop ' + id + '?')) return;
                        await callTool('football_stop_training', { runId: id }); await refresh();
                        setNotice('Stop requested. Confirm terminal state from trainer output.');
                    })}
                    onIndex={id => void act('index', async () => {
                        await callTool('football_index_policy', { runId: id }); await refresh();
                        setNotice('Policy artifacts indexed.');
                    })}
                    onEvaluate={id => { closeRun(); setSelectedPolicy(id); setScreen('evaluation'); }} />}
                {screen === 'runs' && !openRunId && <section className="football-panel">
                    <div className="football-panel-head"><div><span className="football-kicker">02 / MONITOR</span><h2>Training jobs</h2></div><span>{jobs.length} total</span></div>
                    <div className="football-run-filters" role="group" aria-label="Run history filters">
                        {(['active', 'recent', 'archive', 'all'] as const).map(value => <button key={value} className={runFilter === value ? 'active' : ''} aria-pressed={runFilter === value} onClick={() => {setRunFilter(value);setLogs('');}}>
                            {value === 'active' ? 'Active' : value === 'recent' ? 'Last 7 days' : value === 'archive' ? 'Archive' : 'All'}
                        </button>)}
                    </div>
                    <div className="football-search-controls">
                        <input aria-label="Search runs" placeholder="Find run by ID or drill…" value={runSearch} onChange={e => setRunSearch(e.target.value)} />
                        <select aria-label="Filter runs by drill" value={filterDrill} onChange={e => setFilterDrill(e.target.value)}><option value="">All drills</option>{drills.map(d => <option key={d.id} value={d.id}>{titleFor(d.id)}</option>)}</select>
                    </div>
                    <div className="football-job-list">
                        {filteredJobs.map(job => <button className={`football-job ${selectedJob === job.id ? 'active' : ''}`} key={job.id} onClick={() => { setLogs(''); openRun(job.id); }}>
                            <span><strong>{job.id}</strong><small>{titleFor(job.drill)} · {job.curriculum_stage_id ? `Stage ${job.curriculum_stage}: ${job.curriculum_stage_id.replaceAll('_', ' ')}` : job.preset} · {job.arenas} arena{job.arenas === 1 ? '' : 's'}</small></span>
                            <span className={`football-state ${job.state === 'running' ? 'active' : ''}`}>{stateLabel(job.state)}</span>
                        </button>)}
                        {!loading && !filteredJobs.length && <div className="football-empty">No matching runs in this section. Change the filter or open the archive; no runs are deleted.</div>}
                    </div>
                    {currentJob && filteredJobs.some(job => job.id === currentJob.id) && <div className="football-inspector"><h3>{currentJob.id}</h3><p className="football-muted">Started {date(currentJob.started_at)} · port {currentJob.base_port} · seed {currentJob.seed}{currentJob.curriculum_stage ? ` · Stage ${currentJob.curriculum_stage} (${currentJob.curriculum_stage_id})` : ''}</p>
                        <div className="football-actions"><button className="football-button quiet" disabled={!!busy} onClick={() => void loadLogs(currentJob.id)}>{busy === 'logs' ? 'Loading…' : 'View latest logs'}</button>
                        <button className="football-button primary" disabled={!!busy || currentJob.state !== 'running'} onClick={() => launchViewer('live', currentJob.id)}>Watch live ↗</button>
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
                </section>}
            </div>
        </div>}

        {screen === 'evaluation' && openEvaluationId && evaluations.find(item => item.id === openEvaluationId) &&
            <FootballEvaluationControlRoom evaluation={evaluations.find(item => item.id === openEvaluationId)!} onBack={() => setOpenEvaluationId('')} />}
        {screen === 'evaluation' && !openEvaluationId && <div className="football-page-stack">
            <section className="football-panel">
                <div className="football-panel-head"><div><span className="football-kicker">MODEL ASSESSMENT</span><h2>Run evaluation</h2></div><span>Seeded inference</span></div>
                <p className="football-muted">Evaluate an indexed final ONNX policy in Unity without altering its training run. Measurements are recorded only after evaluation completes. Stage-1 ball-control success means real contact, not controlled dribbling.</p>
                <p className="football-muted">The current Stage-1 evaluation uses the wider scenario v3 ball spawns; older scenario v2 results were centred and are not directly comparable. Promotion requires beating simple controls on the same seed, scenario version and Unity runner.</p>
                <div className="football-fields">
                    <label className="wide">Policy
                        <select value={selectedPolicy} onChange={e => {setSelectedPolicy(e.target.value);setEvalPlan(undefined);}} disabled={!policies.length}>
                            {policies.map(policy => <option key={policy.id} value={policy.id}>{policy.id} · {titleFor(policy.drill)}</option>)}
                        </select>
                    </label>
                    <label>Episodes<input type="number" min={1} max={10000} value={episodes} onChange={e => setEpisodes(Number(e.target.value))} /></label>
                    <label>Seed<input type="number" min={0} max={2147483647} value={evalSeed} onChange={e => setEvalSeed(Number(e.target.value))} /></label>
                    <label>Replay episode (optional)<input type="number" min={0} max={10000} value={replayEpisode} onChange={e => setReplayEpisode(Number(e.target.value))} title="0 runs the full seed suite; positive values replay exactly one saved scenario" /></label>
                </div>
                <div className="football-actions">
                    <button className="football-button primary" disabled={!!busy || !currentPolicy || !Number.isInteger(episodes) || episodes < 1 || episodes > 10000 || !Number.isInteger(evalSeed) || evalSeed < 0 || (replayEpisode > 0 && episodes !== 1)}
                        onClick={() => void act('evaluate', async () => {
                            if (!window.confirm('Run ' + episodes + ' seeded evaluation episodes for ' + currentPolicy!.id + ' on your Mac?')) return;
                            const result = await callTool<Launch>('football_run_evaluation', { policyId: currentPolicy!.id, episodes, seed: evalSeed, replayEpisode });
                            setEvaluationLaunch(result); setEvaluationStatus(undefined); setNotice('Evaluation requested. Check its receipt until the Unity evaluation finishes.');
                        })}>Run evaluation ↗</button>
                    <button className="football-button quiet" disabled={!!busy || !currentPolicy} onClick={() => void act('plan', async () => {
                        setEvalPlan(await callTool('football_plan_evaluation', { policyId: currentPolicy!.id, episodes, seed: evalSeed }));
                    })}>Inspect plan</button>
                </div>
                {evalPlan !== undefined && <pre className="football-log">{JSON.stringify(evalPlan, null, 2)}</pre>}
                {evaluationLaunch && <div className="football-receipt">
                    <div><strong>Evaluation request</strong><small>Ticket {evaluationLaunch.ticket}</small></div>
                    <button className="football-button quiet" disabled={!!busy} onClick={checkEvaluation}>Check evaluation status</button>
                    {evaluationStatus && <div className="football-receipt-details"><strong>Status · {stateLabel(evaluationStatus.state)}</strong><p>{evaluationStatus.note}</p>
                        {evaluationStatus.state === 'completed' && evaluationStatus.run?.id && evaluations.some(item => item.id === evaluationStatus.run?.id) && <button className="football-button primary" onClick={() => setOpenEvaluationId(evaluationStatus.run!.id!)}>Open evaluation control room →</button>}
                        {evaluationStatus.error && <pre>{evaluationStatus.error}</pre>}
                        {evaluationStatus.output && evaluationStatus.state !== 'completed' && <pre>{evaluationStatus.output}</pre>}
                    </div>}
                </div>}
            </section>
            <section className="football-panel">
                <div className="football-panel-head"><div><span className="football-kicker">BASELINE CONTROLS</span><h2>Stage 1 control benchmarks</h2></div><span>Non-learning reference</span></div>
                <p className="football-muted">Run zero-input, random, forward-only, or scripted ball-seeking control in the same Unity scene. Stage-1 scenario v3 adds a wider range of left/right ball positions and retains deterministic seed-and-episode placements. Replay requires Episodes = 1.</p>
                <div className="football-fields"><label>Controller<select aria-label="Baseline controller" value={baselineMode} onChange={e => setBaselineMode(e.target.value as typeof baselineMode)}>
                    <option value="zero">No input (negative control)</option><option value="random">Random input</option><option value="forward">Fixed forward throttle</option><option value="scripted">Scripted steering to ball</option>
                </select></label></div>
                <div className="football-actions"><button className="football-button quiet" disabled={!!busy || !Number.isInteger(episodes) || episodes < 1 || episodes > 10000 || !Number.isInteger(evalSeed) || evalSeed < 0 || (replayEpisode > 0 && episodes !== 1)}
                    onClick={() => void act('baseline', async () => {
                        if (!window.confirm('Run ' + episodes + ' Stage-1 ' + baselineMode + ' baseline episodes on your Mac?')) return;
                        const result = await callTool<Launch>('football_run_baseline_evaluation', { baselineMode, episodes, seed: evalSeed, replayEpisode });
                        setEvaluationLaunch(result); setEvaluationStatus(undefined); setNotice('Baseline evaluation requested. Its results will appear in evaluation history.');
                    })}>Run Stage-1 baseline ↗</button></div>
            </section>
            <section className="football-panel">
                <div className="football-panel-head"><div><span className="football-kicker">MEASURED RESULTS</span><h2>Evaluation history</h2></div><span>{evaluations.length} completed</span></div>
                <div className="football-results-list">
                    {evaluations.slice().reverse().map(item => <div className="football-result" key={item.id}>
                        <div><strong>{item.policy_id}</strong><small>{item.id} · {titleFor(item.drill)} · {item.episodes} episodes · seed {item.seed}{item.curriculum_stage ? ` · Stage ${item.curriculum_stage}` : ''}{item.scenario_version ? ` · ${scenarioLabel(item.scenario_version)}` : ''}{item.baseline_mode ? ` · Baseline ${item.baseline_mode}` : ''}</small></div>
                        <div><strong>{typeof item.success_rate === 'number' ? (item.success_rate * 100).toFixed(1) + '%' : '—'}</strong><small>Success rate</small></div>
                        <div><strong>{typeof item.mean_reward === 'number' ? item.mean_reward.toFixed(3) : '—'}</strong><small>Mean reward{typeof item.contact_episodes === 'number' ? ` · real contact ${item.contact_episodes}/${item.episodes}` : ''}</small></div>
                        <button className="football-button quiet" onClick={() => setOpenEvaluationId(item.id)}>Inspect →</button>
                    </div>)}
                    {!loading && !evaluations.length && <div className="football-empty">No completed evaluation results yet. Run a seeded evaluation to establish a baseline.</div>}
                </div>
            </section>
        </div>}
        {screen === 'viewer' && <div className="football-page-stack">
            <section className="football-panel">
                <div className="football-panel-head"><div><span className="football-kicker">LIVE TELEMETRY</span><h2>Watch ongoing training</h2></div><span>{running.length} running</span></div>
                <p className="football-muted">Launch a separate Unity window on the connected Mac to observe live training telemetry. Closing the viewer does not stop training. Existing runs need telemetry support.</p>
                <div className="football-fields"><label className="wide">Running job
                    <select value={running.some(job => job.id === selectedJob) ? selectedJob : running[0]?.id ?? ''} onChange={e => setSelectedJob(e.target.value)} disabled={!running.length}>
                        {running.map(job => <option key={job.id} value={job.id}>{job.id} · {titleFor(job.drill)}</option>)}
                    </select>
                </label></div>
                <div className="football-actions"><button className="football-button primary" disabled={!!busy || !running.length}
                    onClick={() => launchViewer('live', running.some(job => job.id === selectedJob) ? selectedJob : running[0].id)}>Watch live on Mac ↗</button></div>
            </section>
            <section className="football-panel">
                <div className="football-panel-head"><div><span className="football-kicker">POLICY PLAYBACK</span><h2>Load Policy Viewer</h2></div></div>
                <p className="football-muted">Play a saved ONNX policy in a standalone graphical Unity visualiser. This uses a separate inference process; it won't resume or replace PPO training.</p>
                <div className="football-fields">
                    <label className="wide">Indexed policy
                        <select value={selectedPolicy} onChange={e => setSelectedPolicy(e.target.value)} disabled={!policies.length}>
                            {policies.map(policy => <option key={policy.id} value={policy.id}>{policy.id} · {titleFor(policy.drill)}</option>)}
                        </select>
                    </label>
                    <label>Viewer arenas<input type="number" value={viewerArenas} min={1} max={16} onChange={e => setViewerArenas(Number(e.target.value))} /></label>
                    <label>Seed<input type="number" value={viewerSeed} min={0} max={2147483647} onChange={e => setViewerSeed(Number(e.target.value))} /></label>
                </div>
                <div className="football-actions"><button className="football-button primary" disabled={!!busy || !currentPolicy || !Number.isInteger(viewerArenas) || viewerArenas < 1 || viewerArenas > 16 || !Number.isInteger(viewerSeed) || viewerSeed < 0}
                    onClick={() => launchViewer('policy', currentPolicy!.id)}>Open policy viewer ↗</button></div>
                <p className="football-muted">A first-time Unity policy build may require the Editor to be closed. The viewer opens on the Mac, not embedded in Atlas Web.</p>
            </section>
            {viewerLaunch && <section className="football-panel">
                <div className="football-panel-head"><div><span className="football-kicker">LAUNCH RECEIPT</span><h2>Latest viewer request</h2></div></div>
                <div className="football-receipt"><div><strong>Viewer launch</strong><small>Ticket {viewerLaunch.ticket}</small></div>
                    <button className="football-button quiet" disabled={!!busy} onClick={checkViewer}>Check viewer status</button>
                    {viewerStatus && <div className="football-receipt-details"><strong>Status · {stateLabel(viewerStatus.state)}</strong><p>{viewerStatus.note}</p>
                        {viewerStatus.error && <pre>{viewerStatus.error}</pre>}
                    </div>}
                </div>
            </section>}
            <section className="football-panel">
                <div className="football-panel-head"><div><span className="football-kicker">LOCAL MAC WINDOWS</span><h2>Viewer sessions</h2></div><span>{viewers.filter(v => v.state === 'running').length} open</span></div>
                <div className="football-job-list">
                    {viewers.slice(0, 15).map(viewer => <div className="football-job" key={viewer.id}>
                        <span><strong>{viewer.mode === 'live' ? 'Live · ' + viewer.source_run_id : 'Policy · ' + (viewer.policy_id ?? viewer.id)}</strong>
                            <small>{titleFor(viewer.drill ?? '')} · {date(viewer.started_at)}</small></span>
                        <span className={'football-state ' + (viewer.state === 'running' ? 'active' : '')}>{stateLabel(viewer.state)}</span>
                    </div>)}
                    {!loading && !viewers.length && <div className="football-empty">No viewers launched yet. Open a live run or a saved policy above.</div>}
                </div>
            </section>
        </div>}
    </div>;
}
