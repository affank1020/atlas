import { useRouteTiming } from './performance';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callTool } from './api';
import { useLiveApplicationResource } from './applicationCache';
import { GeneralistRunView, GeneralistPolicyView, GeneralistEvaluationView } from './FootballGeneralistDetails';
import type { GeneralistManifest } from './FootballGeneralistDashboard';
import { GeneralistDrillCatalog } from './GeneralistDrillCatalog';
import { GeneralistDrillPicker } from './GeneralistDrillPicker';
import { isActive, nameOfPolicy, type PolicyAssessment } from './football-skill-model';
import './football-training.css';
import './football-generalist-experience.css';

type Run = { id: string; family: string; scenario?: string; state: string; started_at?: string; seed?: number; num_envs?: number; checkpoints?: number; checkpoint_files?: string[]; packaging?: { status: string; policy_id?: string; error?: string }; output_dir?: string; contract_sha256?: string; scenario_sha256?: string; initialization_available?: boolean; initialization?: { source_run_id?: string; checkpoint_sha256?: string } | null };
type Policy = { id: string; display_name?: string | null; featured?: boolean; source_policy_id?: string | null; onnx_sha256?: string | null; behavior: string; status: string; source: string; compatible_metadata: boolean; historical_watch_available?: boolean; executable_verified: boolean; view_scenario?: string; onnx_available: boolean; bundle_available: boolean };
type Receipt = { accepted?: boolean; ticket: string; action: string; status: string; scenario?: string; policy_id?: string; seed?: number; started_at?: string; output?: string; error?: string; note?: string; requested_episodes?: number; result?: { run_id?: string; episodes?: number; outcomes?: Record<string, number>; success_rate?: number | null }; viewer?: { state: string; launch_method: string; launcher_alive: boolean; player_log_detected: boolean; log_tail?: string; note?: string } };
type Legacy = { policies: { id: string; drill: string }[]; jobs: { id: string; drill: string; state: string }[] };
type Tab = 'home' | 'drills' | 'train' | 'runs' | 'policies' | 'evaluate' | 'watch' | 'checks' | 'archive';

const SHOWCASE_DRILL = 'dribbling_showcase_v1';
const tabs: { id: Tab; label: string }[] = [
    { id: 'home', label: 'Home' }, { id: 'drills', label: 'Drills' }, { id: 'train', label: 'Train' },
    { id: 'runs', label: 'Runs' }, { id: 'policies', label: 'Policies' },
    { id: 'evaluate', label: 'Evaluate' }, { id: 'watch', label: 'Watch' },
    { id: 'checks', label: 'Contract' }, { id: 'archive', label: 'Legacy archive' },
];
const shortHash = (value?: string) => value ? value.slice(0, 10) : '—';
const when = (value?: string) => value ? new Date(value).toLocaleString() : '—';

