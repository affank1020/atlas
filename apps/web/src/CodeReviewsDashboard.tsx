import { useState } from 'react';
import { useApplicationRead } from './atlasApi';
import { IS_MOCK_MODE } from './api';
import { CodeReviewThreads } from './CodeReviewThreads';
import type { AtlasRecord, Page } from './types';
import './code-reviews-dashboard.css';

type Counts = Partial<Record<'sev1' | 'sev2' | 'sev3' | 'sev4', number>>;
const severities = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
const verdicts: Record<string, string> = {
    changes_requested: 'Changes requested', concerns_to_verify: 'Needs verification',
    non_blocking: 'Non-blocking', no_findings: 'No findings', inconclusive: 'Inconclusive',
};
type Run = {
    id: string; repository: string; prNumber: number; headSha: string;
    reviewedAt: string; verdict: string; counts: Counts | null;
    source: 'structured' | 'historical' | 'unknown';
};
type Group = {
    key: string; repository: string; prNumber: number;
    latest: Run; rounds: Run[]; findings: number; countsComplete: boolean; severities: Counts;
};
type Overview = { reviewRuns: number; findingObservations: number };
type Finding = { id: string; severity: string; title: string; description: string; state: string;
    filePath?: string; line?: number };
type Round = { runId: string; headSha: string; reviewedAt: string; verdict: string;
    totalFindingObservations: number; findingCoverage: string; findingsTruncated: boolean;
    findings: Array<{ id: string; title: string; severity: string; description: string; state: string;
        filePath?: string; line?: number }>;
    resolutions?: Array<{ lineageKey: string; evidence: string }> };
type Timeline = { recordedRounds: number; rounds: Round[]; hasMore: boolean; offset: number };
type PrStatus = { recordedRounds: number; latestReviewHead: string;
    currentHead: { state: string; sha?: string } };

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[a-f0-9]{40}$/i;
const validCount = (n: unknown): n is number => typeof n === 'number' &&
    Number.isSafeInteger(n) && n >= 0;
const number = (n: unknown) => validCount(n) ? n : 0;
const validDate = (s: unknown): s is string => typeof s === 'string' && !Number.isNaN(Date.parse(s));
const dateLabel = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function parseRun(record: AtlasRecord): Run | null {
    const d = record.data;
    if (typeof d.repository !== 'string' || !repoPattern.test(d.repository) ||
        d.repository.split('/').some(part => part === '.' || part === '..') ||
        !Number.isSafeInteger(d.prNumber) || Number(d.prNumber) < 1 ||
        typeof d.headSha !== 'string' || !shaPattern.test(d.headSha) ||
        !validDate(d.reviewedAt) || typeof d.verdict !== 'string' ||
        !Object.hasOwn(verdicts, d.verdict)) return null;
    const c = d.counts && typeof d.counts === 'object' && !Array.isArray(d.counts)
        ? d.counts as Record<string, unknown> : null;
    const counts = c && severities.every(s => c[s] === undefined || validCount(c[s]))
        ? c as Counts : null;
    const coverage = d.coverage && typeof d.coverage === 'object' && !Array.isArray(d.coverage)
        ? d.coverage as Record<string, unknown> : {};
    const source = coverage.source === 'atlas_structured_submission' ? 'structured' :
        coverage.source === 'github_pull_request_review' ? 'historical' : 'unknown';
    return { id: record.id, repository: d.repository, prNumber: Number(d.prNumber),
        headSha: d.headSha, reviewedAt: d.reviewedAt, verdict: d.verdict, counts, source };
}

export function groupReviewRuns(entries: Run[]): Group[] {
    const grouped = new Map<string, Group>();
    for (const run of entries) {
        const key = run.repository.toLowerCase() + '#' + run.prNumber;
        let group = grouped.get(key);
        if (!group) {
            group = { key, repository: run.repository, prNumber: run.prNumber, latest: run,
                rounds: [], findings: 0, countsComplete: true, severities: {} };
            grouped.set(key, group);
        }
        group.rounds.push(run);
        if (run.reviewedAt > group.latest.reviewedAt) group.latest = run;
        if (!run.counts) group.countsComplete = false;
        for (const severity of severities) {
            const value = number(run.counts?.[severity]);
            group.findings += value;
            group.severities[severity] = number(group.severities[severity]) + value;
        }
    }
    return [...grouped.values()].sort((a, b) =>
        b.latest.reviewedAt.localeCompare(a.latest.reviewedAt) || a.key.localeCompare(b.key));
}
const findingCount = (group: Group) => group.countsComplete ? String(group.findings)
    : group.findings > 0 ? String(group.findings) + '+' : '—';

