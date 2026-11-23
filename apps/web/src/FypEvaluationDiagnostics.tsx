import { useEffect, useMemo, useState } from 'react';
import { callTool } from './api';
import './FypEvaluationDiagnostics.css';

type Summary = { session_id: string; episode: number; outcome: string; elapsed_seconds: number; player_distance_metres: number;
    absolute_turn_degrees: number; final_ball_distance_metres: number; touch_attempts: number; touch_results: Record<string, number> };
export type BehaviourDiagnostics = { state: string; reason?: string; sha256?: string; bytes?: number; episodes?: Summary[]; sampling?: string; limitations?: string };
export type EvaluationDiagnostics = BehaviourDiagnostics;
type Vec = { x: number; y: number; z: number };
type State = { elapsed_seconds: number; physics_step: number; player_position: Vec; ball_position: Vec; player_velocity: Vec; ball_velocity: Vec;
    yaw_degrees: number; yaw_rate_radians: number; ball_angular_velocity: Vec; movement: {x:number;y:number}; obstructed: boolean; absolute_turn_degrees: number; desired_facing: Vec; desired_facing_active: boolean; can_touch: boolean; cooldown_seconds: number };
type Action = { elapsed_seconds: number; values: number[] };
type Touch = { elapsed_seconds: number; result: string; power: number; touch_direction: {x:number;y:number}; impulse: Vec };
type Detail = { trace?: { states: State[]; actions: Action[]; touches: Touch[];
    counts: { states: number; actions: number; touches: number; observations: number }; display_limit: number;
    observation?: { elapsed_seconds: number; values: number[] } | null; observation_index: number };
    observation_channels: { name: string; start: number; size: number; encoding?: string }[];
    model_sha256?: string; evaluation_source_sha256?: string; source_sha256?: string };
const fmt = (value: number | undefined, digits = 1) => value != null && Number.isFinite(value) ? value.toFixed(digits) : '—';
const vector = (v: Vec | undefined) => v ? [v.x,v.y,v.z].map(n => fmt(n,2)).join(', ') : '—';
const speed = (v: Vec | undefined) => v ? Math.hypot(v.x,v.y,v.z) : undefined;
const title = (value: string) => value.replaceAll('_', ' ');
const colors = ['#6eb5ff', '#ffbe70', '#bd9cff', '#70dfbf'];

export function FypEvaluationDiagnostics({ evaluationId, policyId, diagnostics }: {
    evaluationId: string; policyId?: string; diagnostics?: EvaluationDiagnostics;
}) {
    return <FypBehaviourDiagnostics kind="evaluation" id={evaluationId} policyId={policyId} diagnostics={diagnostics} />;
}

