import { useRouteTiming } from './performance';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callTool } from './api';
import { useLiveApplicationResource } from './applicationCache';
import { GeneralistRunView, GeneralistPolicyView, GeneralistEvaluationView } from './FootballGeneralistDetails';
import type { GeneralistManifest } from './FootballGeneralistDashboard';
import { isActive, nameOfPolicy, type PolicyAssessment } from './football-skill-model';
import './football-training.css';
import './football-generalist-experience.css';
import { SkeletonRows } from './Skeletons';
import { FypV1Experience } from './FypV1Experience';

const G05_FOOT_SCENARIO = 's1-dribble-foot-touch-g05-v1';
const G05_FOOT_SOURCE = 'atlas-generalist-61a91798db31';
type Run = { id: string; family: string; scenario?: string; state: string; started_at?: string; seed?: number; num_envs?: number; checkpoints?: number; checkpoint_files?: string[]; packaging?: { status: string; policy_id?: string; error?: string }; output_dir?: string; contract_sha256?: string; scenario_sha256?: string; initialization_available?: boolean; initialization?: { source_run_id?: string; checkpoint_sha256?: string } | null };
type Policy = { id: string; display_name?: string | null; featured?: boolean; source_policy_id?: string | null; onnx_sha256?: string | null; behavior: string; status: string; source: string; compatible_metadata: boolean; historical_watch_available?: boolean; historical_scenarios?: string[]; legacy_preview_available?: boolean; executable_verified: boolean; view_scenario?: string; onnx_available: boolean; bundle_available: boolean };
type Receipt = { accepted?: boolean; ticket: string; action: string; status: string; scenario?: string; policy_id?: string; seed?: number; started_at?: string; output?: string; error?: string; note?: string; requested_episodes?: number; result?: { run_id?: string; episodes?: number; outcomes?: Record<string, number>; success_rate?: number | null }; viewer?: { state: string; launch_method: string; launcher_alive: boolean; player_log_detected: boolean; log_tail?: string; note?: string } };
type Review = { phase: string; scenario: string; variant: string; verdict: string; note: string; visual_evidence?: string; policy_id?: string; run_id?: string; evaluation_ticket?: string; watch_ticket?: string; contract_sha256?: string; scenario_sha256?: string; updated_at: string };
type Tab = 'fyp' | 'runs' | 'policies' | 'evaluate' | 'watch' | 'review' | 'checks';
type Section = 'experiments' | 'evidence';

const SHOWCASE_DRILL = 'dribbling_showcase_v1';
const LEGACY_PREVIEW = 'legacy_preview_v1';
const sections: { id: Section; label: string; defaultTab: Tab; tabs: { id: Tab; label: string }[] }[] = [
    { id: 'experiments', label: 'Experiments', defaultTab: 'fyp', tabs: [
        { id: 'fyp', label: 'FYP training' }] },
    { id: 'evidence', label: 'Evidence', defaultTab: 'runs', tabs: [
        { id: 'runs', label: 'Runs' }, { id: 'policies', label: 'Policies' },
        { id: 'evaluate', label: 'Evaluate' }, { id: 'watch', label: 'Watch' }, { id: 'review', label: 'Review decision' }, { id: 'checks', label: 'Contract' }] },
];
const sectionFor = (tab: Tab) => sections.find(section => section.tabs.some(item => item.id === tab))!;
const shortHash = (value?: string) => value ? value.slice(0, 10) : '—';
const when = (value?: string) => value ? new Date(value).toLocaleString() : '—';

