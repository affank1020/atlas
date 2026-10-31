import { useEffect, useMemo, useState } from 'react';
import { callTool } from './api';
import { SKILL_GROUPS, skillForScenario, scenarioPurpose } from './football-skill-model';
import type { GeneralistManifest, GeneralistScenario } from './FootballGeneralistDashboard';
import './generalist-drill-catalog.css';
import { SkeletonRows } from './Skeletons';

type LegacyStage = { id: string; title: string; description: string; metric?: string; preset?: string; stage?: number };
type LegacyDrill = {
    id: string; behavior: string; scene: string; observation_size: number; continuous_actions: number;
    primary_metric?: string; objective_status?: string; configs?: Record<string, string>;
    curriculum?: { stages?: LegacyStage[]; variants?: LegacyStage[] };
};

const format = (value: number | undefined, unit = '') => value === undefined ? 'Not specified' : `${value}${unit}`;
const nameOf = (value: string) => value.replaceAll('_', ' ').replaceAll('-', ' ');
const labelled = (name: string, value: string | number | undefined) => value === undefined ? null : { name, value: String(value) };

function Metadata({ items }: { items: ({ name: string; value: string } | null)[] }) {
    return <dl className="fg-drill-facts">{items.filter((item): item is { name: string; value: string } => item !== null).map(item =>
        <div key={item.name}><dt>{item.name}</dt><dd>{item.value}</dd></div>)}</dl>;
}

function ScenarioDetail({ scenario, manifest }: { scenario: GeneralistScenario; manifest: GeneralistManifest }) {
    const guide = manifest.drill_guide?.drills?.[scenario.id];
    const isContact = scenario.objectiveType === 'physical_contact';
    const isDribble = scenario.objectiveType === 'controlled_dribble';
    const objectiveDescription = isContact
        ? 'Physical player–ball contact is the objective; moving near the ball alone is not contact.'
        : isDribble
            ? 'Reach the target while controlling the ball, progressing with separate physical touches and keeping it within the configured limits.'
            : 'See the scenario objective and the configured success metric for this task.';
    return <div className="fg-drill-detail" aria-label={`Details for ${scenario.name}`}>
        <header className="fg-drill-detail-heading"><div><span className="fg-drill-type">STAGE {scenario.stage} · {nameOf(scenario.objectiveType || 'generalist')}</span>
            <h3>{scenario.name}</h3><p>{guide?.summary || scenario.objective}</p></div></header>
        <section><h4>What the agent must do</h4><p>{scenario.objective}</p>
            <p className="fg-muted">{objectiveDescription}</p>
            {guide?.focus && <p><strong>Learning focus:</strong> {guide.focus}</p>}
            {guide?.purpose && <p><strong>Why this drill exists:</strong> {guide.purpose}</p>}
        </section>
        <section><h4>Starting conditions</h4>
            <Metadata items={[
                labelled('Ball spawn distance', `${format(scenario.spawnDistanceMin, '–')}${format(scenario.spawnDistanceMax, ' m')}`),
                labelled('Lateral spawn spread', scenario.lateralSpread === undefined ? undefined : `±${scenario.lateralSpread} m`),
                labelled('Initial heading spread', scenario.headingSpread === undefined ? undefined : `±${scenario.headingSpread}°`),
                labelled('Initial ball speed', scenario.ballSpeed === undefined ? undefined : `${scenario.ballSpeed} m/s`),
                labelled('Target placement', scenario.randomizedDirection ? 'Randomised direction' : 'Configured forward target'),
                labelled('Direction categories', scenario.directionBucketCount),
                scenario.moderateTurnMinDegrees == null ? null : labelled('Turn range', `${scenario.moderateTurnMinDegrees}–${scenario.moderateTurnMaxDegrees}°`),
                labelled('Episode limit', `${scenario.episodeSeconds} s`),
            ]}/>
        </section>
        <section><h4>Success and control constraints</h4>
            <Metadata items={[
                labelled('Task type', nameOf(scenario.objectiveType || 'not specified')),
                labelled('Target representation', nameOf(scenario.targetRepresentation)),
                labelled('Travel to target', scenario.targetForwardMetres === undefined ? undefined : `${scenario.targetForwardMetres} m`),
                labelled('Target radius', scenario.targetRadius === undefined ? undefined : `${scenario.targetRadius} m`),
                labelled('Required controlled progress', scenario.minimumControlledMetres === undefined ? undefined : `${scenario.minimumControlledMetres} m`),
                labelled('Meaningful touches', scenario.minimumMeaningfulTouches),
                labelled('Touch progress spacing', scenario.touchProgressMetres === undefined ? undefined : `${scenario.touchProgressMetres} m`),
                labelled('Max player–ball separation', scenario.maximumBallPlayerDistance === undefined ? undefined : `${scenario.maximumBallPlayerDistance} m`),
                labelled('Control radius', scenario.controlRadius === undefined ? undefined : `${scenario.controlRadius} m`),
                labelled('Max controlled ball speed', scenario.maximumControlledBallSpeed === undefined ? undefined : `${scenario.maximumControlledBallSpeed} m/s`),
            ]}/>
        </section>
        <section><h4>Rewards and incentives</h4>
            <Metadata items={[
                labelled('Success reward', scenario.successReward),
                labelled('Failure reward', scenario.failureReward),
                labelled('Progress reward coefficient', scenario.progressReward),
                labelled('Time penalty coefficient', scenario.timePenalty),
                labelled('Meaningful touch bonus', scenario.touchBonus),
                labelled('Follow-up touch reward', scenario.followupTouchReward),
            ]}/>
            <p className="fg-muted">These values describe training feedback, not actual policy performance. Success must be checked using evaluations.</p>
        </section>
        <section><h4>Technical reference</h4>
            <Metadata items={[
                labelled('Scenario ID', scenario.id),
                labelled('Physics version', manifest.scenarios.physicsVersion),
                labelled('Scene version', manifest.scenarios.sceneVersion),
                labelled('Ball-control mode', manifest.scenarios.ballControlMode),
                labelled('Behaviour', manifest.contract.behavior),
                labelled('Observations', manifest.contract.observations.size),
                labelled('Continuous actions', manifest.contract.actions.continuous),
                labelled('Training mix weight', scenario.weight),
            ]}/>
            <details className="fg-drill-raw"><summary>Full scenario metadata</summary><pre>{JSON.stringify(scenario, null, 2)}</pre></details>
        </section>
    </div>;
}