export function FypBehaviourDiagnostics({ kind, id, policyId, diagnostics }: {
    kind: 'training' | 'evaluation'; id: string; policyId?: string; diagnostics?: BehaviourDiagnostics;
}) {
    const [episode, setEpisode] = useState(() => Math.max(0, diagnostics?.episodes?.findIndex(e => e.outcome !== 'Goal scored') ?? 0));
    const [observation, setObservation] = useState(0);
    const [frame, setFrame] = useState(0);
    const [order, setOrder] = useState('failures');
    const [group, setGroup] = useState(kind === 'training' ? 'movement' : 'facing');
    const [data, setData] = useState<Detail | null>(null);
    const [error, setError] = useState('');
    const [retry, setRetry] = useState(0);
    const episodes = diagnostics?.episodes ?? [];
    const label = kind === 'training' ? 'Training diagnostics' : 'Evaluation diagnostics';
    const activity = kind === 'training' ? 'this training run' : 'this evaluation';
    useEffect(() => {
        if (diagnostics?.state !== 'complete') return;
        const controller = new AbortController();
        setError('');
        const source = kind === 'training' ? { runId: id } : { evaluationId: id };
        void callTool<Detail>(`football_fyp_${kind}_diagnostics`, {
            ...source, policyId, replayEpisode: episode, offset: observation,
        }, controller.signal).then(result => {
            if (!result.trace) throw new Error('The recorded episode trace is unavailable.');
            if (!controller.signal.aborted) setData(result);
        })
            .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
        return () => controller.abort();
    }, [kind, id, policyId, diagnostics?.state, diagnostics?.sha256, episode, observation, retry]);
    const ordered = useMemo(() => episodes.map((item, index) => ({ ...item, index })).sort((a, b) =>
        order === 'turning' ? b.absolute_turn_degrees - a.absolute_turn_degrees : order === 'episode' ? a.index - b.index :
            order === 'movement' ? a.player_distance_metres - b.player_distance_metres :
            Number(a.outcome === 'Goal scored') - Number(b.outcome === 'Goal scored') || a.index - b.index), [episodes, order]);
    if (diagnostics?.state !== 'complete') return <section className="fyp-diagnostics" aria-label={label}>
        <h3>Behaviour diagnostics</h3><p className="fg-muted">{diagnostics?.state === 'pending' ? `Episode traces will be available when ${activity} finishes.` :
            diagnostics?.state === 'disabled' ? `Diagnostic recording was disabled for ${activity}.` :
            diagnostics?.state === 'incomplete' ? 'Diagnostic recording is incomplete.' : `No diagnostic trace was recorded for ${activity}.`}</p>
        {diagnostics?.reason && <p className="fg-muted">{diagnostics.reason}</p>}
    </section>;
    const selected = episodes[episode];
    const trace = data?.trace;
    const state = trace?.states[Math.min(frame, Math.max(0, trace.states.length - 1))];
    const mean = (key: 'absolute_turn_degrees' | 'player_distance_metres', subset: Summary[]) => subset.length
        ? fmt(subset.reduce((sum, item) => sum + item[key], 0) / subset.length) : '—';
    const successes = episodes.filter(e => e.outcome === 'Goal scored'), failures = episodes.filter(e => e.outcome !== 'Goal scored');
    const channels = group === 'movement' ? [0, 1] : group === 'facing' ? [2, 3] : group === 'direction' ? [4, 5] : [6, 7];
    const actionNames = ['Strafe', 'Forward / back', 'Desired facing X', 'Desired facing Z', 'Touch direction X', 'Touch direction Z', 'Touch power (raw)', 'Touch trigger (raw)'];
    return <section className="fyp-diagnostics" aria-label={label}>
        <div className="fyp-diagnostic-heading"><div><span className="fyp-diagnostic-eyebrow">BEHAVIOUR</span><h3>What happened during {kind}</h3></div>
            <span className="fyp-diagnostic-badge">{episodes.length} {kind === 'training' ? 'episodes sampled' : 'episodes recorded'}</span></div>
        <div className="fyp-diagnostic-comparison">
            {[{ label: 'Scoring episodes', items: successes }, { label: 'Other outcomes', items: failures }].map(({ label, items }) =>
                <div key={label}><strong>{items.length} <small>{label}</small></strong><span>Mean movement <b>{mean('player_distance_metres', items)} m</b></span>
                    <span>Mean total turning <b>{mean('absolute_turn_degrees', items)}°</b></span></div>)}
        </div>
        <div className="fyp-diagnostic-heading"><h4>Explore episodes</h4><label>Sort <select aria-label="Sort diagnostic episodes" value={order} onChange={e => setOrder(e.target.value)}>
            <option value="failures">Failures first</option><option value="turning">Most turning</option><option value="movement">Least movement</option>
            <option value="episode">Episode order</option></select></label></div>
        <div className="fyp-diagnostic-table-wrap"><table className="fyp-diagnostic-table"><thead><tr><th>Episode</th><th>Outcome</th><th>Time</th><th>Movement</th><th>Total turning</th><th>Touches / attempts</th></tr></thead>
            <tbody>{ordered.map(e => <tr key={`${e.session_id}:${e.episode}`} aria-selected={e.index === episode}><td><button type="button" aria-pressed={e.index === episode} onClick={() => {
                if (e.index !== episode) { setData(null); setEpisode(e.index); setObservation(0); setFrame(0); }
            }}>Episode {e.episode}</button></td><td>{e.outcome}</td><td>{fmt(e.elapsed_seconds)}s</td><td>{fmt(e.player_distance_metres, 2)} m</td>
                <td>{fmt(e.absolute_turn_degrees, 0)}°</td><td>{e.touch_results.applied ?? 0} / {e.touch_attempts}</td></tr>)}</tbody></table></div>
        {selected && <div className="fyp-diagnostic-episode"><h4>Episode {selected.episode} <span>{selected.outcome} · {fmt(selected.elapsed_seconds)}s</span></h4>
            {error ? <div role="alert"><p className="fg-error">{error}</p><button type="button" className="fg-button" onClick={() => setRetry(retry + 1)}>Retry diagnostics</button></div> : !trace ?
                <p role="status" className="fg-muted">Loading verified episode trace…</p> : <>
                <div className="fyp-diagnostic-visuals"><div className="fyp-diagnostic-panel"><h5>Player and ball path</h5>
                    <Trajectory states={trace.states} frame={frame} />
                    <div className="fyp-diagnostic-legend"><span style={{ color: colors[0] }}>● Player / facing</span><span style={{ color: colors[1] }}>● Ball</span><span style={{ color: colors[3] }}>↗ Desired facing</span></div>
                    <label className="fyp-diagnostic-scrubber">Time {fmt(state?.elapsed_seconds, 2)}s<input aria-label="Episode timeline" type="range" min={0} max={Math.max(0, trace.states.length - 1)} value={Math.min(frame, Math.max(0, trace.states.length-1))} onChange={e => setFrame(Number(e.target.value))} /></label>
                    {state && <p className="fg-muted">Yaw {fmt(state.yaw_degrees, 0)}° · Contact {state.obstructed ? 'blocked' : state.can_touch ? 'reachable' : 'out of reach'} · Cooldown {fmt(state.cooldown_seconds, 2)}s</p>}
                    {state && <details className="fyp-diagnostic-state"><summary>Physical state at this time</summary>
                        <dl><dt>Player position · m</dt><dd>{vector(state.player_position)}</dd><dt>Player velocity · m/s</dt><dd>{vector(state.player_velocity)} · speed {fmt(speed(state.player_velocity),2)}</dd>
                        <dt>Ball position · m</dt><dd>{vector(state.ball_position)}</dd><dt>Ball velocity · m/s</dt><dd>{vector(state.ball_velocity)} · speed {fmt(speed(state.ball_velocity),2)}</dd>
                        <dt>Ball spin · rad/s</dt><dd>{vector(state.ball_angular_velocity)}</dd><dt>Yaw rate · °/s</dt><dd>{fmt(state.yaw_rate_radians * 180/Math.PI)}</dd>
                        <dt>Desired facing · world X/Y/Z</dt><dd>{state.desired_facing_active ? vector(state.desired_facing) : 'Inactive'}</dd>
                        <dt>Applied movement · local X/Z</dt><dd>{state.movement ? `${fmt(state.movement.x,2)}, ${fmt(state.movement.y,2)}` : '—'}</dd></dl></details>}
                </div><div className="fyp-diagnostic-panel"><h5>Total turning over time</h5><Turning states={trace.states} />
                    <p className="fg-muted">Cumulative absolute yaw change. Turning back and forth adds to the total.</p>
                    <h5>Horizontal player speed</h5><PlayerSpeed states={trace.states} />
                    <h5>Policy actions</h5><select aria-label="Action channels" value={group} onChange={e => setGroup(e.target.value)}>
                        <option value="movement">Movement</option><option value="facing">Desired facing</option><option value="direction">Touch direction</option><option value="power">Power and trigger</option></select>
                    <Series times={trace.actions.map(a => a.elapsed_seconds)} series={channels.map(c => ({ name: actionNames[c], values: trace.actions.map(a => a.values[c]) }))} domain={[-1,1]} />
                    <div className="fyp-diagnostic-legend">{channels.map((c, i) => <span key={c} style={{ color: colors[i] }}>{actionNames[c]}</span>)}</div>
                </div></div>
                <div className="fyp-diagnostic-heading"><h5>Touch events</h5><span>{selected.touch_results.applied ?? 0} applied · {selected.touch_attempts - (selected.touch_results.applied ?? 0)} rejected</span></div>
                <div className="fyp-diagnostic-table-wrap events"><table className="fyp-diagnostic-table"><thead><tr><th>Time</th><th>Result</th><th>Power</th><th>Local direction (X, Z)</th><th>Impulse (X, Y, Z)</th></tr></thead>
                    <tbody>{trace.touches.map((t,i) => <tr key={i}><td>{fmt(t.elapsed_seconds, 2)}s</td><td>{title(t.result)}</td><td>{fmt(t.power,2)}</td><td>{fmt(t.touch_direction?.x,2)}, {fmt(t.touch_direction?.y,2)}</td><td>{vector(t.impulse)} N·s</td></tr>)}</tbody></table>
                    {!trace.touches.length && <p className="fg-muted">No touch attempts.</p>}</div>
                <details className="fyp-diagnostic-observations"><summary>Policy observations <span>{trace.counts.observations} samples</span></summary>
                    {trace.counts.observations ? <><label>Observation sample <input aria-label="Observation sample" type="number" min={0} max={trace.counts.observations-1} value={observation}
                        onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n < trace.counts.observations) setObservation(n); }} /></label>
                        <p className="fg-muted">Sample {trace.observation_index} · {fmt(trace.observation?.elapsed_seconds,2)}s · values in policy order and scaling.</p>
                        <div className="fyp-diagnostic-table-wrap"><table className="fyp-diagnostic-table"><thead><tr><th>Channels</th><th>Input</th><th>Values</th></tr></thead><tbody>
                            {data?.observation_channels.map(c => <tr key={c.start}><td>{c.start}–{c.start+c.size-1}</td><td title={c.encoding}>{title(c.name)}</td>
                                <td>{trace.observation?.values.slice(c.start,c.start+c.size).map(v => fmt(v,3)).join(', ')}</td></tr>)}</tbody></table></div></> : <p className="fg-muted">Observation vectors were not recorded for this policy.</p>}
                </details>
                <p className="fg-muted fyp-diagnostic-note">Sampled trajectories, not a physics replay. Each display series shows up to {trace.display_limit} evenly spaced records; the raw artifact retains all records.
                    {' '}This episode contains {trace.counts.states} state, {trace.counts.actions} action and {trace.counts.touches} touch records.</p>
                <details className="fyp-diagnostic-provenance"><summary>Recording details</summary><p>{diagnostics.sampling}</p><p>{diagnostics.limitations}</p>
                    <p>Trace SHA-256 <code>{diagnostics.sha256}</code></p>
                    {kind === 'evaluation' && <p>Model SHA-256 <code>{data?.model_sha256}</code></p>}
                    <p>{kind === 'training' ? 'Training' : 'Evaluation'} source SHA-256 <code>{data?.source_sha256 ?? data?.evaluation_source_sha256}</code></p></details>
            </>}
        </div>}
    </section>;
}