export function FootballGeneralistExperience() {
    const manifestResource = useLiveApplicationResource<GeneralistManifest>('football_generalist_manifest');
    const runsResource = useLiveApplicationResource<Run[]>('football_generalist_runs');
    const policiesResource = useLiveApplicationResource<Policy[]>('football_generalist_policies');
    const activityResource = useLiveApplicationResource<Receipt[]>('football_generalist_activity');
    const assessmentsResource = useLiveApplicationResource<{ policies: PolicyAssessment[] }>('football_generalist_assessments');
    const cachedManifest = manifestResource.cached?.available && manifestResource.cached.contract?.contract_id === 'football-generalist-v2' ? manifestResource.cached : null;
    const [tab, setTab] = useState<Tab>('home');
    const [manifest, setManifest] = useState<GeneralistManifest | null>(cachedManifest);
    const [runs, setRuns] = useState<Run[]>(Array.isArray(runsResource.cached) ? runsResource.cached : []);
    const [policies, setPolicies] = useState<Policy[]>(Array.isArray(policiesResource.cached) ? policiesResource.cached : []);
    const [assessments, setAssessments] = useState<PolicyAssessment[]>(Array.isArray(assessmentsResource.cached?.policies) ? assessmentsResource.cached.policies : []);
    const [historySearch, setHistorySearch] = useState('');
    const [historyFilter, setHistoryFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all');
    const [runsFilter, setRunsFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all');
    const [activity, setActivity] = useState<Receipt[]>(Array.isArray(activityResource.cached) ? activityResource.cached : []);
    const [legacy, setLegacy] = useState<Legacy | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState('');
    const [loading, setLoading] = useState(!cachedManifest);
    const [refreshing, setRefreshing] = useState(false);
    const [refreshStatus, setRefreshStatus] = useState('Not synced yet');
    const [assessmentWarning, setAssessmentWarning] = useState('');
    const activeRefresh = useRef<Promise<void> | null>(null);
    const [scenario, setScenario] = useState('mix');
    const [watchScenario, setWatchScenario] = useState(SHOWCASE_DRILL);
    const [selectedDrillScenario, setSelectedDrillScenario] = useState('');
    const [preset, setPreset] = useState<'smoke' | 'pilot_50k' | 'pilot_100k'>('smoke');
    const [initializeFromRunId, setInitializeFromRunId] = useState('');
    const [seed, setSeed] = useState(42);
    const [workers, setWorkers] = useState(1);
    const [basePort, setBasePort] = useState(5605);
    const [episodes, setEpisodes] = useState(10);
    const [evaluationSeed, setEvaluationSeed] = useState(515);
    const [selectedPolicy, setSelectedPolicy] = useState('');
    const [ticket, setTicket] = useState<Receipt | null>(null);
    const [detail, setDetail] = useState<{ kind: 'run' | 'policy' | 'evaluation'; id: string } | null>(null);

    useRouteTiming("football", "football", !!manifest && !loading);
    const refresh = useCallback((): Promise<void> => {
        // Manual and timed refreshes share one request; a slower poll cannot overwrite a newer result.
        if (activeRefresh.current) return activeRefresh.current;
        const request = (async () => {
            const [m, r, p, a, skillData] = await Promise.allSettled([
                manifestResource.load(),
                runsResource.load(),
                policiesResource.load(),
                activityResource.load(),
                assessmentsResource.load(),
            ]);
            const failures: string[] = [];
            if (m.status === 'fulfilled' && m.value?.available && m.value.contract?.contract_id === 'football-generalist-v2')
                setManifest(m.value);
            else failures.push('contract');
            if (r.status === 'fulfilled' && Array.isArray(r.value)) setRuns(r.value);
            else failures.push('training runs');
            if (p.status === 'fulfilled' && Array.isArray(p.value)) {
                setPolicies(p.value);
                setSelectedPolicy(current => current && p.value.some(policy => policy.id === current) ? current :
                    p.value.find(policy => policy.featured && (policy.compatible_metadata || policy.historical_watch_available) &&
                        policy.onnx_available && policy.bundle_available)?.id ||
                    p.value.find(policy => policy.compatible_metadata && policy.onnx_available && policy.bundle_available)?.id || '');
            } else failures.push('policies');
            if (a.status === 'fulfilled' && Array.isArray(a.value)) setActivity(a.value);
            else failures.push('evaluation activity');
            const assessmentsAvailable = skillData.status === 'fulfilled' && Array.isArray(skillData.value?.policies);
            if (assessmentsAvailable) {
                setAssessments(skillData.value.policies);
                setAssessmentWarning('');
            } else {
                // A missing optional assessment endpoint must never hide training/evaluation data.
                setAssessmentWarning('Skill assessments unavailable. Runs, policies and evaluations can still update.');
            }
            setError(failures.length ? `Refresh incomplete: ${failures.join(', ')} could not be updated. Previous data retained where available.` : '');
            const partial = failures.length > 0 || !assessmentsAvailable;
            const anythingUpdated = failures.length < 4 || assessmentsAvailable;
            setRefreshStatus(`${!anythingUpdated ? 'Refresh failed' : partial ? 'Partially updated' : 'Updated'} at ${new Date().toLocaleTimeString()}`);
        })().finally(() => { activeRefresh.current = null; });
        activeRefresh.current = request;
        return request;
    }, [manifestResource.load, runsResource.load, policiesResource.load, activityResource.load, assessmentsResource.load]);
    useEffect(() => {
        let mounted = true;
        void refresh().catch(e => { if (mounted) setError(String(e)); }).finally(() => { if (mounted) setLoading(false); });
        const timer = window.setInterval(() => { void refresh().catch(e => { if (mounted) setError(String(e)); }); }, 10000);
        return () => { mounted = false; window.clearInterval(timer); };
    }, [refresh]);
    useEffect(() => {
        if (!ticket?.ticket) return;
        let live = true;
        const poll = () => void callTool<Receipt>('football_generalist_status', { runId: ticket.ticket })
            .then(r => { if (live) setTicket(r); }).catch(e => { if (live) setError(String(e)); });
        poll();
        const timer = window.setInterval(poll, 5000);
        return () => { live = false; window.clearInterval(timer); };
    }, [ticket?.ticket]);

    const scenarios = manifest?.scenarios.scenarios ?? [];
    const runnablePolicies = policies.filter(p => p.compatible_metadata && p.bundle_available && p.onnx_available);
    const historicalWatchPolicies = policies.filter(p => p.featured && !p.compatible_metadata &&
        p.historical_watch_available && p.bundle_available && p.onnx_available);
    const watchPolicies = [...runnablePolicies, ...historicalWatchPolicies];
    const selectablePolicies = tab === 'watch' ? watchPolicies : runnablePolicies;
    const currentPolicy = policies.find(p => p.id === selectedPolicy);
    const historicalSelected = tab === 'watch' && currentPolicy && historicalWatchPolicies.some(p => p.id === currentPolicy.id);
    // Discovered receipts include evaluations started through ChatGPT or another Atlas client.
    const evaluations = activity.filter(item => ['generalist_evaluate', 'generalist_baseline'].includes(item.action));
    const progressLabel = (item: Receipt) => item.result?.episodes == null ? 'No outcomes yet' :
        item.result.episodes + (item.requested_episodes != null ? ' / ' + item.requested_episodes : '') +
        ' episodes · ' + Object.entries(item.result.outcomes ?? {}).map(([name, count]) => count + ' ' + name.replaceAll('_', ' ')).join(', ');
    const policyName = (id: string) => {
        const match = policies.find(p => p.id === id);
        const curated = policies.find(p => p.featured && (p.source_policy_id === id || p.onnx_sha256 && p.onnx_sha256 === match?.onnx_sha256));
        return curated ? nameOfPolicy(curated) : match ? nameOfPolicy(match) : id;
    };
    const preferredPolicy = (id: string) => policies.find(p => p.id === id)?.featured ? id :
        policies.find(p => p.featured && (p.source_policy_id === id || p.onnx_sha256 && p.onnx_sha256 === policies.find(x => x.id === id)?.onnx_sha256))?.id || id;
    const activeRuns = runs.filter(r => isActive(r.state));
    const activeEvaluations = evaluations.filter(e => isActive(e.status));
    const filteredRuns = runs.filter(r => runsFilter === 'all' || (runsFilter === 'active' ? isActive(r.state) :
        runsFilter === 'completed' ? r.state === 'completed' : /fail|error|stopped/i.test(r.state)));
    const filteredEvaluations = evaluations.filter(e =>
        (historyFilter === 'all' || (historyFilter === 'active' ? isActive(e.status) :
            historyFilter === 'completed' ? e.status === 'completed' : /fail|error|stopped/i.test(e.status))) &&
        (policyName(e.policy_id || '').toLowerCase() + ' ' + (e.policy_id || '') + ' ' + (e.scenario || '')).toLowerCase().includes(historySearch.toLowerCase()));
    const updatePolicy = async (policyId: string, changes: { displayName?: string; featured?: boolean }) => {
        try {
            setError('');
            await callTool('football_generalist_policy_update', { policyId, ...changes });
            setNotice('Policy presentation updated. Model weights and provenance unchanged.');
            await refresh();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    };
    const initializationRuns = runs.filter(r => r.initialization_available &&
        r.contract_sha256 === manifest?.fingerprints?.contract_sha256);
    const doAction = async (key: string, tool: string, input: Record<string, unknown>) => {
        setBusy(key); setError(''); setNotice('');
        try {
            const result = await callTool<Receipt>(tool, input);
            setTicket(result);
            setNotice('Operation accepted. Check the receipt for execution status.');
            await refresh();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(''); }
    };
    const loadArchive = async () => {
        setBusy('archive');
        try {
            const [p, j] = await Promise.all([
                callTool<Legacy['policies']>('football_list_policies'),
                callTool<Legacy['jobs']>('football_list_jobs'),
            ]);
            setLegacy({ policies: p.filter(x => (x as { family?: string }).family !== 'generalist'), jobs: j.filter(x => (x as { family?: string }).family !== 'generalist') });
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(''); }
    };
    if (detail) return <main className="fg">
        <header className="fg-heading"><div><p className="fg-eyebrow">AI FOOTBALL / GENERALIST</p><h1>Generalist</h1></div>
            <button className="fg-button" onClick={() => setDetail(null)}>Back to {tab}</button></header>
        {detail.kind === 'run' && <GeneralistRunView runId={detail.id} policies={policies} onBack={() => setDetail(null)}
            onPolicy={id => setDetail({ kind: 'policy', id: preferredPolicy(id) })}/>}
        {detail.kind === 'evaluation' && <GeneralistEvaluationView ticket={detail.id} policyName={policyName} onBack={() => setDetail(null)}
            onPolicy={id => setDetail({ kind: 'policy', id: preferredPolicy(id) })}/>}
        {detail.kind === 'policy' && (policies.find(p => p.id === detail.id)
            ? <GeneralistPolicyView policy={policies.find(p => p.id === detail.id)!} runs={runs} activity={activity}
                assessment={assessments.find(a => a.policy_id === detail.id)}
                onRename={(id, displayName) => updatePolicy(id, { displayName })}
                onFeature={(id, featured) => updatePolicy(id, { featured })}
                onBack={() => setDetail(null)}
                onRun={id => setDetail({ kind: 'run', id })}
                onEvaluation={id => setDetail({ kind: 'evaluation', id })}
                onWatch={id => { setSelectedPolicy(id); setTab('watch'); setDetail(null); }}
                onEvaluate={id => { setSelectedPolicy(id); setTab('evaluate'); setDetail(null); }}
                onEvaluateSkill={(id, drill) => { setSelectedPolicy(id); setScenario(drill); setTab('evaluate'); setDetail(null); }}/>
            : <section className="fg-panel"><p>Policy is no longer available in the generalist index.</p><button className="fg-button" onClick={() => setDetail(null)}>Back</button></section>)}
    </main>;
    return <main className="fg">
        <header className="fg-heading">
            <div><p className="fg-eyebrow">AI FOOTBALL / FYP</p><h1>Generalist</h1><p className="fg-subtitle">Unity reinforcement learning · one policy, multiple scenarios</p></div>
            <div className="fg-refresh-controls">
                <span className="fg-refresh-status" role="status" aria-live="polite">{refreshing ? 'Fetching latest data…' : refreshStatus}</span>
                <button type="button" className="fg-button" disabled={!!busy || refreshing}
                    onClick={() => {
                        setRefreshing(true);
                        void refresh().catch(e => setError(String(e))).finally(() => setRefreshing(false));
                    }}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
            </div>
        </header>
        {loading && <p role="status">Connecting to the generalist workspace…</p>}
        {error && <p className="fg-error" role="alert">{error}</p>}
        {assessmentWarning && <p className="fg-muted" role="status">{assessmentWarning}</p>}
        {notice && <p className="fg-notice" role="status">{notice}</p>}
        <nav className="fg-nav" aria-label="Football sections">{tabs.map(t =>
            <button type="button" key={t.id} className={tab === t.id ? 'active' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => { setDetail(null); setTab(t.id); setError(''); if (t.id === 'archive' && !legacy) void loadArchive(); }}>{t.label}</button>)}</nav>
        {tab === 'home' && <div className="fg-stack">
            <section className="fg-panel fg-active-panel" aria-label="Active training and evaluations">
                <div className="fg-panel-title"><h2>Active activity</h2>
                    <span>{activeRuns.length + activeEvaluations.length} running or launching</span></div>
                {activeRuns.map(run => <button key={run.id} className="fg-active-item" onClick={() => { setTab('runs'); setDetail({ kind: 'run', id: run.id }); }}>
                    <strong>Training · {run.scenario || 'Generalist'}</strong><small>{run.state} · {run.id} →</small></button>)}
                {activeEvaluations.map(item => <button key={item.ticket} className="fg-active-item" onClick={() => { setTab('evaluate'); setDetail({ kind: 'evaluation', id: item.ticket }); }}>
                    <strong>Evaluation · {policyName(item.policy_id || 'Baseline')}</strong>
                    <small>{item.scenario || 'Unknown drill'} · {item.status} · {progressLabel(item)} →</small></button>)}
                {!activeRuns.length && !activeEvaluations.length &&
                    <p className="fg-muted">Nothing currently running. All training and evaluation history remains available below.</p>}
            </section>
            <div className="fg-stats">
                <div><small>Contract</small><strong>{manifest?.contract.contract_id ?? 'Unavailable'}</strong></div>
                <div><small>Observations</small><strong>{manifest?.contract.observations.size ?? '—'}</strong></div>
                <div><small>Actions</small><strong>{manifest?.contract.actions.continuous ?? '—'}</strong></div>
                <div><small>Recorded runs</small><strong>{runs.length}</strong></div>
                <div><small>Registered policies</small><strong>{policies.length}</strong></div>
            </div>
            <section className="fg-panel"><div className="fg-panel-title"><h2>Curriculum</h2><span>From Unity manifest</span></div>
                <div className="fg-curriculum">{manifest?.curriculum.stages.map(stage =>
                    <div key={stage.id} className="fg-curriculum-row"><strong>{stage.id}</strong><span>{stage.name}</span><small>{stage.implemented ? 'Implemented' : 'Not implemented'}</small></div>)}</div>
            </section>
            <section className="fg-panel"><div className="fg-panel-title"><h2>Recent runs</h2><button type="button" className="fg-link" onClick={() => setTab('runs')}>View all</button></div>
                {runs.slice(0, 5).map(r => <div className="fg-list-row" key={r.id}><button className="fg-record-link" onClick={() => setDetail({ kind: 'run', id: r.id })}>{r.id} →</button><span>{r.scenario ?? '—'}</span><small>{r.state}</small></div>)}
                {!runs.length && <p className="fg-muted">No generalist training receipts found.</p>}
            </section>
            <section className="fg-panel"><div className="fg-panel-title"><h2>Evaluations</h2><button type="button" className="fg-link" onClick={() => setTab('evaluate')}>View all</button></div>
                <p className="fg-muted">Includes evaluations launched through Atlas tools or other clients. Updates every 10 seconds.</p>
                {evaluations.slice(0, 5).map(item => <button className="fg-eval-row" key={item.ticket}
                    onClick={() => { setTab('evaluate'); setDetail({ kind: 'evaluation', id: item.ticket }); }}>
                    <strong>{policyName(item.policy_id || 'Baseline')}</strong>
                    <span>{item.scenario ?? 'Unknown drill'}</span>
                    <small>{item.status} · {progressLabel(item)}</small>
                </button>)}
                {!evaluations.length && <p className="fg-muted">No generalist evaluation receipts found.</p>}
            </section>
        </div>}
        {tab === 'drills' && <GeneralistDrillCatalog manifest={manifest} selected={selectedDrillScenario} onSelect={setSelectedDrillScenario} onTrain={id => { setScenario(id); setTab('train'); }}/>} 
        {tab === 'train' && <section className="fg-panel">
            <h2>New training run</h2><p className="fg-muted">Starts a new PPO learner. S1 rehearsal samples 75% dribbling and 25% S0 contact episodes; it requires a compatible recorded checkpoint as the initial weights, not a resume of the old run.</p>
            <div className="fg-form">
                <GeneralistDrillPicker scenarios={scenarios} mode="train" value={scenario} onChange={setScenario}/>
                <label>Preset<select value={preset} onChange={e => setPreset(e.target.value as 'smoke' | 'pilot_50k' | 'pilot_100k')}><option value="smoke">Smoke</option><option value="pilot_50k" disabled={scenario !== 's2-score-basic-v1'}>S2.2b pilot · 50k steps</option><option value="pilot_100k">Pilot · 100k steps</option></select></label>
                <label>Initial weights<select aria-label="Initial weights" value={initializeFromRunId} onChange={e => setInitializeFromRunId(e.target.value)}>
                    <option value="">Start with random weights</option>
                    {initializationRuns.map(r => <option key={r.id} value={r.id}>{r.id} · {r.scenario ?? 'Generalist'}</option>)}
                </select></label>
                <label>Training seed<input type="number" value={seed} min={0} onChange={e => setSeed(Number(e.target.value))}/></label>
                <label>Parallel environments<input type="number" value={workers} min={1} max={16} onChange={e => setWorkers(Number(e.target.value))}/></label>
                <label>Base port<input type="number" value={basePort} min={1024} max={65519} onChange={e => setBasePort(Number(e.target.value))}/></label>
            </div>
            {manifest?.scenarios.scenarios.find(s => s.id === scenario) && <div className="fg-drill-training-note">
                <strong>{manifest.scenarios.scenarios.find(s => s.id === scenario)?.name}</strong>
                <p>{manifest.drill_guide?.drills?.[scenario]?.summary || manifest.scenarios.scenarios.find(s => s.id === scenario)?.objective}</p>
                <button type="button" className="fg-link" onClick={() => { setSelectedDrillScenario(scenario); setTab('drills'); }}>View full drill breakdown →</button>
            </div>}
            <button className="fg-button primary" disabled={!!busy || !manifest || manifest.curriculum.held_out_seeds?.includes(seed) || (scenario === 's1_rehearsal' && !initializeFromRunId)} onClick={() => {
                if (window.confirm('Start one generalist PPO training run on the connected Mac?')) void doAction('train', 'football_generalist_train', { scenario, preset, seed, arenas: workers, basePort, ...(initializeFromRunId ? { initializeFromRunId } : {}) });
            }}>{busy === 'train' ? 'Starting…' : 'Launch generalist training'}</button>
            {scenario === 's1_rehearsal' && !initializeFromRunId && <p role="alert">Select a recorded S0 checkpoint before S1 continuation.</p>}
            {manifest?.curriculum.held_out_seeds?.includes(seed) && <p role="alert">This seed is reserved for held-out evaluation.</p>}
        </section>}
        {tab === 'runs' && <section className="fg-panel"><div className="fg-panel-title"><h2>Training runs</h2><span>{activeRuns.length} active · {runs.length} discovered</span></div>
            <div className="fg-filter-bar" role="group" aria-label="Filter training runs">
                {(['all','active','completed','failed'] as const).map(f => <button type="button" key={f}
                    aria-pressed={runsFilter === f} onClick={() => setRunsFilter(f)}>{f}</button>)}</div>
            <p className="fg-muted">Includes runs started from the terminal. A discovered receipt does not establish successful completion.</p>
            {filteredRuns.filter(r => isActive(r.state)).length > 0 && <h3>Active training</h3>}
            {filteredRuns.filter(r => isActive(r.state)).map(r => <button key={r.id} className="fg-active-item"
                onClick={() => setDetail({ kind: 'run', id: r.id })}>
                <strong>{r.scenario ?? 'Generalist training'}</strong><small>{r.state} · {r.id} →</small></button>)}
            {filteredRuns.some(r => !isActive(r.state)) && <h3>History</h3>}
            {filteredRuns.filter(r => !isActive(r.state)).map(r => <div className="fg-run" key={r.id}><div className="fg-panel-title"><button className="fg-record-link" onClick={() => setDetail({ kind: 'run', id: r.id })}>{r.id} →</button><small>{r.state}</small></div>
                <div className="fg-details"><span>Scenario: {r.scenario ?? '—'}</span><span>Seed: {r.seed ?? '—'}</span><span>Environments: {r.num_envs ?? '—'}</span><span>ONNX checkpoints: {r.checkpoints ?? 0}</span><span>Recorded: {when(r.started_at)}</span>{r.initialization?.source_run_id && <span>Initialised from: {r.initialization.source_run_id}</span>}</div>
                <div className="fg-actions">
                    <small className="fg-muted">Policy: {r.packaging?.status ?? 'not_registered'}{r.packaging?.policy_id ? ' · ' + r.packaging.policy_id : ''}</small>
                    {r.packaging?.status !== 'registered' && (r.checkpoint_files ?? []).some(file => file.endsWith('/FootballGeneralistV2.onnx')) &&
                        <button type="button" className="fg-button" disabled={!!busy || r.packaging?.status === 'building'} onClick={() =>
                            void doAction('package', 'football_generalist_package', { runId: r.id })}>
                            {r.packaging?.status === 'building' ? 'Packaging…' : 'Package policy'}
                        </button>}
                </div>
                {r.packaging?.error && <p className="fg-error" role="alert">Policy packaging: {r.packaging.error}</p>}
                <small className="fg-muted">{r.output_dir}</small></div>)}
            {!runs.length && <p className="fg-muted">No generalist runs have been discovered.</p>}
        </section>}
        {tab === 'policies' && <section className="fg-panel">
            <div className="fg-panel-title"><h2>Policies</h2><span>{policies.filter(p => p.featured).length} featured · {policies.length} saved</span></div>
            <p className="fg-muted">Featured means explicitly curated for use, not automatically certified or superior at every skill. Each model's original checkpoint is retained.</p>
            <h3>Featured players</h3>
            <div className="fg-featured-grid">{policies.filter(p => p.featured).map(p => {
                const a = assessments.find(x => x.policy_id === p.id);
                return <article key={p.id} className="fg-featured-card">
                    <div className="fg-featured-head"><div><span className="fg-eyebrow">FEATURED POLICY</span>
                        <h3>{nameOfPolicy(p)}</h3><small className="fg-muted">{p.id}</small></div><span>Player profile</span></div>
                    <div className="fg-featured-metrics">{a?.benchmarks.filter(x => x.rate != null).slice(0, 3).map(m =>
                        <div key={m.id}><small>{m.label}</small><strong>{Math.round(m.rate! * 100)}%</strong>
                            <small>{m.successes}/{m.total} · provisional</small></div>)}
                        {!a?.benchmarks.some(m => m.rate != null) && <p className="fg-muted">No measured assessment evidence yet.</p>}</div>
                    <div className="fg-actions">
                        <button className="fg-button primary" onClick={() => setDetail({ kind: 'policy', id: p.id })}>Player profile</button>
                        <button className="fg-button" disabled={!watchPolicies.some(candidate => candidate.id === p.id)}
                            onClick={() => { setSelectedPolicy(p.id); setTab('watch'); }}>Watch</button>
                        <button className="fg-button" disabled={!runnablePolicies.some(candidate => candidate.id === p.id)}
                            onClick={() => { setSelectedPolicy(p.id); setTab('evaluate'); }}>Evaluate</button>
                    </div>
                </article>;
            })}</div>
            {!policies.some(p => p.featured) && <p className="fg-muted">No featured policies yet. Open a compatible candidate's profile and select Feature policy.</p>}
            <h3>Saved candidate policies</h3>
            <p className="fg-muted">Packaged, compatible artifacts that have not been featured.</p>
            {policies.filter(p => !p.featured && p.compatible_metadata).map(p =>
                <div className="fg-list-row" key={p.id}>
                    <button className="fg-record-link" onClick={() => setDetail({ kind: 'policy', id: p.id })}>{nameOfPolicy(p)} →</button>
                    <span>{p.onnx_available && p.bundle_available ? 'Model & bundle available' : 'Incomplete artifacts'}</span>
                    <small>{p.status}</small></div>)}
            <details className="fg-policy-archive"><summary>Historical or incompatible policies ({policies.filter(p => !p.compatible_metadata).length})</summary>
                <p className="fg-muted">Older versions retain their original environment fingerprints. Featured policies with an available matching saved Unity player can be watched in Historical playback; other checkpoints remain research history.</p>
                {policies.filter(p => !p.compatible_metadata).map(p => <button key={p.id} className="fg-record-link"
                    onClick={() => setDetail({ kind: 'policy', id: p.id })}>{nameOfPolicy(p)} →</button>)}
            </details>
            <details className="fg-policy-archive"><summary>Unbundled training checkpoints</summary>
                {runs.flatMap(run => (run.checkpoint_files ?? []).map(file => ({ file, runId: run.id }))).map(item =>
                    <div className="fg-list-row" key={item.file}><strong>{item.runId}</strong><span>{item.file}</span><small>Training artifact</small></div>)}
            </details>
        </section>}
        {(tab === 'evaluate' || tab === 'watch') && <section className="fg-panel">
            <h2>{tab === 'watch' ? 'Watch a generalist policy' : 'Evaluate a generalist policy'}</h2>
            <p className="fg-muted">{tab === 'watch' ? 'Open a windowed Unity player on the connected Mac. Featured historical players use their own original verified build and saved drill.' : 'Run seeded inference against the selected current generalist scenario.'} Policies need a model and bundle; historical playback is Watch-only.</p>
            <div className="fg-form">
                <label>Policy<select value={selectedPolicy} onChange={e => setSelectedPolicy(e.target.value)}>
                    <option value="">Choose policy</option>
                    <optgroup label="Featured players">{selectablePolicies.filter(p => p.featured).map(p =>
                        <option key={p.id} value={p.id}>{p.display_name || p.id}{!p.compatible_metadata ? ' · Historical' : ''}</option>)}</optgroup>
                    <optgroup label="Current research checkpoints">{selectablePolicies.filter(p => !p.featured).map(p =>
                        <option key={p.id} value={p.id}>{p.display_name || p.id}</option>)}</optgroup>
                </select></label>
                {historicalSelected ? <div className="fg-historical-watch-note" role="status">
                    <strong>Historical playback</strong>
                    <p>Uses {currentPolicy!.display_name || currentPolicy!.id}'s original versioned Unity build and saved scenario
                        ({currentPolicy!.view_scenario || 'not recorded'}). Current drills cannot be selected for this model.
                        Its model and earlier training evidence remain unchanged.</p>
                </div> :
                    <GeneralistDrillPicker scenarios={scenarios} mode={tab === 'watch' ? 'watch' : 'evaluate'}
                        value={tab === 'watch' ? watchScenario : scenario} onChange={tab === 'watch' ? setWatchScenario : setScenario}/>}
                <label>Seed<input type="number" value={evaluationSeed} min={0} onChange={e => setEvaluationSeed(Number(e.target.value))}/></label>
                {tab === 'evaluate' && <label>Episodes<input type="number" value={episodes} min={1} max={10000} onChange={e => setEpisodes(Number(e.target.value))}/></label>}
            </div>
            {currentPolicy && <button className="fg-record-link" onClick={() => setDetail({ kind: 'policy', id: currentPolicy.id })}>View {currentPolicy.id} profile →</button>}
            {currentPolicy && !selectablePolicies.some(p => p.id === currentPolicy.id) &&
                <p role="alert">This policy cannot be played here. Historical featured players require their saved Unity build; current evaluation requires current scenario metadata.</p>}
            <div className="fg-actions"><button type="button" className="fg-button primary" disabled={!!busy || !selectablePolicies.some(p => p.id === selectedPolicy)} onClick={() => void doAction(tab, tab === 'watch' ? 'football_generalist_watch' : 'football_generalist_evaluate', { policyId: selectedPolicy, scenario: tab === 'watch' ? (historicalSelected ? currentPolicy!.view_scenario : watchScenario) : scenario, seed: evaluationSeed, ...(tab === 'evaluate' ? { episodes } : { arenas: 1 }) })}>{tab === 'watch' ? 'Open Unity player' : 'Run evaluation'}</button>
                {tab === 'evaluate' && <button type="button" className="fg-button" disabled={!!busy} onClick={() => void doAction('baseline', 'football_generalist_baseline', { scenario, seed: evaluationSeed, episodes })}>Run baseline</button>}</div>
            {tab === 'evaluate' && <div className="fg-evaluation-history">
                <div className="fg-panel-title"><h3>Evaluation history</h3><span>{activeEvaluations.length} active</span></div>
                <p className="fg-muted">Policy-first history, including evaluations started through other clients. Updates every 10 seconds.</p>
                <div className="fg-history-toolbar"><input aria-label="Search evaluation history" placeholder="Search policy or drill…"
                    value={historySearch} onChange={e => setHistorySearch(e.target.value)}/>
                    <div className="fg-filter-bar" role="group" aria-label="Filter evaluations">
                        {(['all','active','completed','failed'] as const).map(f => <button type="button" key={f}
                            aria-pressed={historyFilter === f} onClick={() => setHistoryFilter(f)}>{f}</button>)}
                    </div>
                </div>
                <h3>Evaluation runs · active first</h3>
                {[...filteredEvaluations].sort((a, b) => Number(isActive(b.status)) - Number(isActive(a.status))).map(item => <button className={'fg-eval-row' + (isActive(item.status) ? ' fg-active-item' : '')}
                    type="button" key={item.ticket} onClick={() => setDetail({ kind: 'evaluation', id: item.ticket })}>
                    <span className="fg-eval-primary"><strong>{policyName(item.policy_id || 'Baseline')}</strong><small>{item.status}</small></span>
                    <span>{scenarios.find(s => s.id === item.scenario)?.name || item.scenario || 'Unknown drill'}</span>
                    <span className="fg-eval-meta">{progressLabel(item)} · Seed {item.seed ?? '—'} · {when(item.started_at)}</span>
                </button>)}
                {!filteredEvaluations.length && <p className="fg-muted">No evaluation results match the selected filters.</p>}
            </div>}
            {!selectablePolicies.length && <p className="fg-muted">No suitable indexed policies are available for {tab === 'watch' ? 'playback' : 'evaluation'} yet.</p>}
        </section>}
        {tab === 'checks' && <section className="fg-panel"><h2>Generalist contract</h2>
            <div className="fg-details"><span>Contract: {manifest?.contract.contract_id ?? '—'}</span><span>Behavior: {manifest?.contract.behavior ?? '—'}</span><span>Observations: {manifest?.contract.observations.size ?? '—'}</span><span>Actions: {manifest?.contract.actions.continuous ?? '—'}</span><span>Contract SHA: {shortHash(manifest?.fingerprints.contract_sha256)}</span><span>Scenario SHA: {shortHash(manifest?.fingerprints.scenario_sha256)}</span></div>
            <h3>Actions</h3>{manifest?.contract.actions.channels.map(channel => <div className="fg-list-row" key={channel.index}><strong>{channel.index}</strong><span>{channel.name}</span><small>{channel.mapping || channel.activation || 'Continuous'}</small></div>)}
            <p className="fg-muted">Manifest inspection verifies metadata structure, not learned policy competence or Unity runtime acceptance.</p>
        </section>}
        {tab === 'archive' && <section className="fg-panel"><div className="fg-panel-title"><h2>Legacy specialist archive</h2><button type="button" className="fg-button" onClick={() => void loadArchive()} disabled={!!busy}>Reload archive</button></div>
            <p className="fg-muted">Historical records only. These models are not selectable for generalist training, evaluation or playback.</p>
            <h3>Specialist policies</h3>{legacy?.policies.map(p => <div className="fg-list-row" key={p.id}><strong>{p.id}</strong><span>{p.drill}</span></div>)}
            <h3>Specialist runs</h3>{legacy?.jobs.slice(0, 100).map(j => <div className="fg-list-row" key={j.id}><strong>{j.id}</strong><span>{j.drill}</span><small>{j.state}</small></div>)}
            {!legacy && <p className="fg-muted">Loading archive…</p>}
        </section>}
        {!!ticket && <section className="fg-panel" aria-label="Latest operation"><div className="fg-panel-title"><h2>Latest operation</h2><small>{ticket.status}</small></div><strong>{ticket.action}</strong>
            {ticket.action === 'generalist_train' && ticket.status === 'running' && <button type="button" className="fg-button" onClick={() => {
                if (!window.confirm('Request a graceful interrupt of this Atlas-owned training run?')) return;
                void callTool('football_generalist_stop', { runId: ticket.ticket })
                    .then(() => setNotice('Training interrupt requested. Inspect the receipt for its final state.'))
                    .catch(e => setError(e instanceof Error ? e.message : String(e)));
            }}>Stop training</button>}
            {ticket.action === 'generalist_train' && ticket.result?.run_id && <button className="fg-record-link" onClick={() => { setTab('runs'); setDetail({ kind: 'run', id: ticket.result!.run_id! }); }}>Open training run →</button>}
            {['generalist_evaluate', 'generalist_baseline'].includes(ticket.action) && <button className="fg-record-link" onClick={() => { setTab('evaluate'); setDetail({ kind: 'evaluation', id: ticket.ticket }); }}>Open evaluation details →</button>}
            <p className="fg-muted">{ticket.ticket}</p>{ticket.result && <pre className="fg-output">{JSON.stringify(ticket.result, null, 2)}</pre>}{ticket.output && <pre className="fg-output">{ticket.output}</pre>}{ticket.error && <pre className="fg-error fg-output">{ticket.error}</pre>}
            {ticket.action === 'generalist_watch' && <div className="fg-stack">
                <div className="fg-details">
                    <span>Viewer: {ticket.viewer?.state === 'player_logging' ? 'Unity player is logging' : ticket.viewer?.state === 'launch_failed' ? 'Launch failed' : ticket.viewer?.state === 'closed' ? 'Player closed' : 'Launch not yet verified'}</span>
                    <span>Launch method: {ticket.viewer?.launch_method ?? 'Pending'}</span>
                </div>
                <p className="fg-muted">{ticket.viewer?.note ?? 'The standalone player is separate from the Unity Editor. A launch receipt does not confirm a visible window.'}</p>
                {ticket.viewer?.log_tail && <details><summary>Unity player log (last 4 KB)</summary><pre className="fg-output">{ticket.viewer.log_tail}</pre></details>}
            </div>}
            <p className="fg-muted">A launch receipt is not training or evaluation success.</p></section>}
        {activity.length > 0 && <section className="fg-panel"><div className="fg-panel-title"><h2>Inference activity</h2><span>{activity.length} receipts</span></div>
            {activity.slice(0, 12).map(item => <div className="fg-list-row" key={item.ticket}><strong>{item.action.replace('generalist_', '')}</strong><span>{item.scenario ?? '—'}</span>{['generalist_evaluate', 'generalist_baseline'].includes(item.action) ? <button className="fg-link" onClick={() => setDetail({ kind: 'evaluation', id: item.ticket })}>{item.status} →</button> : <small>{item.status}</small>}</div>)}</section>}
    </main>;
}