function LegacyDetail({ drill }: { drill: LegacyDrill }) {
    const stages = [...(drill.curriculum?.stages || []), ...(drill.curriculum?.variants || [])];
    return <div className="fg-drill-detail" aria-label={`Details for ${drill.id}`}>
        <header className="fg-drill-detail-heading"><span className="fg-drill-type">ARCHIVED SPECIALIST</span><h3>{nameOf(drill.id)}</h3>
            <p>{drill.objective_status ? nameOf(drill.objective_status) : 'Legacy specialist Unity drill. Detailed purpose is only available when documented in its registry.'}</p></header>
        <section><h4>Technical reference</h4><Metadata items={[
            labelled('Drill ID', drill.id), labelled('Behaviour', drill.behavior), labelled('Scene', drill.scene),
            labelled('Observations', drill.observation_size), labelled('Continuous actions', drill.continuous_actions),
            labelled('Primary evaluation metric', drill.primary_metric ? nameOf(drill.primary_metric) : undefined),
        ]}/></section>
        {stages.length > 0 && <section><h4>Curriculum and variants</h4>{stages.map(stage =>
            <article className="fg-drill-legacy-stage" key={stage.id}><strong>{stage.title}</strong><p>{stage.description}</p>
                {stage.metric && <small>Measured by: {nameOf(stage.metric)}</small>}</article>)}</section>}
        <section><h4>Training presets</h4>
            <Metadata items={Object.entries(drill.configs || {}).map(([key, value]) => labelled(nameOf(key), value))}/>
            <p className="fg-muted">Archive metadata is not evidence that this drill is part of the current Generalist curriculum.</p></section>
    </div>;
}

