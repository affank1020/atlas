import { ASSESSMENT_SUITE, type PolicyAssessment } from './football-skill-model';

export function FootballPolicySkills({ assessment, onEvaluate }: {
    assessment?: PolicyAssessment;
    onEvaluate?: (scenario: string) => void;
}) {
    const scores = ASSESSMENT_SUITE.benchmarks.map(benchmark =>
        assessment?.benchmarks.find(x => x.id === benchmark.id));
    return <section className="fg-panel fg-skill-assessment" aria-label="Skill assessment">
        <div className="fg-panel-title">
            <div><h3>Skill assessment</h3>
                <p className="fg-muted">{ASSESSMENT_SUITE.label} · historical evaluation evidence</p></div>
            <span>Provisional</span>
        </div>
        <p className="fg-muted">Measured success on each specific drill, not an overall player rating. Previously used seeds are not certified holdouts; benchmarks with different success rules are not interchangeable.</p>
        <div className="fg-skill-list">{ASSESSMENT_SUITE.benchmarks.map((bench, i) => {
            const result = scores[i];
            const rate = result?.rate == null ? null : Math.round(result.rate * 100);
            const seeds = result?.seeds ?? [];
            const seedSummary = !seeds.length ? 'seed metadata unavailable' :
                seeds.length === 1 ? `1 recorded seed (${seeds[0]})` :
                `${seeds.length} recorded seeds (${seeds.slice(0, 5).join(', ')}${seeds.length > 5 ? ', …' : ''})`;
            return <div className="fg-skill-row" key={bench.id}>
                <div className="fg-skill-heading"><div><strong>{bench.label}</strong>
                    <small>{result?.total ? result.successes + '/' + result.total + ' episodes · ' + seedSummary : 'Not assessed'}</small></div>
                    <strong>{rate == null ? '—' : rate + '%'}</strong></div>
                <div className="fg-skill-bar" role="meter" aria-label={bench.label}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={rate ?? 0}
                    aria-valuetext={rate == null ? 'Not assessed' : rate + '% provisional success'}>
                    <div style={{ width: (rate ?? 0) + '%' }} /></div>
                {onEvaluate && <button className="fg-link" type="button" onClick={() => onEvaluate(bench.scenario)}>
                    Evaluate this skill →</button>}
            </div>;
        })}</div>
        <details className="fg-assessment-method">
            <summary>Methodology and limitations</summary>
            <p>Only completed evaluations with saved per-episode success flags count. Results are grouped by exact model SHA-256 and scenario ID, deduplicated by evaluation ticket. Watch sessions, training rewards, baselines and incomplete reports are excluded. The figures are provisional because drill versions and previously viewed seeds were used during development.</p>
            <p>Future certified assessments will require a frozen suite version, unseen seeds, complete comparable runs and recorded environment fingerprints. Shooting and passing remain unassessed until relevant benchmark drills exist.</p>
        </details>
    </section>;
}