function Trajectory({ states, frame }: { states: State[]; frame: number }) {
    if (!states.length) return null;
    const positions = states.flatMap(s => [s.player_position, s.ball_position]);
    const minX = Math.min(...positions.map(p=>p.x)), maxX = Math.max(...positions.map(p=>p.x));
    const minZ = Math.min(...positions.map(p=>p.z)), maxZ = Math.max(...positions.map(p=>p.z));
    const scale = Math.min(300 / Math.max(maxX-minX, 2), 200 / Math.max(maxZ-minZ, 2));
    const x = (p: Vec) => 180+(p.x-(minX+maxX)/2)*scale, y=(p: Vec)=>120-(p.z-(minZ+maxZ)/2)*scale;
    const state = states[Math.min(frame, states.length-1)];
    const px=x(state.player_position), py=y(state.player_position), yaw=state.yaw_degrees*Math.PI/180;
    return <svg className="fyp-diagnostic-path" viewBox="0 0 360 250" role="img" aria-label="Player and ball trajectories in world X and Z coordinates">
        <rect x="8" y="8" width="344" height="224" rx="10" fill="none" stroke="currentColor" opacity=".15" />
        {[['player_position', colors[0]], ['ball_position', colors[1]]].map(([key,color]) => <polyline key={key} points={states.map(s=>`${x(s[key as 'player_position'])},${y(s[key as 'player_position'])}`).join(' ')} fill="none" stroke={color} strokeWidth="2" opacity=".6" />)}
        <circle cx={px} cy={py} r="5" fill={colors[0]} /><line x1={px} y1={py} x2={px+18*Math.sin(yaw)} y2={py-18*Math.cos(yaw)} stroke={colors[0]} strokeWidth="3" />
        {state.desired_facing_active && <line x1={px} y1={py} x2={px+26*state.desired_facing.x} y2={py-26*state.desired_facing.z} stroke={colors[3]} strokeWidth="2" strokeDasharray="3 2" />}
        <circle cx={x(state.ball_position)} cy={y(state.ball_position)} r="4" fill={colors[1]} />
        <text x="16" y="245" fill="currentColor" fontSize="10">World X → · Z ↑ · {fmt(100/scale)} m per 100 px</text>
    </svg>;
}
function Turning({ states }: { states: State[] }) {
    const values = states.map(s => s.absolute_turn_degrees);
    return <Series times={states.map(s=>s.elapsed_seconds)} series={[{name:'Total turning (degrees)',values}]} domain={[0, Math.max(1,...values)]} />;
}
function PlayerSpeed({ states }: { states: State[] }) {
    const values = states.map(s => Math.hypot(s.player_velocity?.x ?? 0, s.player_velocity?.z ?? 0));
    return <Series times={states.map(s => s.elapsed_seconds)} series={[{name:'Horizontal player speed (m/s)', values}]} domain={[0, Math.max(1, ...values)]} />;
}
function Series({ times, series, domain }: { times: number[]; series: {name:string;values:number[]}[]; domain:[number,number] }) {
    const [low,high]=domain, duration=Math.max(.01,...times);
    return <svg className="fyp-diagnostic-chart" viewBox="0 0 360 135" role="img" aria-label={series.map(s=>s.name).join(', ')}>
        {[low,(low+high)/2,high].map(v=><g key={v}><line x1="36" x2="350" y1={105-(v-low)*94/(high-low)} y2={105-(v-low)*94/(high-low)} stroke="currentColor" opacity=".12"/><text x="31" y={109-(v-low)*94/(high-low)} textAnchor="end" fill="currentColor" fontSize="9">{fmt(v,0)}</text></g>)}
        {series.map((s,j)=><polyline key={s.name} points={s.values.map((v,i)=>`${36+times[i]*314/duration},${105-(v-low)*94/(high-low)}`).join(' ')} fill="none" stroke={colors[j]} strokeWidth="1.6"/>)}
        <text x="36" y="126" fill="currentColor" fontSize="10">0s</text><text x="350" y="126" textAnchor="end" fill="currentColor" fontSize="10">{fmt(duration,2)}s</text>
    </svg>;
}