export function GeneralistDrillCatalog({ manifest, selected, onSelect, onTrain }: {
    manifest: GeneralistManifest | null; selected: string; onSelect: (id: string) => void; onTrain: (id: string) => void;
}) {
    const [scope, setScope] = useState<'general' | 'legacy'>('general');
    const [legacy, setLegacy] = useState<LegacyDrill[] | null>(null);
    const [legacyError, setLegacyError] = useState('');
    const [search, setSearch] = useState('');
    const [legacySelected, setLegacySelected] = useState('');
    const scenarios = manifest?.scenarios.scenarios || [];
    const activeScenario = scenarios.find(s => s.id === selected) || scenarios[0];
    const activeLegacy = legacy?.find(d => d.id === legacySelected) || legacy?.[0];
    const visible = useMemo(() => scope === 'general'
        ? scenarios.filter(s => `${s.id} ${s.name} ${s.objective} ${manifest?.drill_guide?.drills?.[s.id]?.summary || ''}`.toLowerCase().includes(search.toLowerCase()))
        : (legacy || []).filter(d => `${d.id} ${d.behavior} ${d.primary_metric || ''}`.toLowerCase().includes(search.toLowerCase())), [scope, scenarios, legacy, search, manifest]);
    useEffect(() => {
        if (scope !== 'legacy' || legacy !== null) return;
        let active = true;
        void callTool<LegacyDrill[]>('football_list_drills')
            .then(rows => { if (active) setLegacy(rows); })
            .catch(err => { if (active) setLegacyError(err instanceof Error ? err.message : String(err)); });
        return () => { active = false; };
    }, [scope, legacy]);
    return <section className="fg-panel fg-drills">
        <div className="fg-panel-title"><div><h2>Drill catalogue</h2><p className="fg-muted">Select a drill to read its objective, constraints and training metadata.</p></div><small>{scope === 'general' ? `${scenarios.length} current scenarios` : `${legacy?.length || 0} archived drills`}</small></div>
        <div className="fg-drill-toolbar">
            <div className="fg-drill-scopes" role="group" aria-label="Drill catalogue scope">
                <button className={scope === 'general' ? 'active' : ''} aria-pressed={scope === 'general'} onClick={() => { setScope('general'); setSearch(''); }}>Generalist</button>
                <button className={scope === 'legacy' ? 'active' : ''} aria-pressed={scope === 'legacy'} onClick={() => { setScope('legacy'); setSearch(''); }}>Legacy archive</button>
            </div>
            <input type="search" aria-label="Search drills" value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a drill…"/>
        </div>
        <div className="fg-drill-layout">
            <div className="fg-drill-list" aria-label={scope === 'general' ? 'Generalist drill listings' : 'Legacy drill listings'}>
                {scope === 'general' ? SKILL_GROUPS.map(group => {
                    const members = (visible as GeneralistScenario[]).filter(item => skillForScenario(item) === group.id);
                    if (!members.length) return null;
                    return <section className="fg-catalog-group" key={group.id}>
                        <h3>{group.label}</h3>
                        {members.map(item => <button type="button" key={item.id}
                            className={activeScenario?.id === item.id ? 'selected' : ''}
                            aria-pressed={activeScenario?.id === item.id} onClick={() => onSelect(item.id)}>
                            <span className="fg-drill-list-heading"><strong>{item.name}</strong>
                                <small>{scenarioPurpose(item.id) === 'benchmark-candidate' ? 'Benchmark candidate' : 'Research'}</small></span>
                            <span className="fg-drill-list-summary">{manifest?.drill_guide?.drills?.[item.id]?.summary || item.objective}</span>
                        </button>)}
                    </section>;
                }) : (visible as LegacyDrill[]).map(item =>
                    <button type="button" key={item.id} className={activeLegacy?.id === item.id ? 'selected' : ''}
                        aria-pressed={activeLegacy?.id === item.id} onClick={() => setLegacySelected(item.id)}>
                        <span className="fg-drill-list-heading"><strong>{nameOf(item.id)}</strong><small>Legacy</small></span>
                        <span className="fg-drill-list-summary">{item.behavior}</span>
                    </button>)}
                {scope === 'general' && !manifest && <p className="fg-muted">Connect the Mac Node to load Generalist scenarios.</p>}
                {scope === 'legacy' && legacy === null && !legacyError && <SkeletonRows label="Loading archived drills" variant="run" rows={4} />}
                {legacyError && scope === 'legacy' && <p role="alert">{legacyError}</p>}
                {visible.length === 0 && (scope === 'general' ? !!manifest : !!legacy) && <p className="fg-muted">No drills match the search.</p>}
            </div>
            {scope === 'general' && activeScenario && <div><ScenarioDetail scenario={activeScenario} manifest={manifest!}/>
                <div className="fg-drill-footer"><button className="fg-button primary" onClick={() => onTrain(activeScenario.id)}>Train with this scenario →</button></div>
            </div>}
            {scope === 'legacy' && activeLegacy && <LegacyDetail drill={activeLegacy}/>}
        </div>
    </section>;
}
