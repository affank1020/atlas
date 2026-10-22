import { useState } from 'react';
import { useApplicationRead } from './atlasApi';
import type { AtlasRecord, Page } from './types';
import './code-reviews.css';

type Overview = { projectId: string; reviewRuns: number; findingObservations: number };
type ReviewRun = {
    repository: string; prNumber: number; headSha: string; verdict: string;
    reviewedAt: string; reviewer: string; counts?: { sev1?: number; sev2?: number; sev3?: number; sev4?: number };
};

const validRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const validSha = /^[0-9a-f]{40}$/;
const verdicts: Record<string, string> = {
    changes_requested: 'Changes requested',
    concerns_to_verify: 'Concerns to verify',
    non_blocking: 'Non-blocking findings',
    no_findings: 'No actionable findings',
    inconclusive: 'Inconclusive',
};

function parsedRun(record: AtlasRecord): (ReviewRun & { id: string }) | undefined {
    const d = record.data;
    if (typeof d.repository !== 'string' || !validRepo.test(d.repository) ||
        typeof d.prNumber !== 'number' || !Number.isSafeInteger(d.prNumber) || d.prNumber < 1 ||
        typeof d.headSha !== 'string' || !validSha.test(d.headSha) ||
        typeof d.reviewedAt !== 'string' || Number.isNaN(Date.parse(d.reviewedAt)) ||
        typeof d.verdict !== 'string' || !Object.hasOwn(verdicts, d.verdict)) return;
    return { id: record.id, repository: d.repository, prNumber: d.prNumber,
        headSha: d.headSha, reviewedAt: d.reviewedAt, verdict: d.verdict,
        reviewer: typeof d.reviewer === 'string' ? d.reviewer : 'Unknown',
        counts: d.counts && typeof d.counts === 'object' && !Array.isArray(d.counts) ? d.counts as ReviewRun['counts'] : undefined };
}

const pageSize = 30;

export function CodeReviews() {
    const [offset, setOffset] = useState(0);
    const summary = useApplicationRead<Overview>('code_reviews_overview');
    const runs = useApplicationRead<Page<AtlasRecord>>('code_reviews_list_runs', { limit: pageSize, offset });
    const entries = (runs.data?.items ?? []).map(parsedRun).filter((item): item is NonNullable<typeof item> => !!item);
    const loadError = summary.error?.message || runs.error?.message;
    return <section className="code-reviews catalogue-page" aria-label="Code Reviews">
        <header className="code-reviews-header">
            <div><p className="eyebrow">Development quality</p><h1>Code Reviews</h1>
                <p>Independent PR review history and structured findings across repositories.</p></div>
            <button className="ghost" type="button" disabled={summary.isFetching || runs.isFetching}
                onClick={() => { void summary.refetch(); void runs.refetch(); }}>Refresh</button>
        </header>
        <div className="code-reviews-metrics">
            <article><span>Review rounds recorded</span><strong>{summary.data?.reviewRuns ?? '—'}</strong></article>
            <article><span>Finding observations</span><strong>{summary.data?.findingObservations ?? '—'}</strong></article>
            <article><span>Storage</span><strong>{summary.data ? 'Atlas PostgreSQL' : '—'}</strong></article>
        </div>
        {loadError && <div className="notice error" role="alert">Code Reviews data is unavailable: {loadError}</div>}
        <div className="code-reviews-history">
            <div className="code-reviews-history-head"><h2>Review history</h2>
                <span>{runs.data ? `${runs.data.total} total runs` : 'Not loaded'}</span></div>
            {(summary.isLoading || runs.isLoading) && <p role="status">Loading saved reviews…</p>}
            {!runs.isLoading && !runs.error && runs.data?.total === 0 &&
                <div className="code-reviews-empty">
                    <h3>No reviews recorded yet</h3>
                    <p>Existing independent reviews are still available on GitHub. Historical import and Atlas-based review publication will be introduced in later stages of this track.</p>
                </div>}
            {runs.data && entries.length !== runs.data.items.length &&
                <p role="status">Some saved review records have unsupported or invalid fields and were not displayed.</p>}
            <div className="code-reviews-rows">
                {entries.map(entry => <article className="code-reviews-row" key={entry.id}>
                    <div><a href={`https://github.com/${entry.repository}/pull/${entry.prNumber}`}
                        target="_blank" rel="noopener noreferrer">
                        {entry.repository} #{entry.prNumber} ↗</a>
                        <div className="code-reviews-subtitle">
                            Reviewed {new Date(entry.reviewedAt).toLocaleString()} · {entry.headSha.slice(0, 7)} · {entry.reviewer}
                        </div></div>
                    <span className="code-reviews-verdict">{verdicts[entry.verdict]}</span>
                </article>)}
            </div>
            {runs.data && runs.data.total > pageSize && <div className="code-reviews-pagination">
                <button type="button" className="ghost" disabled={offset === 0 || runs.isFetching}
                    onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous</button>
                <span>{offset + 1}–{Math.min(offset + pageSize, runs.data.total)} of {runs.data.total}</span>
                <button type="button" className="ghost" disabled={offset + pageSize >= runs.data.total || runs.isFetching}
                    onClick={() => setOffset(offset + pageSize)}>Next</button>
            </div>}
        </div>
    </section>;
}
