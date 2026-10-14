import { useCallback, useEffect, useMemo, useState } from 'react';
import { callTool } from './api';
import { GeneralistRunView, GeneralistPolicyView, GeneralistEvaluationView } from './FootballGeneralistDetails';
import type { GeneralistManifest } from './FootballGeneralistDashboard';
import './football-training.css';
import './football-generalist-experience.css';

type Run = { id: string; family: string; scenario?: string; state: string; started_at?: string; seed?: number; num_envs?: number; checkpoints?: number; checkpoint_files?: string[]; packaging?: { status: string; policy_id?: string; error?: string }; output_dir?: string; contract_sha256?: string; scenario_sha256?: string };
type Policy = { id: string; behavior: string; status: string; source: string; compatible_metadata: boolean; executable_verified: boolean; view_scenario?: string; onnx_available: boolean; bundle_available: boolean };
type Receipt = { accepted?: boolean; ticket: string; action: string; status: string; scenario?: string; policy_id?: string; started_at?: string; output?: string; error?: string; note?: string; result?: { run_id?: string; episodes?: number; outcomes?: Record<string, number> } };
type Legacy = { policies: { id: string; drill: string }[]; jobs: { id: string; drill: string; state: string }[] };
type Tab = 'home' | 'train' | 'runs' | 'policies' | 'evaluate' | 'watch' | 'checks' | 'archive';

const tabs: { id: Tab; label: string }[] = [
    { id: 'home', label: 'Home' }, { id: 'train', label: 'Train' },
    { id: 'runs', label: 'Runs' }, { id: 'policies', label: 'Policies' },
    { id: 'evaluate', label: 'Evaluate' }, { id: 'watch', label: 'Watch' },
    { id: 'checks', label: 'Contract' }, { id: 'archive', label: 'Legacy archive' },
];
const shortHash = (value?: string) => value ? value.slice(0, 10) : '—';
const when = (value?: string) => value ? new Date(value).toLocaleString() : '—';