function FindingList({ run }: { run: Run }) {
    const query = useApplicationRead<Page<AtlasRecord>>('code_reviews_list_findings',
        { reviewRunId: run.id, limit: 50, offset: 0 }, true);
    const valid = (query.data?.items ?? []).map(record => {
        const d = record.data;
        if (typeof d.title !== 'string' || typeof d.description !== 'string' ||
            typeof d.severity !== 'string' || !severities.some(s => s === d.severity)) return null;
        return { id: record.id, title: d.title, description: d.description, severity: d.severity,
            state: typeof d.state === 'string' ? d.state : 'unknown',
            filePath: typeof d.filePath === 'string' ? d.filePath : undefined,
            line: Number.isSafeInteger(d.line) && Number(d.line) > 0 ? Number(d.line) : undefined } as Finding;
    }).filter((v): v is Finding => v !== null);
    return <section aria-label="Latest round findings" className="cr-detail-section">
        <div className="cr-detail-heading"><h3>Latest round findings</h3><span>{run.headSha.slice(0, 7)}</span></div>
        {query.isLoading && <p role="status">Loading findings…</p>}
        {query.error && <p role="alert" className="notice error">{query.error.message}</p>}
        {query.data && !query.error && query.data.total === 0 && <p className="cr-quiet">No recorded findings in this round.</p>}
        {query.data && valid.length !== query.data.items.length && <p role="status">Some findings could not be displayed.</p>}
        {valid.map(f => <article className="cr-finding" key={f.id}>
            <div className="cr-finding-head"><span className={'cr-severity ' + f.severity}>{f.severity.toUpperCase()}</span>
                <strong>{f.title}</strong><span className="cr-quiet">{f.state}</span></div>
            {f.filePath && <div className="cr-quiet cr-location">{f.filePath}{f.line ? ':' + f.line : ''}</div>}
            <p>{f.description}</p>
        </article>)}
        {query.data && query.data.total > 50 && <p className="cr-quiet">Showing first 50 of {query.data.total} findings.</p>}
    </section>;
}

function RoundHistory({ group }: { group: Group }) {
    const [offset, setOffset] = useState(0);
    const query = useApplicationRead<Timeline>('code_reviews_pr_timeline',
        { repository: group.repository.toLowerCase(), prNumber: group.prNumber, limit: 10, offset }, true);
    return <section className="cr-detail-section" aria-label="Review rounds">
        <div className="cr-detail-heading"><h3>Review rounds</h3>
            <span>{query.data?.recordedRounds ?? '—'} saved</span></div>
        {query.isLoading && <p role="status">Loading review rounds…</p>}
        {query.error && <p role="alert" className="notice error">{query.error.message}</p>}
        {query.data?.rounds.map((round, index) => <details className="cr-round" key={round.runId}>
            <summary><span className="cr-quiet">#{offset + index + 1}</span>
                <code>{round.headSha.slice(0, 7)}</code>
                <span>{verdicts[round.verdict] ?? 'Unknown'}</span>
                <strong>{round.totalFindingObservations} findings</strong>
                <time>{dateLabel(round.reviewedAt)}</time></summary>
            {round.findingCoverage !== 'structured' && <div className="cr-quiet">Partial historical finding coverage</div>}
            {round.findingsTruncated && <div className="cr-quiet">Finding list truncated</div>}
            {round.findings.map(f => <article className="cr-finding" key={f.id}>
                <div className="cr-finding-head"><span className={'cr-severity ' + f.severity}>{f.severity.toUpperCase()}</span>
                    <strong>{f.title}</strong><span className="cr-quiet">{f.state}</span></div>
                {f.filePath && <div className="cr-quiet cr-location">{f.filePath}{f.line ? ':' + f.line : ''}</div>}
                <p>{f.description}</p>
            </article>)}
            {(round.resolutions ?? []).map(r => <article className="cr-finding" key={r.lineageKey}>
                <strong>Reviewer-assessed fix · {r.lineageKey}</strong><p>{r.evidence}</p>
            </article>)}
            {round.findings.length === 0 && !(round.resolutions?.length) && <p className="cr-quiet">No recorded findings.</p>}
        </details>)}
        {query.data && (offset > 0 || query.data.hasMore) && <div className="cr-pagination">
            <button type="button" className="ghost" disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 10))}>Newer</button>
            <span>{offset + 1}–{offset + query.data.rounds.length} of {query.data.recordedRounds}</span>
            <button type="button" className="ghost" disabled={!query.data.hasMore}
                onClick={() => setOffset(offset + 10)}>Older</button>
        </div>}
    </section>;
}

