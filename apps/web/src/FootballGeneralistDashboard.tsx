import type { ReactNode } from 'react';

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
type Drill = { id: string; observation_size: number; continuous_actions: number; behavior: string };
type Evaluation = { policy_id: string; success_rate?: number; episodes?: number; drill?: string };
type Props = {
    policies: Policy[];
    drills: Drill[];
    evaluations: Evaluation[];
    onNavigate: (screen: 'drills' | 'runs' | 'evaluation' | 'viewer' | 'policies') => void;
};

const stages = [
    { id: 'S0', label: 'Movement & contact', purpose: 'Navigate to the ball and make genuine physical contact.', proof: 'Seeded held-out contact rate, physical contact events, watched rollout', visual: 'Waypoint, ball and contact target' },
    { id: 'S1', label: 'Possession & dribbling', purpose: 'Carry the ball, turn and retain control.', proof: 'Controlled distance, duration, route completion and retention', visual: 'Dribble route and directional arrows' },
    { id: 'S2', label: 'Finishing', purpose: 'Choose kick power and angle to score deliberately.', proof: 'Legal kicks, goals, accuracy and no-contact failure accounting', visual: 'Goalposts, goal line and target zone' },
    { id: 'S3', label: 'Passing & receiving', purpose: 'Deliver and control the ball using teammates.', proof: 'Controlled receptions and pass completion across moving starts', visual: 'Receiver, passing lane and interception zone' },
    { id: 'S4', label: 'Football decisions', purpose: 'Choose when to carry, pass or shoot.', proof: 'Held-out choice scenarios against simple action-selection baselines', visual: 'Multiple opportunities and their consequences' },
    { id: 'S5', label: 'Opposition', purpose: 'Adapt control and decisions to defenders.', proof: 'Outcomes against held-out scripted and adaptive opposition', visual: 'Pillar dummies and recognisable defenders' },
] as const;

const roadmap = [
    { id: 'R0', title: 'Audit & preserve', detail: 'Inventory old checkpoints, manifests, dirty Unity assets and Watch limitations.' },
    { id: 'R1', title: 'Canonical agent', detail: 'Freeze one observation/action signature and verify Unity physics and resets.' },
    { id: 'R2', title: 'Shared scenarios', detail: 'Introduce seeded curricula, marked arenas, HUD, walls and training/Watch parity.' },
    { id: 'R3', title: 'Ball mastery', detail: 'Train one generalist on S0/S1 with retention checks.' },
    { id: 'R4', title: 'Kicking & distribution', detail: 'Expand the same policy through S2/S3 while rehearsing prior scenarios.' },
    { id: 'R5', title: 'Decision learning', detail: 'Test football choices in mixed S4 scenarios.' },
    { id: 'R6', title: 'Opposition & evidence', detail: 'Add S5 and validate the complete competence and retention suite.' },
] as const;

// Exact ABI details must ultimately be read from a validated, Unity-exported contract.
// Deliberately do not claim that these candidate values are physically validated.
const candidateObservations = [
    { name: 'Self motion', indices: '0–2', description: 'Local velocity (x,z) and angular velocity' },
    { name: 'Ball', indices: '3–6', description: 'Relative position and locally rotated ball velocity' },
    { name: 'Goals', indices: '7–10', description: 'Own and opponent goal centres; absent values currently zero-filled' },
    { name: 'Pitch boundaries', indices: '11–14', description: 'Local arena boundary distances' },
    { name: 'Kick physics', indices: '15–16', description: 'Fresh contact and legal-kick opportunity' },
    { name: 'Teammates', indices: '17–26', description: 'Two masked player slots (position and velocity)' },
    { name: 'Opponents', indices: '27–36', description: 'Two masked player slots (position and velocity)' },
];
const candidateActions = [
    { name: 'Throttle', range: '−1…1', meaning: 'Forward/reverse motor input' },
    { name: 'Steering', range: '−1…1', meaning: 'Yaw authority through existing motor' },
    { name: 'Kick trigger', range: '−1…1', meaning: 'Attempt kick above the physical threshold' },
    { name: 'Kick power', range: '−1…1', meaning: 'Variable impulse, candidate 4–16' },
    { name: 'Kick angle', range: '−1…1', meaning: 'Candidate aim offset ±20°' },
];
const isGeneralist = (p: Policy) =>
    p.contract_version === 'football-generalist-v1' ||
    p.behavior === 'FootballGeneralistV1';
const isPromoted = (p: Policy) => p.promotion_status === 'validated' || p.promotion_status === 'promoted';

function Tile({ children, label }: { children: ReactNode; label: string }) {
    return <div className="football-generalist-tile"><small>{label}</small><strong>{children}</strong></div>;
}