export function FootballGeneralistExperience() {
    const [tab, setTab] = useState<Tab>('home');
    const [manifest, setManifest] = useState<GeneralistManifest | null>(null);
    const [runs, setRuns] = useState<Run[]>([]);
    const [policies, setPolicies] = useState<Policy[]>([]);
    const [activity, setActivity] = useState<Receipt[]>([]);
    const [legacy, setLegacy] = useState<Legacy | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState('');
    const [loading, setLoading] = useState(true);
    const [scenario, setScenario] = useState('mix');
    const [preset, setPreset] = useState<'smoke' | 'pilot_100k'>('smoke');
    const [seed, setSeed] = useState(42);
    const [workers, setWorkers] = useState(1);
    const [basePort, setBasePort] = useState(5605);
    const [episodes, setEpisodes] = useState(10);
    const [evaluationSeed, setEvaluationSeed] = useState(515);
    const [selectedPolicy, setSelectedPolicy] = useState('');
    const [ticket, setTicket] = useState<Receipt | null>(null);
    const [detail, setDetail] = useState<{ kind: 'run' | 'policy' | 'evaluation'; id: string } | null>(null);

    const refresh = useCallback(async () => {
        const [m, r, p, a] = await Promise.all([
            callTool<GeneralistManifest>('football_generalist_manifest'),
            callTool<Run[]>('football_generalist_runs'),
            callTool<Policy[]>('football_generalist_policies'),
            callTool<Receipt[]>('football_generalist_activity'),
        ]);
        if (!m.available || m.contract.contract_id !== 'football-generalist-v2') throw new Error('Generalist V2 contract unavailable on the connected Node.');
        setManifest(m);
        setRuns(r);
        setPolicies(p);
        setActivity(a);
        setSelectedPolicy(current => current || p[0]?.id || '');
        setError('');
    }, []);
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
    const currentPolicy = policies.find(p => p.id === selectedPolicy);
    const scenarioOptions = useMemo(() => [{ id: 'mix', name: 'Mixed scenarios' }, ...scenarios.map(s => ({ id: s.id, name: s.name }))], [scenarios]);
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
            onPolicy={id => setDetail({ kind: 'policy', id })}/>}
        {detail.kind === 'evaluation' && <GeneralistEvaluationView ticket={detail.id} onBack={() => setDetail(null)}
            onPolicy={id => setDetail({ kind: 'policy', id })}/>}
        {detail.kind === 'policy' && (policies.find(p => p.id === detail.id)
            ? <GeneralistPolicyView policy={policies.find(p => p.id === detail.id)!} runs={runs} activity={activity}
                onBack={() => setDetail(null)}
                onRun={id => setDetail({ kind: 'run', id })}
                onEvaluation={id => setDetail({ kind: 'evaluation', id })}
                onWatch={id => { setSelectedPolicy(id); setTab('watch'); setDetail(null); }}
                onEvaluate={id => { setSelectedPolicy(id); setTab('evaluate'); setDetail(null); }}/>
            : <section className="fg-panel"><p>Policy is no longer available in the generalist index.</p><button className="fg-button" onClick={() => setDetail(null)}>Back</button></section>)}
    </main>;
    return <main className="fg">
        <header className="fg-heading">
            <div><p className="fg-eyebrow">AI FOOTBALL / FYP</p><h1>Generalist</h1><p className="fg-subtitle">Unity reinforcement learning · one policy, multiple scenarios</p></div>
            <button type="button" className="fg-button" onClick={() => void refresh().catch(e => setError(String(e)))} disabled={!!busy}>Refresh</button>
        </header>
        {loading && <p role="status">Connecting to the generalist workspace…</p>}
        {error && <p className="fg-error" role="alert">{error}</p>}
        {notice && <p className="fg-notice" role="status">{notice}</p>}
        <nav className="fg-nav" aria-label="Football sections">{tabs.map(t =>
            <button type="button" key={t.id} className={tab === t.id ? 'active' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => { setDetail(null); setTab(t.id); setError(''); if (t.id === 'archive' && !legacy) void loadArchive(); }}>{t.label}</button>)}</nav>
        {tab === 'home' && <div className="fg-stack">
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
        </div>}
        {tab === 'train' && <section className="fg-panel">
            <h2>New training run</h2><p className="fg-muted">Starts one PPO policy; parallel environments collect experience for that same policy. An isolated Unity build is prepared by the launch bridge.</p>
            <div className="fg-form">
                <label>Scenario<select value={scenario} onChange={e => setScenario(e.target.value)}>{scenarioOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                <label>Preset<select value={preset} onChange={e => setPreset(e.target.value as 'smoke' | 'pilot_100k')}><option value="smoke">Smoke</option><option value="pilot_100k">Pilot · 100k steps</option></select></label>
                <label>Training seed<input type="number" value={seed} min={0} onChange={e => setSeed(Number(e.target.value))}/></label>
                <label>Parallel environments<input type="number" value={workers} min={1} max={16} onChange={e => setWorkers(Number(e.target.value))}/></label>
                <label>Base port<input type="number" value={basePort} min={1024} max={65519} onChange={e => setBasePort(Number(e.target.value))}/></label>
            </div>
            <button className="fg-button primary" disabled={!!busy || !manifest || manifest.curriculum.held_out_seeds?.includes(seed)} onClick={() => {
                if (window.confirm('Start one generalist PPO training run on the connected Mac?')) void doAction('train', 'football_generalist_train', { scenario, preset, seed, arenas: workers, basePort });
            }}>{busy === 'train' ? 'Starting…' : 'Launch generalist training'}</button>
            {manifest?.curriculum.held_out_seeds?.includes(seed) && <p role="alert">This seed is reserved for held-out evaluation.</p>}
        </section>}
        {tab === 'runs' && <section className="fg-panel"><div className="fg-panel-title"><h2>Training runs</h2><span>{runs.length} discovered</span></div>
            <p className="fg-muted">Includes runs started from the terminal. A discovered receipt does not establish successful completion.</p>
            {runs.map(r => <div className="fg-run" key={r.id}><div className="fg-panel-title"><button className="fg-record-link" onClick={() => setDetail({ kind: 'run', id: r.id })}>{r.id} →</button><small>{r.state}</small></div>
                <div className="fg-details"><span>Scenario: {r.scenario ?? '—'}</span><span>Seed: {r.seed ?? '—'}</span><span>Environments: {r.num_envs ?? '—'}</span><span>ONNX checkpoints: {r.checkpoints ?? 0}</span><span>Recorded: {when(r.started_at)}</span></div>
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
        {tab === 'policies' && <section className="fg-panel"><div className="fg-panel-title"><h2>Generalist policies</h2><span>{policies.length} registered</span></div>
            <p className="fg-muted">Only explicit generalist policy metadata is listed. The Unity runner rechecks all contract, implementation, ONNX and bundle hashes before inference.</p>
            {policies.map(p => <div className="fg-run" key={p.id}><button className="fg-record-link" onClick={() => setDetail({ kind: 'policy', id: p.id })}>{p.id} →</button>
                <div className="fg-details"><span>{p.status}</span><span>{p.compatible_metadata ? 'Contract/scenario match' : 'Incompatible metadata'}</span><span>{p.bundle_available ? 'Bundle present' : 'Bundle missing'}</span><span>{p.onnx_available ? 'ONNX present' : 'ONNX missing'}</span></div>
                <small className="fg-muted">{p.source}</small></div>)}
            {!policies.length && <p className="fg-muted">No registered generalist policies. Checkpoints are not automatically considered validated policies.</p>}
            <h3>Unregistered ONNX checkpoints</h3>
            {runs.flatMap(run => (run.checkpoint_files ?? []).map(file => ({ file, runId: run.id }))).map(item =>
                <div className="fg-list-row" key={item.file}><strong>{item.runId}</strong><span>{item.file}</span><small>Not bundled</small></div>)}
            {!runs.some(run => (run.checkpoint_files?.length ?? 0) > 0) && <p className="fg-muted">No exported checkpoints found in recorded training runs.</p>}
        </section>}
        {(tab === 'evaluate' || tab === 'watch') && <section className="fg-panel">
            <h2>{tab === 'watch' ? 'Watch a generalist policy' : 'Evaluate a generalist policy'}</h2>
            <p className="fg-muted">{tab === 'watch' ? 'Open a graphical Unity inference session on the connected Mac.' : 'Run seeded inference against the selected generalist scenario.'} Only explicitly indexed policies with a model and bundle are selectable.</p>
            <div className="fg-form">
                <label>Policy<select value={selectedPolicy} onChange={e => setSelectedPolicy(e.target.value)}>
                    <option value="">Choose policy</option>{runnablePolicies.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
                <label>Scenario<select value={scenario} onChange={e => setScenario(e.target.value)}>{scenarioOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                <label>Seed<input type="number" value={evaluationSeed} min={0} onChange={e => setEvaluationSeed(Number(e.target.value))}/></label>
                {tab === 'evaluate' && <label>Episodes<input type="number" value={episodes} min={1} max={10000} onChange={e => setEpisodes(Number(e.target.value))}/></label>}
            </div>
            {currentPolicy && <button className="fg-record-link" onClick={() => setDetail({ kind: 'policy', id: currentPolicy.id })}>View {currentPolicy.id} profile →</button>}
            {currentPolicy && !runnablePolicies.includes(currentPolicy) && <p role="alert">This policy is not executable with the current generalist metadata.</p>}
            <div className="fg-actions"><button type="button" className="fg-button primary" disabled={!!busy || !runnablePolicies.some(p => p.id === selectedPolicy)} onClick={() => void doAction(tab, tab === 'watch' ? 'football_generalist_watch' : 'football_generalist_evaluate', { policyId: selectedPolicy, scenario, seed: evaluationSeed, ...(tab === 'evaluate' ? { episodes } : { arenas: 1 }) })}>{tab === 'watch' ? 'Open Unity viewer' : 'Run evaluation'}</button>
                {tab === 'evaluate' && <button type="button" className="fg-button" disabled={!!busy} onClick={() => void doAction('baseline', 'football_generalist_baseline', { scenario, seed: evaluationSeed, episodes })}>Run baseline</button>}</div>
            {tab === 'evaluate' && <><h3>Saved evaluations</h3>{activity.filter(item => ['generalist_evaluate', 'generalist_baseline'].includes(item.action)).map(item =>
                <button key={item.ticket} className="fg-record-link" onClick={() => setDetail({ kind: 'evaluation', id: item.ticket })}>{item.scenario ?? '—'} · {item.status} · {item.ticket} →</button>)}
                {!activity.some(item => ['generalist_evaluate', 'generalist_baseline'].includes(item.action)) && <p className="fg-muted">No saved generalist evaluations yet.</p>}</>}
            {!runnablePolicies.length && <p className="fg-muted">No compatible registered policies are available for inference yet.</p>}
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
            <p className="fg-muted">A launch receipt is not training or evaluation success.</p></section>}
        {activity.length > 0 && <section className="fg-panel"><div className="fg-panel-title"><h2>Inference activity</h2><span>{activity.length} receipts</span></div>
            {activity.slice(0, 12).map(item => <div className="fg-list-row" key={item.ticket}><strong>{item.action.replace('generalist_', '')}</strong><span>{item.scenario ?? '—'}</span>{['generalist_evaluate', 'generalist_baseline'].includes(item.action) ? <button className="fg-link" onClick={() => setDetail({ kind: 'evaluation', id: item.ticket })}>{item.status} →</button> : <small>{item.status}</small>}</div>)}</section>}
    </main>;
}