function GithubStatus({ group, refreshVersion }: { group: Group; refreshVersion: number }) {
    const [showThreads, setShowThreads] = useState(false);
    const query = useApplicationRead<PrStatus>('code_reviews_pr_summary',
        { repository: group.repository.toLowerCase(), prNumber: group.prNumber }, true);
    return <section className="cr-detail-section" aria-label="GitHub status">
        <div className="cr-detail-heading"><h3>GitHub status</h3></div>
        {query.isLoading && <p role="status">Checking GitHub…</p>}
        {query.error && <p role="alert" className="notice error">{query.error.message}</p>}
        {query.data && <div className="cr-status-grid">
            <div><span>PR state</span><strong>{query.data.currentHead.state}</strong></div>
            <div><span>Review freshness</span><strong>{query.data.latestReviewHead.replaceAll('_', ' ')}</strong></div>
            <div><span>Saved rounds</span><strong>{query.data.recordedRounds}</strong></div>
        </div>}
        <button type="button" className="ghost" onClick={() => setShowThreads(v => !v)}
            aria-expanded={showThreads}>{showThreads ? 'Hide conversations' : 'Check conversations'}</button>
        {showThreads && <CodeReviewThreads repository={group.repository} prNumber={group.prNumber} refreshVersion={refreshVersion}/>}
    </section>;
}

function PrDetails({ group, refreshVersion }: { group: Group; refreshVersion: number }) {
    const [tab, setTab] = useState<'findings' | 'rounds' | 'github'>('findings');
    return <div className="cr-detail" id={'cr-detail-' + group.key}>
        <div className="cr-tabs" role="tablist" aria-label={'PR #' + group.prNumber + ' details'}>
            {(['findings', 'rounds', 'github'] as const).map(name =>
                <button type="button" role="tab" key={name} className={tab === name ? 'active' : ''}
                    aria-selected={tab === name} onClick={() => setTab(name)}>
                    {name === 'findings' ? 'Latest findings' : name === 'rounds' ? 'Review rounds' : 'GitHub'}</button>)}
        </div>
        <div role="tabpanel">
            {tab === 'findings' && <FindingList run={group.latest}/>}
            {tab === 'rounds' && <RoundHistory group={group}/>}
            {tab === 'github' && <GithubStatus group={group} refreshVersion={refreshVersion}/>}
        </div>
    </div>;
}