export function FootballGeneralistExperience() {
    const manifestResource = useLiveApplicationResource<GeneralistManifest>('football_generalist_manifest');
    const runsResource = useLiveApplicationResource<Run[]>('football_generalist_runs');
    const policiesResource = useLiveApplicationResource<Policy[]>('football_generalist_policies');
    const activityResource = useLiveApplicationResource<Receipt[]>('football_generalist_activity');
    const assessmentsResource = useLiveApplicationResource<{ policies: PolicyAssessment[] }>('football_generalist_assessments');
    const cachedManifest = manifestResource.cached?.available && manifestResource.cached.contract?.contract_id === 'football-generalist-v2' ? manifestResource.cached : null;
    const [tab, setTab] = useState<Tab>('fyp');
    const [manifest, setManifest] = useState<GeneralistManifest | null>(cachedManifest);
    const [runs, setRuns] = useState<Run[]>(Array.isArray(runsResource.cached) ? runsResource.cached : []);
    const [policies, setPolicies] = useState<Policy[]>(Array.isArray(policiesResource.cached) ? policiesResource.cached : []);
    const [assessments, setAssessments] = useState<PolicyAssessment[]>(Array.isArray(assessmentsResource.cached?.policies) ? assessmentsResource.cached.policies : []);
    const [historySearch, setHistorySearch] = useState('');
    const [historyFilter, setHistoryFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all');
    const [runsFilter, setRunsFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all');
    const [activity, setActivity] = useState<Receipt[]>(Array.isArray(activityResource.cached) ? activityResource.cached : []);
    const [reviews, setReviews] = useState<Review[]>([]);
    const [reviewPhase, setReviewPhase] = useState('g05');
    const [reviewScenario, setReviewScenario] = useState(G05_FOOT_SCENARIO);
    const [reviewVariant, setReviewVariant] = useState('FootV1');
    const [reviewVerdict, setReviewVerdict] = useState('pending');
    const [reviewNote, setReviewNote] = useState('');
    const [reviewVisualEvidence, setReviewVisualEvidence] = useState('');
    const [reviewRunId, setReviewRunId] = useState('');
    const [reviewEvaluationTicket, setReviewEvaluationTicket] = useState('');
    const [reviewWatchTicket, setReviewWatchTicket] = useState('');
    const [reviewPolicyId, setReviewPolicyId] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState('');
    const [loading, setLoading] = useState(!cachedManifest);
    const [refreshing, setRefreshing] = useState(false);
    const [refreshStatus, setRefreshStatus] = useState('Not synced yet');
    const [assessmentWarning, setAssessmentWarning] = useState('');
    const activeRefresh = useRef<Promise<void> | null>(null);
    const [scenario, setScenario] = useState('mix');
    const watchScenario = SHOWCASE_DRILL;
    const [historicalScenarioSelection, setHistoricalScenarioSelection] = useState('');
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
                    p.value.find(policy => policy.featured && (policy.compatible_metadata || policy.historical_watch_available || policy.legacy_preview_available) &&
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
    const historicalWatchPolicies = policies.filter(p => !p.compatible_metadata &&
        p.historical_watch_available && p.bundle_available && p.onnx_available);
    const legacyPreviewPolicies = policies.filter(p => !p.compatible_metadata && !historicalWatchPolicies.includes(p) &&
        p.legacy_preview_available && p.bundle_available && p.onnx_available);
    const watchPolicies = [...runnablePolicies, ...historicalWatchPolicies, ...legacyPreviewPolicies];
    const selectablePolicies = tab === 'watch' ? watchPolicies : runnablePolicies;
    const currentPolicy = policies.find(p => p.id === selectedPolicy);
    const historicalSelected = tab === 'watch' && currentPolicy && historicalWatchPolicies.some(p => p.id === currentPolicy.id);
    const historicalScenario = currentPolicy?.historical_scenarios?.includes(historicalScenarioSelection)
        ? historicalScenarioSelection : currentPolicy?.view_scenario || '';
    const previewSelected = tab === 'watch' && currentPolicy && legacyPreviewPolicies.some(p => p.id === currentPolicy.id);
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
    const reviewRuns = runs.filter(r => r.scenario === reviewScenario);
    const reviewEvaluations = activity.filter(item => item.action === 'generalist_evaluate' && item.scenario === reviewScenario);
    const reviewWatches = activity.filter(item => item.action === 'generalist_watch' && item.scenario === reviewScenario);
    const reviewScenarios = [...new Set([...scenarios.map(s => s.id), ...runs.map(r => r.scenario), ...activity.map(item => item.scenario), G05_FOOT_SCENARIO].filter((id): id is string => !!id))];
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
    const loadReviews = async () => {
        try { setReviews(await callTool<Review[]>('football_generalist_reviews')); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    };
    const saveReview = async () => {
        setBusy('review'); setError('');
        try {
            await callTool('football_generalist_review_update', {
                phase: reviewPhase, scenario: reviewScenario, variant: reviewVariant.trim(), verdict: reviewVerdict, note: reviewNote.trim(),
                ...(reviewVisualEvidence.trim() ? { visualEvidence: reviewVisualEvidence.trim() } : {}),
                ...(reviewRunId ? { runId: reviewRunId } : {}), ...(reviewEvaluationTicket ? { evaluationTicket: reviewEvaluationTicket } : {}),
                ...(reviewWatchTicket ? { watchTicket: reviewWatchTicket } : {}), ...(reviewPolicyId ? { policyId: reviewPolicyId } : {}),
                ...(reviewRunId && /^[a-f0-9]{64}$/.test(reviewRuns.find(r => r.id === reviewRunId)?.contract_sha256 ?? '') ? { contractSha256: reviewRuns.find(r => r.id === reviewRunId)!.contract_sha256 } : {}),
                ...(reviewRunId && /^[a-f0-9]{64}$/.test(reviewRuns.find(r => r.id === reviewRunId)?.scenario_sha256 ?? '') ? { scenarioSha256: reviewRuns.find(r => r.id === reviewRunId)!.scenario_sha256 } : {}),
            });
            setNotice('Review recorded. Training, policy status and roadmap phase are unchanged.');
            await loadReviews();
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
         {error && <p className="fg-error" role="alert">{error}</p>}
        {assessmentWarning && <p className="fg-muted" role="status">{assessmentWarning}</p>}
        {notice && <p className="fg-notice" role="status">{notice}</p>}
        <nav className="fg-nav" aria-label="Football sections">{sections.map(section =>
            <button type="button" key={section.id} className={sectionFor(tab).id === section.id ? 'active' : ''}
                aria-current={sectionFor(tab).id === section.id ? 'page' : undefined}
                onClick={() => { setDetail(null); setTab(section.defaultTab); setError(''); }}>{section.label}</button>)}</nav>
        {sectionFor(tab).tabs.length > 1 && <nav className="fg-subnav" aria-label={`${sectionFor(tab).label} steps`}>
            {sectionFor(tab).tabs.map(item => <button type="button" key={item.id} aria-current={tab === item.id ? 'step' : undefined}
                className={tab === item.id ? 'active' : ''} onClick={() => { setDetail(null); setTab(item.id); setError(''); if (item.id === 'review') void loadReviews(); }}>{item.label}</button>)}
        </nav>}
        {tab === 'fyp' && <FypV1Experience />}
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
                <div className="fg-details"><span>Scenario: {r.scenario ?? '—'}</span><span>Contract: {r.scenario === G05_FOOT_SCENARIO ? 'FootV1 · 54/7' : r.contract_sha256 && r.contract_sha256 === manifest?.fingerprints.contract_sha256 ? 'V2 · 54/5' : 'See recorded contract SHA'}</span><span>Contract SHA: {shortHash(r.contract_sha256)}</span><span>Scenario SHA: {shortHash(r.scenario_sha256)}</span><span>Seed: {r.seed ?? '—'}</span><span>Environments: {r.num_envs ?? '—'}</span><span>ONNX checkpoints: {r.checkpoints ?? 0}</span><span>Recorded: {when(r.started_at)}</span>{r.initialization?.source_run_id && <span>Initialised from: {r.initialization.source_run_id}</span>}</div>
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
            <p className="fg-muted">{tab === 'watch' ? 'Open Unity on the connected Mac. Original historical playback requires an exact archived build; Legacy preview plays saved weights on today’s physics and cannot certify historical results.' : 'Run seeded inference against the selected current generalist scenario.'} Models and bundles remain immutable.</p>
            <div className="fg-form">
                <label>Policy<select value={selectedPolicy} onChange={e => setSelectedPolicy(e.target.value)}>
                    <option value="">Choose policy</option>
                    <optgroup label="Featured players">{selectablePolicies.filter(p => p.featured).map(p =>
                        <option key={p.id} value={p.id}>{p.display_name || p.id}{historicalWatchPolicies.includes(p) ? ' · Historical' : legacyPreviewPolicies.includes(p) ? ' · Modern preview' : ''}</option>)}</optgroup>
                    <optgroup label="Research checkpoints and legacy previews">{selectablePolicies.filter(p => !p.featured).map(p =>
                        <option key={p.id} value={p.id}>{p.display_name || p.id}{historicalWatchPolicies.includes(p) ? ' · Historical' : legacyPreviewPolicies.includes(p) ? ' · Modern preview' : ''}</option>)}</optgroup>
                </select></label>
                {historicalSelected ? <div className="fg-historical-watch-note" role="status">
                    <strong>Historical playback</strong>
                    <p>Uses the original source-pinned Unity build and exact saved model. Only scenarios recorded in that build are available; earlier training evidence remains unchanged.</p>
                    <label>Historical scenario<select value={historicalScenario} onChange={e => setHistoricalScenarioSelection(e.target.value)}>
                        {(currentPolicy!.historical_scenarios?.length ? currentPolicy!.historical_scenarios : [currentPolicy!.view_scenario || '']).filter(Boolean).map(id =>
                            <option key={id} value={id}>{scenarios.find(s => s.id === id)?.name || id} ({id})</option>)}
                    </select></label>
                </div> : previewSelected ? <div className="fg-historical-watch-note" role="status">
                    <strong>Legacy model preview — modern environment</strong>
                    <p>The original ONNX weights and model bundle will be hash-verified and loaded into today's
                        54/5 generalist Unity player for a fixed 3m dribbling drill. Physics, scenarios and
                        agent implementation differ from the original. This is visual inspection only, not
                        authentic historical playback or an evaluation result.</p>
                </div> :
                    <p className="fg-muted">Scenario: {scenarios.find(item => item.id === (tab === 'watch' ? watchScenario : scenario))?.name || (tab === 'watch' ? watchScenario : scenario)}</p>}
                <label>Seed<input type="number" value={evaluationSeed} min={0} onChange={e => setEvaluationSeed(Number(e.target.value))}/></label>
                {tab === 'evaluate' && <label>Episodes<input type="number" value={episodes} min={1} max={10000} onChange={e => setEpisodes(Number(e.target.value))}/></label>}
            </div>
            {currentPolicy && <button className="fg-record-link" onClick={() => setDetail({ kind: 'policy', id: currentPolicy.id })}>View {currentPolicy.id} profile →</button>}
            {currentPolicy && !selectablePolicies.some(p => p.id === currentPolicy.id) &&
                <p role="alert">This policy cannot be played here. Original historical playback requires its archived Unity build; a preview requires a verified current player and unchanged model/ABI.</p>}
            <div className="fg-actions"><button type="button" className="fg-button primary" disabled={!!busy || !selectablePolicies.some(p => p.id === selectedPolicy)} onClick={() => void doAction(tab, tab === 'watch' ? 'football_generalist_watch' : 'football_generalist_evaluate', { policyId: selectedPolicy, scenario: tab === 'watch' ? (previewSelected ? LEGACY_PREVIEW : historicalSelected ? historicalScenario : watchScenario) : scenario, seed: evaluationSeed, ...(tab === 'evaluate' ? { episodes } : { arenas: 1 }) })}>{tab === 'watch' ? 'Open Unity player' : 'Run evaluation'}</button>
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
        {tab === 'review' && <section className="fg-panel">
            <h2>Experiment evidence and human decision</h2>
            <p className="fg-muted">Link recorded receipts to one versioned experiment. A verdict records what the reviewer saw; it does not promote a policy or advance the FYP phase.</p>
            <div className="fg-form">
                <label>Phase<select value={reviewPhase} onChange={e => setReviewPhase(e.target.value)}>{['g05','g1','g2','g3','g4','g5'].map(id => <option key={id} value={id}>{id === 'g05' ? 'G0.5' : id.toUpperCase()}</option>)}</select></label>
                <label>Scenario<select value={reviewScenario} onChange={e => { setReviewScenario(e.target.value); setReviewRunId(''); setReviewEvaluationTicket(''); }}>{reviewScenarios.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
                <label>Mechanics variant<input value={reviewVariant} maxLength={80} onChange={e => setReviewVariant(e.target.value)}/></label>
                <label>Verdict<select value={reviewVerdict} onChange={e => setReviewVerdict(e.target.value)}>{['pending','keep','adopt','revise','stop'].map(id => <option key={id} value={id}>{id}</option>)}</select></label>
                <label>Training run<select value={reviewRunId} onChange={e => setReviewRunId(e.target.value)}><option value="">No run linked</option>{reviewRuns.map(run => <option key={run.id} value={run.id}>{run.id} · {run.state}</option>)}</select></label>
                <label>Evaluation receipt<select value={reviewEvaluationTicket} onChange={e => setReviewEvaluationTicket(e.target.value)}><option value="">No evaluation linked</option>{reviewEvaluations.map(item => <option key={item.ticket} value={item.ticket}>{item.ticket} · {item.status}</option>)}</select></label>
                <label>Watch receipt<select value={reviewWatchTicket} onChange={e => setReviewWatchTicket(e.target.value)}><option value="">No Watch linked</option>{reviewWatches.map(item => <option key={item.ticket} value={item.ticket}>{item.ticket} · {item.status}</option>)}</select></label>
                <label>Policy<select value={reviewPolicyId} onChange={e => setReviewPolicyId(e.target.value)}><option value="">No policy linked</option>{policies.map(policy => <option key={policy.id} value={policy.id}>{nameOfPolicy(policy)}</option>)}</select></label>
            </div>
            <label className="fg-review-note">What did the reviewer observe, and what should happen next?<textarea value={reviewNote} maxLength={2000} onChange={e => setReviewNote(e.target.value)} /></label>
            <label className="fg-review-note">Visual evidence source (Watch ticket, seed/episode list, or external review packet)<input value={reviewVisualEvidence} maxLength={300} onChange={e => setReviewVisualEvidence(e.target.value)} /></label>
            <div className="fg-setup-summary">
                <strong>Recorded evidence for {reviewScenario}</strong>
                <span>{reviewRuns.length} training runs</span><span>{reviewEvaluations.length} evaluation receipts</span>
                <span>{reviewWatches.length} Watch receipts for this scenario</span>
                {reviewRunId && <span>Run contract SHA: {shortHash(reviewRuns.find(run => run.id === reviewRunId)?.contract_sha256)}</span>}
                {reviewRunId && <span>Run scenario SHA: {shortHash(reviewRuns.find(run => run.id === reviewRunId)?.scenario_sha256)}</span>}
                {reviewEvaluations.find(item => item.ticket === reviewEvaluationTicket) && <span>Evaluation: {progressLabel(reviewEvaluations.find(item => item.ticket === reviewEvaluationTicket)!)}</span>}
            </div>
            <p className="fg-muted">Scripted physics, learned training, held-out evaluation and visual Watch are separate evidence. Compare scores only when scenario, controller, build and policy conditions match.</p>
            <button type="button" className="fg-button primary" disabled={!!busy || !reviewVariant.trim() || !reviewNote.trim() || (reviewVerdict !== 'pending' && (!reviewVisualEvidence.trim() || (!reviewRunId && !reviewEvaluationTicket && !reviewWatchTicket)))} onClick={() => void saveReview()}>Save review</button>
            <h3>Recorded decisions</h3>
            {reviews.map(review => <div className="fg-run" key={`${review.phase}:${review.scenario}:${review.variant}`}>
                <strong>{review.phase.toUpperCase()} · {review.scenario} · {review.variant}</strong>
                <div className="fg-details"><span>Verdict: {review.verdict}</span><span>Updated: {when(review.updated_at)}</span><span>Run: {review.run_id ?? '—'}</span><span>Evaluation: {review.evaluation_ticket ?? '—'}</span><span>Watch: {review.watch_ticket ?? '—'}</span><span>Contract SHA: {shortHash(review.contract_sha256)}</span><span>Scenario SHA: {shortHash(review.scenario_sha256)}</span></div>
                {review.visual_evidence && <p className="fg-muted">Visual source: {review.visual_evidence}</p>}
                <p>{review.note}</p>
            </div>)}
            {!reviews.length && <p className="fg-muted">No human review recorded in Atlas yet.</p>}
        </section>}
        {tab === 'checks' && <section className="fg-panel"><h2>Generalist contract</h2>
            <div className="fg-details"><span>Contract: {manifest?.contract.contract_id ?? '—'}</span><span>Behavior: {manifest?.contract.behavior ?? '—'}</span><span>Observations: {manifest?.contract.observations.size ?? '—'}</span><span>Actions: {manifest?.contract.actions.continuous ?? '—'}</span><span>Contract SHA: {shortHash(manifest?.fingerprints.contract_sha256)}</span><span>Scenario SHA: {shortHash(manifest?.fingerprints.scenario_sha256)}</span></div>
            <h3>Actions</h3>{manifest?.contract.actions.channels.map(channel => <div className="fg-list-row" key={channel.index}><strong>{channel.index}</strong><span>{channel.name}</span><small>{channel.mapping || channel.activation || 'Continuous'}</small></div>)}
            <p className="fg-muted">Manifest inspection verifies metadata structure, not learned policy competence or Unity runtime acceptance.</p>
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
