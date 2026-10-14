import { useEffect, useMemo, useRef, useState } from 'react';
import { callTool } from './api';

export type GeneralistRun = {
    id: string; family: string; state: string; scenario?: string; preset?: string;
    seed?: number; arenas?: number; num_envs?: number; started_at?: string;
    output_dir?: string; binary?: string; contract_sha256?: string;
    scenario_sha256?: string; implementation_sha256?: string;
    checkpoints?: number; checkpoint_files?: string[];
};
export type GeneralistPolicy = {
    id: string; behavior: string; status: string; source: string; compatible_metadata: boolean;
    executable_verified: boolean; view_scenario?: string; onnx_available: boolean; bundle_available: boolean;
    source_run_id?: string | null; contract_sha256?: string; scenario_sha256?: string;
    implementation_sha256?: string;
};
export type GeneralistActivity = {
    ticket: string; action: string; status: string; scenario?: string; policy_id?: string | null;
    started_at?: string; output?: string; error?: string;
    result?: { episodes?: number; outcomes?: Record<string, number>; success_rate?: number | null; run_id?: string };
};
type RunDetail = {
    run: GeneralistRun; ticket: string | null; logs: string; errors: string;
    log_source: string | null; log_note: string; training_status: unknown; training_budget_steps?: number | null;
};
type Episode = Record<string, unknown>;
type EvaluationDetail = {
    operation: GeneralistActivity;
    summary: { total: number; outcomes: Record<string, number>; success_rate: number | null;
        measured_success_episodes: number } | null;
    episodes: Episode[]; pagination: { offset: number; total: number; has_more: boolean };
    note: string;
};
const fmt = (value?: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
const num = (value?: number | null, digits = 1) =>
    typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
const pretty = (value: unknown): string =>
    value == null ? '—' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') :
    typeof value === 'number' ? num(value, 3) : String(value);
const metric = (label: string, value: string) => <div className="fg-detail-metric" key={label}><small>{label}</small><strong>{value}</strong></div>;
const percent = (value?: number | null) => typeof value === 'number' ? num(100 * value) + '%' : 'Not measured';
const samplesFromLog = (text: string) => {
    const samples: Array<{ step: number; reward: number; seconds: number }> = [];
    const pattern = /Step:\s*([\d,]+)[^\n]*?Time Elapsed:\s*([\d,.]+)[^\n]*?Mean Reward:\s*(-?[\d.]+)/g;
    for (const match of text.matchAll(pattern)) {
        const step = Number(match[1].replaceAll(',', ''));
        const seconds = Number(match[2].replaceAll(',', ''));
        const reward = Number(match[3]);
        if (Number.isFinite(step) && Number.isFinite(seconds) && Number.isFinite(reward)) samples.push({ step, seconds, reward });
    }
    return samples;
};
function RewardHistory({ samples }: { samples: ReturnType<typeof samplesFromLog> }) {
    if (samples.length < 2) return <p className="fg-muted">Reward history is only available when saved trainer summary lines contain step and reward measurements.</p>;
    const minimum = Math.min(...samples.map(x => x.reward));
    const maximum = Math.max(...samples.map(x => x.reward));
    const points = samples.map((x, i) => {
        const px = i * 100 / (samples.length - 1);
        const py = 95 - 90 * (x.reward - minimum) / Math.max(0.001, maximum - minimum);
        return String(px) + ',' + String(py);
    }).join(' ');
    return <div className="fg-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Recorded mean training reward history">
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg><div className="fg-details"><span>First {num(samples[0].reward, 3)}</span><span>Latest {num(samples[samples.length - 1].reward, 3)}</span>
        <span>{samples.length} logged samples</span></div></div>;
}
export function GeneralistRunView({ runId, policies, onBack, onPolicy }: {
    runId: string; policies: GeneralistPolicy[]; onBack: () => void; onPolicy: (id: string) => void;
}) {
    const [detail, setDetail] = useState<RunDetail | null>(null);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState('');
    const [section, setSection] = useState<'logs' | 'checkpoints'>('logs');
    const [updated, setUpdated] = useState('');
    const consoleRef = useRef<HTMLPreElement | null>(null);
    useEffect(() => {
        let live = true;
        const poll = () => void callTool<RunDetail>('football_generalist_run_detail', { runId })
            .then(value => { if (live) { setDetail(value); setError(''); setUpdated(new Date().toLocaleTimeString()); } })
            .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
        poll();
        const timer = window.setInterval(poll, 3500);
        return () => { live = false; window.clearInterval(timer); };
    }, [runId]);
    const run = detail?.run;
    const logText = [detail?.logs ?? '', detail?.errors ? '\n[stderr]\n' + detail.errors : ''].join('');
    const samples = useMemo(() => samplesFromLog(logText), [logText]);
    const latest = samples.at(-1);
    const lines = logText.split('\n').filter(line => line.toLowerCase().includes(filter.toLowerCase())).join('\n');
    const linkedPolicies = policies.filter(p => p.source_run_id === runId ||
        (run?.output_dir && p.source.startsWith(run.output_dir + '/')));
    useEffect(() => {
        if (!filter && section === 'logs' && consoleRef.current)
            consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }, [logText, filter, section]);
    return <section className="fg-detail">
        <button className="fg-link" onClick={onBack}>← Training runs</button>
        <div className="fg-detail-heading"><div><p className="fg-eyebrow">TRAINING RUN</p><h2>{runId}</h2></div><span>{run?.state ?? 'Loading'}</span></div>
        {error && <p className="fg-error" role="alert">Could not refresh run detail: {error}. Last available data is retained.</p>}
        {!detail && !error && <p role="status">Loading training diagnostics…</p>}
        {run && <>
            <div className="fg-detail-metrics">
                {metric('Recorded steps', num(latest?.step, 0) + (detail.training_budget_steps ? ' / ' + num(detail.training_budget_steps, 0) : ''))}
                {metric('Latest mean reward', num(latest?.reward, 3))}
                {metric('Training elapsed', latest ? num(latest.seconds) + ' s' : '—')}
                {metric('ONNX checkpoints', num(run.checkpoints, 0))}
            </div>
            {detail.training_budget_steps != null && latest?.step != null && <div className="fg-progress" role="progressbar"
                aria-label="Training step progress" aria-valuemin={0} aria-valuemax={detail.training_budget_steps}
                aria-valuenow={Math.min(latest.step, detail.training_budget_steps)}>
                <div style={{ width: Math.min(100, Math.max(0, latest.step / detail.training_budget_steps * 100)) + '%' }} />
            </div>}
            <div className="fg-detail-columns">
                <section className="fg-panel"><h3>Reward history</h3><RewardHistory samples={samples} />
                    <small className="fg-muted">PPO summary rewards are not evaluation success metrics.</small></section>
                <section className="fg-panel"><h3>Run configuration</h3><dl className="fg-detail-list">
                    <dt>Scenario</dt><dd>{run.scenario ?? '—'}</dd>
                    <dt>Preset</dt><dd>{run.preset ?? '—'}</dd>
                    <dt>Seed</dt><dd>{pretty(run.seed)}</dd>
                    <dt>Environments</dt><dd>{pretty(run.num_envs ?? run.arenas)}</dd>
                    <dt>First recorded</dt><dd>{fmt(run.started_at)}</dd>
                    <dt>Output directory</dt><dd>{run.output_dir ?? '—'}</dd>
                    <dt>Contract hash</dt><dd>{run.contract_sha256 ?? '—'}</dd>
                    <dt>Scenario hash</dt><dd>{run.scenario_sha256 ?? '—'}</dd>
                    <dt>Implementation hash</dt><dd>{run.implementation_sha256 ?? '—'}</dd>
                </dl></section>
            </div>
            <section className="fg-panel">
                <div className="fg-panel-title"><h3>Trainer output</h3><small>{updated ? 'Updated ' + updated + ' · polling every 3.5s' : 'Connecting…'}</small></div>
                <div className="fg-actions">
                    <button className={'fg-button' + (section === 'logs' ? ' primary' : '')} onClick={() => setSection('logs')}>Console</button>
                    <button className={'fg-button' + (section === 'checkpoints' ? ' primary' : '')} onClick={() => setSection('checkpoints')}>Checkpoints ({run.checkpoint_files?.length ?? 0})</button>
                </div>
                {section === 'logs' ? <>
                    <div className="fg-detail-toolbar"><input aria-label="Search run logs" placeholder="Search logs" value={filter} onChange={e => setFilter(e.target.value)}/>
                        <button className="fg-button" onClick={() => void navigator.clipboard?.writeText(logText)}>Copy logs</button></div>
                    <p className="fg-muted">{detail.log_note} {detail.log_source ? 'Source: ' + detail.log_source : ''}</p>
                    <pre className="fg-console" ref={consoleRef} role="log">{lines.trim() || 'No matching captured log lines.'}</pre>
                </> : <div className="fg-stack">{run.checkpoint_files?.map(file => <code className="fg-checkpoint" key={file}>{file}</code>)}
                    {!run.checkpoint_files?.length && <p className="fg-muted">No exported ONNX checkpoints found in this run.</p>}</div>}
            </section>
            <section className="fg-panel"><h3>Indexed policies</h3>
                {linkedPolicies.map(policy => <button type="button" key={policy.id} className="fg-record-link" onClick={() => onPolicy(policy.id)}>{policy.id} →</button>)}
                {!linkedPolicies.length && <p className="fg-muted">No registered policy is explicitly linked to this run.</p>}
            </section>
            {detail.training_status != null && <details className="fg-panel"><summary>Saved trainer status metadata</summary><pre className="fg-output">{JSON.stringify(detail.training_status, null, 2)}</pre></details>}
        </>}
    </section>;
}
export function GeneralistEvaluationView({ ticket, onBack, onPolicy }: {
    ticket: string; onBack: () => void; onPolicy: (id: string) => void;
}) {
    const [detail, setDetail] = useState<EvaluationDetail | null>(null);
    const [error, setError] = useState('');
    const [page, setPage] = useState(0);
    const [filter, setFilter] = useState('');
    useEffect(() => {
        let live = true;
        const poll = () => void callTool<EvaluationDetail>('football_generalist_evaluation_detail', { runId: ticket, offset: page * 100, limit: 100 })
            .then(result => { if (live) { setDetail(result); setError(''); } })
            .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
        poll();
        const timer = window.setInterval(poll, 5000);
        return () => { live = false; window.clearInterval(timer); };
    }, [ticket, page]);
    const d = detail, summary = d?.summary, operation = d?.operation;
    const rows = d?.episodes.filter(e => JSON.stringify(e).toLowerCase().includes(filter.toLowerCase())) ?? [];
    return <section className="fg-detail">
        <button className="fg-link" onClick={onBack}>← Evaluation history</button>
        <div className="fg-detail-heading"><div><p className="fg-eyebrow">POLICY EVALUATION</p><h2>{ticket}</h2></div><span>{operation?.status ?? 'Loading'}</span></div>
        {error && <p className="fg-error" role="alert">Could not fetch evaluation detail: {error}</p>}
        {!d && !error && <p role="status">Loading evaluation results…</p>}
        {d && <>
            <div className="fg-detail-metrics">
                {metric('Episodes recorded', num(summary?.total, 0))}
                {metric('Measured success', percent(summary?.success_rate))}
                {metric('Scenario', operation?.scenario ?? '—')}
                {metric('Status', operation?.status ?? '—')}
            </div>
            {operation?.policy_id && <section className="fg-panel"><h3>Policy</h3>
                <button className="fg-record-link" onClick={() => onPolicy(operation.policy_id!)}>{operation.policy_id} →</button></section>}
            <section className="fg-panel"><h3>Outcome breakdown</h3>
                {Object.entries(summary?.outcomes ?? {}).map(([outcome, count]) => <div className="fg-outcome" key={outcome}>
                    <span>{outcome}</span><div><i style={{ width: String(100 * count / Math.max(1, summary?.total ?? 1)) + '%' }} /></div><strong>{count}</strong>
                </div>)}
                {!Object.keys(summary?.outcomes ?? {}).length && <p className="fg-muted">No measured outcomes are available.</p>}
                <p className="fg-muted">{d.note}</p></section>
            <section className="fg-panel"><div className="fg-panel-title"><h3>Saved episodes</h3><small>{d.pagination.total} total</small></div>
                <input className="fg-detail-search" aria-label="Filter displayed evaluation episodes" placeholder="Filter this page" value={filter} onChange={e => setFilter(e.target.value)}/>
                <div className="fg-episode-list">{rows.map((episode, i) => <details key={String(episode.index ?? (page * 100 + i))} className="fg-episode">
                    <summary><span>#{pretty(episode.index ?? (page * 100 + i))}</span><strong>{pretty(episode.outcome ?? episode.success ?? 'Recorded')}</strong>
                        <span>{pretty(episode.scenario ?? episode.scenario_id)}</span><small>{episode.reward == null ? '' : 'Reward ' + pretty(episode.reward)}</small></summary>
                    <pre className="fg-output">{JSON.stringify(episode, null, 2)}</pre>
                </details>)}</div>
                {!rows.length && <p className="fg-muted">No episodes on this page match the filter.</p>}
                <div className="fg-actions">
                    <button className="fg-button" disabled={page === 0} onClick={() => setPage(x => x - 1)}>← Previous</button>
                    <span>Page {page + 1} / {Math.max(1, Math.ceil(d.pagination.total / 100))}</span>
                    <button className="fg-button" disabled={!d.pagination.has_more} onClick={() => setPage(x => x + 1)}>Next →</button>
                </div>
            </section>
            {(operation?.output || operation?.error) && <details className="fg-panel"><summary>Evaluation console output</summary>
                {operation.output && <pre className="fg-console">{operation.output}</pre>}
                {operation.error && <pre className="fg-console">{operation.error}</pre>}</details>}
        </>}
    </section>;
}
export function GeneralistPolicyView({ policy, runs, activity, onBack, onRun, onEvaluation, onWatch, onEvaluate }: {
    policy: GeneralistPolicy; runs: GeneralistRun[]; activity: GeneralistActivity[];
    onBack: () => void; onRun: (id: string) => void; onEvaluation: (id: string) => void;
    onWatch: (id: string) => void; onEvaluate: (id: string) => void;
}) {
    const linkedRuns = runs.filter(run => policy.source_run_id === run.id ||
        !!(run.output_dir && policy.source.startsWith(run.output_dir + '/')));
    const linkedEvaluations = activity.filter(item => item.policy_id === policy.id && item.action === 'generalist_evaluate');
    const runnable = policy.compatible_metadata && policy.onnx_available && policy.bundle_available;
    return <section className="fg-detail">
        <button className="fg-link" onClick={onBack}>← Policies</button>
        <div className="fg-detail-heading"><div><p className="fg-eyebrow">POLICY PROFILE</p><h2>{policy.id}</h2></div><span>{policy.status}</span></div>
        <div className="fg-detail-metrics">
            {metric('Contract metadata', policy.compatible_metadata ? 'Matching' : 'Incompatible')}
            {metric('ONNX model', policy.onnx_available ? 'Present' : 'Missing')}
            {metric('Unity bundle', policy.bundle_available ? 'Present' : 'Missing')}
            {metric('Saved evaluations', String(linkedEvaluations.length))}
        </div>
        <div className="fg-actions fg-profile-actions">
            <button className="fg-button primary" disabled={!runnable} onClick={() => onWatch(policy.id)}>Watch in Unity →</button>
            <button className="fg-button" disabled={!runnable} onClick={() => onEvaluate(policy.id)}>Evaluate →</button>
        </div>
        {!runnable && <p className="fg-muted">Watch and Evaluate require a compatible indexed model and Unity bundle. The runner performs its own validation before starting.</p>}
        <section className="fg-panel"><h3>Provenance</h3><dl className="fg-detail-list">
            <dt>Behavior</dt><dd>{policy.behavior}</dd>
            <dt>Metadata</dt><dd>{policy.source}</dd>
            <dt>Source run ID</dt><dd>{policy.source_run_id ?? 'Not recorded'}</dd>
            <dt>View scenario</dt><dd>{policy.view_scenario ?? 'Not recorded'}</dd>
            <dt>Contract fingerprint</dt><dd>{policy.contract_sha256 ?? '—'}</dd>
            <dt>Scenario fingerprint</dt><dd>{policy.scenario_sha256 ?? '—'}</dd>
            <dt>Implementation fingerprint</dt><dd>{policy.implementation_sha256 ?? '—'}</dd>
        </dl></section>
        <section className="fg-panel"><h3>Training history</h3>
            {linkedRuns.map(run => <button key={run.id} className="fg-record-link" onClick={() => onRun(run.id)}>
                {run.id} <small>· {run.state}</small> →</button>)}
            {!linkedRuns.length && <p className="fg-muted">No run could be linked from recorded policy provenance.</p>}
        </section>
        <section className="fg-panel"><h3>Evaluation history</h3>
            {linkedEvaluations.map(item => <button key={item.ticket} className="fg-record-link" onClick={() => onEvaluation(item.ticket)}>
                <span>{item.scenario ?? 'Unknown scenario'} · {fmt(item.started_at)}</span>
                <small>{item.result?.episodes != null ? num(item.result.episodes, 0) + ' episodes · ' : ''}{item.result?.success_rate != null ? percent(item.result.success_rate) + ' success · ' : ''}{item.status}</small> →</button>)}
            {!linkedEvaluations.length && <p className="fg-muted">No saved Atlas generalist evaluations are linked to this policy.</p>}
        </section>
    </section>;
}