export function CodeReviewsDashboard() {
    const [offset, setOffset] = useState(0);
    const [filter, setFilter] = useState<'all' | 'findings' | 'revisited'>('all');
    const [search, setSearch] = useState('');
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    const [refreshVersion, setRefreshVersion] = useState(0);
    const summary = useApplicationRead<Overview>('code_reviews_overview', {}, true);
    const runs = useApplicationRead<Page<AtlasRecord>>('code_reviews_list_runs', { limit: 100, offset }, true);
    const entries = (runs.data?.items ?? []).map(parseRun).filter((r): r is Run => !!r);
    const groups = groupReviewRuns(entries);
    const needle = search.trim().toLowerCase();
    const shown = groups.filter(group =>
        (filter === 'all' || filter === 'findings' && (group.findings > 0 || !group.countsComplete) ||
            filter === 'revisited' && group.rounds.length > 1) &&
        (!needle || (group.repository + ' #' + group.prNumber).toLowerCase().includes(needle)));
    const overview = summary.data;
    const average = overview && overview.reviewRuns > 0
        ? (overview.findingObservations / overview.reviewRuns).toFixed(2) : '—';
    const incomplete = runs.data && (offset > 0 || offset + runs.data.items.length < runs.data.total);
    const error = summary.error?.message || runs.error?.message;
    return <section className="code-reviews cr-dashboard" aria-label="Code Reviews">
        <header className="cr-header"><h1>Code Reviews</h1>
            <button type="button" className="ghost" disabled={summary.isFetching || runs.isFetching}
                onClick={() => { void summary.refetch(); void runs.refetch(); setRefreshVersion(v => v + 1); }}>
                Refresh</button></header>
        {IS_MOCK_MODE && <span className="cr-demo">Demo data</span>}
        <div className="cr-metrics" aria-label="Review metrics">
            <article><span>Review rounds</span><strong>{overview ? overview.reviewRuns.toLocaleString() : '—'}</strong></article>
            <article><span>Findings recorded</span><strong>{overview ? overview.findingObservations.toLocaleString() : '—'}</strong></article>
            <article title="Finding observations divided by saved review rounds; repeated issues count in every round where observed.">
                <span>Findings / review</span><strong>{average}</strong></article>
            <article title="Distinct PRs in the displayed review rounds; may exclude older PRs if history spans multiple pages.">
                <span>{runs.data && offset === 0 && runs.data.total <= 100 ? 'PRs reviewed' : 'PRs on page'}</span>
                <strong>{runs.data ? groups.length : '—'}</strong></article>
        </div>
        {error && <div className="notice error" role="alert">{error}</div>}
        <section className="cr-list" aria-label="Pull request reviews">
            <div className="cr-list-head"><h2>Pull requests</h2>
                <div className="cr-filters">
                    <input type="search" aria-label="Find pull request" placeholder="Find PR…" value={search}
                        onChange={e => setSearch(e.target.value)}/>
                    <span className="cr-filter-select">
                        <select aria-label="Filter pull requests" value={filter}
                            onChange={e => setFilter(e.target.value as typeof filter)}>
                            <option value="all">All PRs</option><option value="findings">With findings</option>
                            <option value="revisited">Re-reviewed</option>
                        </select>
                    </span>
                </div></div>
            {incomplete && <p className="cr-quiet cr-page-note" role="status">Showing a slice of saved rounds; per-PR counts may be partial.</p>}
            {runs.isLoading && <p className="cr-quiet cr-loading" role="status">Loading reviews…</p>}
            {!runs.isLoading && runs.data?.total === 0 && <p className="cr-empty">No reviews recorded.</p>}
            {runs.data && entries.length !== runs.data.items.length && <p role="status" className="cr-page-note">
                Some review records could not be displayed.</p>}
            {runs.data && groups.length > 0 && <>
                <div className="cr-table-head" aria-hidden="true"><span>PR</span><span>Rounds</span>
                    <span>Findings</span><span>Latest result</span><span>Reviewed</span><span/></div>
                {shown.map(group => <article className="cr-pr" key={group.key}>
                    <div className="cr-pr-main">
                        <div className="cr-pr-identity">
                            {IS_MOCK_MODE ? <span className="cr-demo-pr">{group.repository} #{group.prNumber}</span> :
                                <a href={'https://github.com/' + group.repository + '/pull/' + group.prNumber}
                                    target="_blank" rel="noopener noreferrer">
                                    {group.repository} #{group.prNumber} ↗</a>}
                            <div className="cr-severity-summary">
                                {severities.filter(s => number(group.severities[s]) > 0).map(s =>
                                    <span key={s} className={'cr-severity ' + s}>{s.toUpperCase()} {group.severities[s]}</span>)}
                            </div>
                        </div>
                        <div className="cr-number"><strong>{group.rounds.length}</strong></div>
                        <div className="cr-number" title={group.countsComplete ? 'Finding observations across these saved rounds' : 'Some rounds have unknown finding counts'}>
                            <strong>{findingCount(group)}</strong>
                            <span>{group.countsComplete && group.rounds.length ? (group.findings / group.rounds.length).toFixed(1) + ' / round' : 'Incomplete'}</span></div>
                        <span className={'cr-verdict ' + group.latest.verdict}>{verdicts[group.latest.verdict]}</span>
                        <time className="cr-date" dateTime={group.latest.reviewedAt}>{dateLabel(group.latest.reviewedAt)}</time>
                        <button type="button" className="cr-expand" aria-label={'Details for ' + group.repository + ' #' + group.prNumber}
                            aria-expanded={expandedKey === group.key} aria-controls={'cr-detail-' + group.key}
                            onClick={() => setExpandedKey(expandedKey === group.key ? null : group.key)}>
                            {expandedKey === group.key ? '−' : '+'}</button>
                    </div>
                    {expandedKey === group.key && <PrDetails key={group.key + ':' + refreshVersion} group={group} refreshVersion={refreshVersion}/>}
                </article>)}
                {shown.length === 0 && <p className="cr-empty">No matching PRs.</p>}
            </>}
            {runs.data && runs.data.total > 100 && <div className="cr-pagination">
                <button type="button" className="ghost" disabled={offset === 0 || runs.isFetching}
                    onClick={() => { setOffset(Math.max(0, offset - 100)); setExpandedKey(null); }}>Newer</button>
                <span>Rounds {offset + 1}–{Math.min(offset + 100, runs.data.total)} of {runs.data.total}</span>
                <button type="button" className="ghost" disabled={offset + 100 >= runs.data.total || runs.isFetching}
                    onClick={() => { setOffset(offset + 100); setExpandedKey(null); }}>Older</button>
            </div>}
        </section>
    </section>;
}
