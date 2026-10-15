export type GeneralistScenario = {
    id: string; name: string; stage: number; objective: string; objectiveType?: string;
    physicalDifficulty: number; decisionComplexity: number; weight: number; targetRepresentation: string;
    episodeSeconds: number; spawnDistanceMin?: number; spawnDistanceMax?: number;
    lateralSpread?: number; headingSpread?: number; ballSpeed?: number;
    targetForwardMetres?: number; targetRadius?: number; minimumControlledMetres?: number;
    minimumMeaningfulTouches?: number; touchProgressMetres?: number; maximumBallPlayerDistance?: number;
    controlRadius?: number; maximumControlledBallSpeed?: number; randomizedDirection?: boolean;
    directionBucketCount?: number; moderateTurnMinDegrees?: number; moderateTurnMaxDegrees?: number;
    successReward?: number; failureReward?: number; progressReward?: number; timePenalty?: number;
    touchBonus?: number; followupTouchReward?: number;
};
export type GeneralistManifest = {
    available: boolean;
    source: string;
    contract: {
        contract_id: string; behavior: string; status?: string;
        observations: { size: number; reference_frame?: string; fields: { name: string; indices: number[] }[] };
        actions: { continuous: number; channels: { index: number; name: string; range: number[]; activation?: string; mapping?: string }[] };
    };
    scenarios: { sceneVersion: string; physicsVersion: string; ballControlMode?: string; scenarios: GeneralistScenario[] };
    drill_guide?: { schemaVersion: number; drills: Record<string, { summary: string; focus: string; purpose: string }> };
    curriculum: { held_out_seeds?: number[]; stages: { id: string; name: string; implemented: boolean }[]; promotion?: { minimum_held_out_episodes: number; minimum_success_rate: number; maximum_retention_drop: number; automatic_promotion_enabled: boolean }; current_checkpoint?: string | null };
    fingerprints: { contract_sha256: string; scenario_sha256: string; curriculum_sha256: string };
    provenance: string;
};
type Policy = {
    id: string;
    drill: string;
    source_run_id: string;
    indexed_at: string;
    behavior?: string;
    contract_version?: string;
    family?: string;
    contract_sha256?: string;
    scenario_sha256?: string;
    promotion_status?: string;
    evaluation?: string;
};
type Drill = {
    id: string;
    behavior: string;
    scene: string;
    observation_size: number;
    continuous_actions: number;
    contract_version?: string;
    curriculum?: { stages?: Array<{ id: string; title: string; description: string; metric: string }> };
};
type Job = { id: string; drill: string; state: string; started_at: string; phase?: string; health?: { steps?: number; average_steps_per_second?: number } };
type Evaluation = { id?: string; policy_id: string; success_rate?: number; episodes?: number; drill?: string; seed?: number };
type Props = {
    policies: Policy[];
    drills: Drill[];
    jobs: Job[];
    evaluations: Evaluation[];
    manifest?: GeneralistManifest | null;
    manifestError?: string;
    onNavigate: (screen: 'drills' | 'runs' | 'evaluation' | 'viewer' | 'policies') => void;
    onOpenRun: (id: string) => void;
};

const isGeneralist = (p: Policy) => p.family === 'generalist' && p.contract_version === 'football-generalist-v2';
const validPolicy = (p: Policy, manifest?: GeneralistManifest | null) =>
    !!manifest && isGeneralist(p) &&
    (p.promotion_status === 'validated' || p.promotion_status === 'promoted') &&
    p.contract_sha256 === manifest.fingerprints.contract_sha256 &&
    p.scenario_sha256 === manifest.fingerprints.scenario_sha256;
const pretty = (s: string) => s.replaceAll('_', ' ');
const compactDate = (s?: string) => s && !Number.isNaN(Date.parse(s)) ? new Date(s).toLocaleDateString() : '—';