export function FootballGeneralistDashboard({ policies, drills, evaluations, onNavigate }: Props) {
    const generalist = policies.filter(isGeneralist);
    const verified = generalist.filter(isPromoted);
    const current = [...verified].sort((a, b) => b.indexed_at.localeCompare(a.indexed_at))[0];
    const candidate = [...generalist].sort((a, b) => b.indexed_at.localeCompare(a.indexed_at))[0];
    const evidence = current && evaluations.filter(e => e.policy_id === current.id);
    const legacyCount = policies.length - generalist.length;
    return <section className="football-generalist" aria-label="Generalist programme">
        <section className="football-panel football-generalist-hero">
            <span className="football-kicker">M2 / THE GENERALIST PROGRAMME / FootballPolicy V1</span>
            <div className="football-generalist-hero-grid">
                <div>
                    <h2>One footballer. One policy. An expanding curriculum.</h2>
                    <p>The same agent learns movement, ball control, kicking and football decisions. Every new stage keeps earlier tasks in the training mix. Progress is earned with held-out results and watchable behaviour, not completed training jobs.</p>
                    <p className="football-generalist-state"><strong>{current ? 'Verified generalist checkpoint' : 'Architecture migration · no validated generalist checkpoint'}</strong></p>
                    {current ? <p>Current: <code>{current.id}</code> · from <code>{current.source_run_id}</code></p> :
                        candidate ? <p>Latest unpromoted candidate: <code>{candidate.id}</code>. This is not yet evidence of skill mastery.</p> :
                        <p>Legacy policies remain accessible in Policies and Watch. No specialist checkpoint is counted as generalist competence.</p>}
                </div>
                <div className="football-generalist-metrics">
                    <Tile label="Validated generalist checkpoints">{verified.length}</Tile>
                    <Tile label="Generalist candidates">{generalist.length - verified.length}</Tile>
                    <Tile label="Legacy policies retained">{legacyCount}</Tile>
                    <Tile label="Legacy drill definitions">{drills.length}</Tile>
                </div>
            </div>
            <div className="football-actions">
                <button type="button" className="football-button primary" onClick={() => onNavigate('policies')}>Inspect policy library →</button>
                <button type="button" className="football-button quiet" onClick={() => onNavigate('viewer')}>Watch a policy →</button>
                <button type="button" className="football-button quiet" onClick={() => onNavigate('runs')}>Live runs →</button>
                <button type="button" className="football-button quiet" onClick={() => onNavigate('evaluation')}>Evaluation →</button>
            </div>
            <p className="football-generalist-note">Contract metadata and promotion status are required before the UI can certify a generalist. Historical policies with a matching name alone are not promoted.</p>
        </section>
        <section className="football-panel">
            <span className="football-kicker">RESEARCH ROADMAP</span>
            <h2>Implementation milestones</h2>
            <p className="football-muted">These milestones are planned requirements, not automatically inferred completion statuses. Code and Unity verification must substantiate each gate.</p>
            <div className="football-generalist-roadmap">
                {roadmap.map((item, i) => <article key={item.id} className="football-generalist-roadmap-card">
                    <span className="football-generalist-step">{item.id}</span>
                    <div><strong>{item.title}</strong><p>{item.detail}</p></div>
                    <small>{i <= 1 ? 'Implementation in progress' : 'Planned'}</small>
                </article>)}
            </div>
        </section>
        <section className="football-panel">
            <span className="football-kicker">CURRICULUM DESIGN</span>
            <h2>Skill acquisition and graduation</h2>
            <p>Difficulty changes <strong>within</strong> a stage; task complexity grows <strong>between</strong> stages. We mix previously learned scenarios into later training, then test skill retention before promotion. Nothing in this roadmap counts as graduated until verified.</p>
            <div className="football-generalist-stage-grid">
                {stages.map(stage => <article key={stage.id} className="football-generalist-stage">
                    <span className="football-generalist-step">{stage.id}</span>
                    <div><h3>{stage.label}</h3><p>{stage.purpose}</p><dl><dt>What you should see</dt><dd>{stage.visual}</dd><dt>Required evidence</dt><dd>{stage.proof}</dd></dl></div>
                </article>)}
            </div>
        </section>
        <section className="football-panel">
            <span className="football-kicker">AGENT CONTRACT · CANDIDATE ONLY</span>
            <h2>What the player can observe and do</h2>
            <p>The Unity R1 candidate defines <strong>37 vector observations</strong> and <strong>5 continuous actions</strong>. This is a development reference, <strong>not a validated runtime contract</strong>. Atlas must ultimately import the exact Unity-exported manifest and reject mismatches.</p>
            <div className="football-generalist-contract-grid">
                <div><h3>Observation groups</h3><table><thead><tr><th>Indices</th><th>Signal</th><th>Meaning</th></tr></thead><tbody>
                    {candidateObservations.map(o => <tr key={o.name}><td>{o.indices}</td><td>{o.name}</td><td>{o.description}</td></tr>)}
                </tbody></table></div>
                <div><h3>Action channels</h3><table><thead><tr><th>Action</th><th>Range</th><th>Physical meaning</th></tr></thead><tbody>
                    {candidateActions.map(a => <tr key={a.name}><td>{a.name}</td><td>{a.range}</td><td>{a.meaning}</td></tr>)}
                </tbody></table></div>
            </div>
            <p className="football-generalist-note">Known open gates: goal masks, roster ordering, episode reset sequencing, C# compile and physical actuation. The six-action draft was superseded after inspection of the throttle/steering motor.</p>
        </section>
        <section className="football-panel">
            <span className="football-kicker">PROOF, NOT PROXY METRICS</span>
            <h2>Generalist development evidence</h2>
            {current && evidence && evidence.length > 0 ? <p>There are {evidence.length} recorded evaluation entries for the current checkpoint. Inspect individual runs for seeded scenario comparability and retention evidence before interpreting success rates.</p> :
                <p>No promoted generalist evaluation suite is available yet. Old specialist success rates, PPO rewards and checkpoint counts are not transferable proof of this policy's ability.</p>}
            <p>Required promotion record: versioned checkpoint and scenario, deterministic held-out seeds, measured physical outcomes, simple baselines, a reproducible Watch rollout, and regression checks on older skills.</p>
            <button type="button" className="football-button quiet" onClick={() => onNavigate('evaluation')}>Open measured evaluation history →</button>
        </section>
    </section>;
}
