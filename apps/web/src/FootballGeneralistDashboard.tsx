export type GeneralistManifest = {
    available: boolean;
    source: string;
    contract: {
        contract_id: string; behavior: string; status?: string;
        observations: { size: number; reference_frame?: string; fields: { name: string; indices: number[] }[] };
        actions: { continuous: number; channels: { index: number; name: string; range: number[]; activation?: string; mapping?: string }[] };
    };
    scenarios: { sceneVersion: string; physicsVersion: string; scenarios: { id: string; name: string; stage: number; objective: string; physicalDifficulty: number; decisionComplexity: number; weight: number; targetRepresentation: string; episodeSeconds: number }[] };
    curriculum: { stages: { id: string; name: string; implemented: boolean }[]; promotion?: { minimum_held_out_episodes: number; minimum_success_rate: number; maximum_retention_drop: number; automatic_promotion_enabled: boolean }; current_checkpoint?: string | null };
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

const isGeneralist = (record: { contract_version?: string }) => record.contract_version === 'football-generalist-v1';
const isPromoted = (policy: Policy) => policy.promotion_status === 'validated' || policy.promotion_status === 'promoted';
const date = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unknown date';
const short = (name: string) => name.replaceAll('_', ' ');

export function FootballGeneralistDashboard({ policies, drills, jobs, evaluations, manifest, manifestError, onNavigate, onOpenRun }: Props) {
    // Fail closed: behavior names and filename patterns alone never prove ABI compatibility.
    const generalist = policies.filter(isGeneralist);
    const verified = generalist.filter(isPromoted);
    const latest = [...verified].sort((a, b) => b.indexed_at.localeCompare(a.indexed_at))[0];
    const pending = [...generalist.filter(p => !isPromoted(p))].sort((a, b) => b.indexed_at.localeCompare(a.indexed_at))[0];
    const activeJobs = jobs.filter(j => j.state === 'running' || j.phase === 'queued');
    const recentJobs = [...jobs].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0,4);
    const recentEvaluations = [...evaluations].slice(-4).reverse();
    const liveScenarios = drills.filter(isGeneralist);
    const legacyPolicyCount = policies.length - generalist.length;

    return <section className="football-lab-home" aria-label="Generalist programme">
        <header className="football-lab-intro">
            <div>
                <span className="football-kicker">FOOTBALL / RESEARCH LAB</span>
                <h2>The generalist</h2>
                <p>One policy learning progressively broader football situations. Training activity is not evidence of ability; capability is demonstrated through comparable evaluations and replay.</p>
            </div>
            <div className="football-lab-status" aria-live="polite">
                <small>Canonical checkpoint</small>
                <strong>{latest ? latest.id : 'Not established'}</strong>
                <span>{latest ? 'Promotion recorded — inspect supporting evaluation' : 'No contract-verified, promoted generalist in the policy index'}</span>
            </div>
        </header>

        <div className="football-lab-primary">
            <section className="football-panel football-lab-research">
                <div className="football-lab-section-heading">
                    <div><span className="football-kicker">CURRENT STATE</span><h3>Evidence before progress</h3></div>
                    <button className="football-button quiet" onClick={() => onNavigate('evaluation')}>Evaluation history →</button>
                </div>
                {latest ?
                    <div className="football-lab-record">
                        <span className="football-lab-record-key">Validated policy</span>
                        <strong>{latest.id}</strong>
                        <small>Source run: {latest.source_run_id} · Indexed {date(latest.indexed_at)}</small>
                        <p>Promotion status is recorded in the policy index. Confirm held-out scenario results and Watch replay before drawing performance conclusions.</p>
                    </div> :
                    <div className="football-lab-empty">
                        <strong>Generalist performance is not yet measurable in Atlas.</strong>
                        <p>There is no promoted policy with an explicit, matching contract version. The existing specialist experiments remain accessible but are not counted as generalist skill mastery.</p>
                        {pending && <p>Most recent unpromoted candidate: <code>{pending.id}</code></p>}
                    </div>
                }
                <div className="football-lab-facts">
                    <div><span>Contract-identified candidates</span><strong>{generalist.length}</strong></div>
                    <div><span>Promoted checkpoints</span><strong>{verified.length}</strong></div>
                    <div><span>Historical specialist policies</span><strong>{legacyPolicyCount}</strong></div>
                </div>
            </section>

            <section className="football-panel football-lab-activity">
                <div className="football-lab-section-heading">
                    <div><span className="football-kicker">OPERATIONS</span><h3>Training activity</h3></div>
                    <button className="football-button quiet" onClick={() => onNavigate('runs')}>All runs →</button>
                </div>
                <p className="football-lab-subtitle">{activeJobs.length} running or queued · {jobs.length} recorded runs</p>
                {recentJobs.length === 0 ? <p className="football-muted">No runs reported by the connected training node.</p> :
                    <div className="football-lab-record-list">
                        {recentJobs.map(job => <button key={job.id} className="football-lab-record-row" onClick={() => onOpenRun(job.id)}>
                            <span><strong>{job.id}</strong><small>{short(job.drill)} · {date(job.started_at)}</small></span>
                            <span className="football-lab-record-state">{job.phase === 'queued' ? 'Queued' : short(job.state)}</span>
                        </button>)}
                    </div>}
                <button className="football-button quiet" onClick={() => onNavigate('viewer')}>Open policy Watch →</button>
            </section>
        </div>

        <div className="football-lab-secondary">
            <section className="football-panel">
                <div className="football-lab-section-heading">
                    <div><span className="football-kicker">SCENARIOS</span><h3>Training contract</h3></div>
                    <button className="football-button quiet" onClick={() => onNavigate('drills')}>Browse drills →</button>
                </div>
                {liveScenarios.length ? <div className="football-lab-record-list">{liveScenarios.map(drill =>
                    <div className="football-lab-contract-row" key={drill.id}>
                        <strong>{short(drill.id)}</strong><small>{drill.observation_size} observations · {drill.continuous_actions} continuous actions</small>
                        <span>{drill.curriculum?.stages?.map(s => s.title).join(' · ') || 'Scenario stage metadata unavailable'}</span>
                    </div>)}</div> :
                    <div className="football-lab-empty">
                        <strong>Generalist scenario contract not connected.</strong>
                        <p>Atlas currently receives the legacy drill registry. It will show generalist scenarios here only when the training node publishes explicit contract-version metadata. No observation list or stage-completion claim is fabricated.</p>
                    </div>}
            </section>
            <section className="football-panel">
                <div className="football-lab-section-heading">
                    <div><span className="football-kicker">MEASUREMENTS</span><h3>Recent evaluations</h3></div>
                    <button className="football-button quiet" onClick={() => onNavigate('evaluation')}>All results →</button>
                </div>
                {recentEvaluations.length ? <div className="football-lab-record-list">{recentEvaluations.map((item, i) =>
                    <div className="football-lab-contract-row" key={item.id || item.policy_id + i}>
                        <strong>{item.policy_id}</strong><small>{item.drill ? short(item.drill) + ' · ' : ''}{item.episodes ?? 'Unknown'} episodes · seed {item.seed ?? 'unknown'}</small>
                        <span>{typeof item.success_rate === 'number' ? (item.success_rate * 100).toFixed(1) + '% measured success' : 'Success rate unavailable'} · {generalist.some(p => p.id === item.policy_id) ? 'Generalist candidate' : 'Historical specialist'}</span>
                    </div>)}</div> :
                    <p className="football-muted">No completed evaluation records available.</p>}
            </section>
        </div>

        <section className="football-panel football-lab-curriculum">
            <div className="football-lab-section-heading">
                <div><span className="football-kicker">CANONICAL UNITY SOURCE</span><h3>Agent interface and curriculum</h3></div>
                {manifest && <small className="football-lab-fingerprint" title={manifest.fingerprints.contract_sha256}>Contract SHA {manifest.fingerprints.contract_sha256.slice(0, 12)}</small>}
            </div>
            {!manifest ? <div className="football-lab-empty">
                <strong>Unity generalist metadata unavailable</strong>
                <p>{manifestError ? 'The Mac Node could not return the current generalist manifest: ' + manifestError : 'The generalist manifest has not been reported by the connected Mac Node.'} Existing runs, evaluation and historical policies remain available.</p>
            </div> : <>
                <div className="football-lab-source-meta">
                    <span><strong>{manifest.contract.contract_id}</strong><small>Policy contract · {manifest.contract.status || 'Status unavailable'}</small></span>
                    <span><strong>{manifest.contract.observations.size}</strong><small>Vector observations</small></span>
                    <span><strong>{manifest.contract.actions.continuous}</strong><small>Continuous actions</small></span>
                    <span><strong>{manifest.scenarios.scenarios.length}</strong><small>Defined scenarios</small></span>
                </div>
                <div className="football-lab-interfaces">
                    <div>
                        <h4>Observations</h4>
                        <p className="football-muted">{manifest.contract.observations.reference_frame || 'Reference frame unavailable'}</p>
                        <div className="football-lab-contract-table">
                            {manifest.contract.observations.fields.map(f => <div key={f.name}><code>{f.indices.length > 1 ? f.indices[0] + '–' + f.indices[f.indices.length - 1] : f.indices[0]}</code><span>{f.name.replaceAll('.', ' / ').replaceAll('_', ' ')}</span></div>)}
                        </div>
                    </div>
                    <div>
                        <h4>Actions</h4>
                        <div className="football-lab-contract-table">
                            {manifest.contract.actions.channels.map(c => <div key={c.index}><code>{c.index}</code><span><strong>{c.name.replaceAll('_',' ')}</strong><small>{c.range.join(' to ')}{c.mapping ? ' · ' + c.mapping : ''}{c.activation ? ' · ' + c.activation : ''}</small></span></div>)}
                        </div>
                    </div>
                </div>
                <div className="football-lab-curriculum">
                    <h4>Curriculum</h4>
                    <div className="football-lab-curriculum-list">{manifest.curriculum.stages.map(stage => <div key={stage.id}>
                        <code>{stage.id}</code><strong>{stage.name}</strong><small>{stage.implemented ? 'Implemented in Unity · not graduated' : 'Planned'}</small>
                    </div>)}</div>
                    <p className="football-muted">Current checkpoint: {manifest.curriculum.current_checkpoint || 'None recorded'} · Automatic promotion: {manifest.curriculum.promotion?.automatic_promotion_enabled ? 'enabled' : 'disabled'}. Implemented does not mean learned.</p>
                    <h4>Defined training scenarios</h4>
                    <div className="football-lab-scenarios">{manifest.scenarios.scenarios.map(s => <article key={s.id}>
                        <span className="football-kicker">{manifest.curriculum.stages.find(k => k.id === 'S' + s.stage)?.name || 'Stage ' + s.stage}</span>
                        <strong>{s.name}</strong><p>{s.objective}</p>
                        <small>Difficulty {s.physicalDifficulty} · decision complexity {s.decisionComplexity} · mixture weight {(s.weight * 100).toFixed(0)}% · {s.episodeSeconds}s limit</small>
                    </article>)}</div>
                </div>
                <p className="football-lab-manifest-note">Source: {manifest.source} · Scene {manifest.scenarios.sceneVersion} · Physics {manifest.scenarios.physicsVersion}. Source-file fingerprints are for inspection; they do not certify a compiled runner or policy competence.</p>
            </>}
        </section>
        <footer className="football-lab-footer">
            <strong>Architecture migration</strong>
            <p>The M2 programme is moving to a single shared policy and curriculum. This workspace reports what the connected services actually know; the detailed roadmap and observation/action definitions must arrive through a versioned Unity contract before being represented as live state.</p>
            <button className="football-button quiet" onClick={() => onNavigate('policies')}>Inspect historical policies →</button>
        </footer>
    </section>;
}