export function FootballGeneralistDashboard({ policies, jobs, evaluations, manifest, manifestError, onNavigate, onOpenRun }: Props) {
    const verified = policies.filter(p => validPolicy(p, manifest));
    const current = [...verified].sort((a, b) => b.indexed_at.localeCompare(a.indexed_at))[0];
    const active = jobs.filter(j => j.state === 'running' || j.phase === 'queued');
    const recent = [...jobs].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0,6);
    const generalist = policies.filter(isGeneralist);
    const scenarios = manifest?.scenarios.scenarios ?? [];
    const stages = manifest?.curriculum.stages ?? [];

    return <section className="football-simple" aria-label="Generalist programme">
        <div className="football-simple-top">
            <div><span className="football-kicker">GENERALIST</span><h2>Training</h2></div>
            <div className="football-simple-status">{current ? 'CHECKPOINT READY' : 'NO VERIFIED CHECKPOINT'}</div>
        </div>
        <div className="football-simple-strip">
            <div><small>ACTIVE JOBS</small><strong>{active.length}</strong></div>
            <div><small>POLICIES</small><strong>{generalist.length}</strong></div>
            <div><small>VERIFIED</small><strong>{verified.length}</strong></div>
            <div><small>SCENARIOS</small><strong>{manifest ? scenarios.length : '—'}</strong></div>
        </div>

        <div className="football-simple-columns">
            <section className="football-panel football-simple-block">
                <div className="football-simple-heading"><h3>Runs</h3><button onClick={() => onNavigate('runs')}>VIEW ALL →</button></div>
                {recent.length === 0 ? <p className="football-simple-empty">No runs</p> : <div className="football-simple-rows">
                    {recent.map(j => <button key={j.id} className="football-simple-run" onClick={() => onOpenRun(j.id)}>
                        <span className="football-simple-run-name"><strong>{j.id}</strong><small>{pretty(j.drill)}</small></span>
                        <span className="football-simple-run-state">{j.phase === 'queued' ? 'queued' : pretty(j.state)}</span>
                        <small>{compactDate(j.started_at)}</small>
                    </button>)}
                </div>}
                <div className="football-simple-footer-actions">
                    <button onClick={() => onNavigate('viewer')}>WATCH</button>
                    <button onClick={() => onNavigate('evaluation')}>EVALUATE</button>
                </div>
            </section>

            <section className="football-panel football-simple-block">
                <div className="football-simple-heading"><h3>Curriculum</h3><span>{stages.filter(s => s.implemented).length}/{stages.length || '—'} BUILT</span></div>
                {!manifest ? <p className="football-simple-empty" title={manifestError}>Node metadata unavailable</p> :
                    <div className="football-simple-rows">{stages.map(stage => <div key={stage.id} className="football-simple-stage">
                        <span className="football-simple-level">{stage.id}</span>
                        <span>{stage.name}</span>
                        <small>{stage.implemented ? 'BUILT' : 'PLANNED'}</small>
                    </div>)}</div>}
                {manifest && <div className="football-simple-scenarios">
                    <strong>SCENARIOS</strong>
                    {scenarios.map(s => <div key={s.id} className="football-simple-scenario">
                        <span><b>{s.name}</b><small>{s.id}</small></span>
                        <span>{Math.round(s.weight * 100)}% MIX</span>
                    </div>)}
                </div>}
            </section>
        </div>

        <section className="football-panel football-simple-block">
            <div className="football-simple-heading"><h3>Agent</h3><span>{manifest?.contract.contract_id ?? 'NOT CONNECTED'}</span></div>
            {!manifest ? <p className="football-simple-empty" title={manifestError}>Contract unavailable</p> : <>
                <div className="football-simple-spec">
                    <div><small>OBSERVATIONS</small><strong>{manifest.contract.observations.size}</strong></div>
                    <div><small>ACTIONS</small><strong>{manifest.contract.actions.continuous}</strong></div>
                    <div><small>BEHAVIOUR</small><strong>{manifest.contract.behavior}</strong></div>
                    <div><small>VERSION</small><strong>{manifest.contract.status ?? '—'}</strong></div>
                </div>
                <details className="football-simple-details">
                    <summary>Observation / action breakdown</summary>
                    <div className="football-simple-details-columns">
                        <div><h4>Observations</h4>{manifest.contract.observations.fields.map(f =>
                            <div key={f.name}><code>{f.indices.join('–')}</code><span>{pretty(f.name)}</span></div>)}</div>
                        <div><h4>Actions</h4>{manifest.contract.actions.channels.map(c =>
                            <div key={c.index}><code>{c.index}</code><span>{pretty(c.name)} <small>{c.range.join(' / ')} {c.mapping || ''}</small></span></div>)}</div>
                    </div>
                </details>
            </>}
        </section>

        <div className="football-simple-bottom">
            <span>CHECKPOINT: {current?.id || manifest?.curriculum.current_checkpoint || 'NONE'}</span>
            <span>LAST EVALUATIONS: {evaluations.length}</span>
            <button onClick={() => onNavigate('policies')}>POLICY LIBRARY →</button>
        </div>
    </section>;
}
