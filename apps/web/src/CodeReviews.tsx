import { useEffect, useRef, useState } from 'react';
import { useApplicationRead } from './atlasApi';
import type { AtlasRecord, Page } from './types';
import { CodeReviewThreads } from './CodeReviewThreads';
import './code-reviews.css';
import { Skeleton, SkeletonRows } from './Skeletons';

type Overview = { projectId: string; reviewRuns: number; findingObservations: number };
type Counts = { sev1?: number; sev2?: number; sev3?: number; sev4?: number };
type SavedReceipt = { state: 'claimed' | 'published' | 'unsupported'; commentId?: number };
type SavedClaimCounts = { claimed: number; published: number; unsupported: number };
type SavedPublications = {
    summary?: SavedReceipt;
    fixReplies?: SavedClaimCounts;
    threadResolutions?: SavedClaimCounts;
};
type ReviewRun = {
    id: string; repository: string; prNumber: number; headSha: string; verdict: string;
    reviewedAt: string; reviewer: string; counts?: Counts;
    source: 'historical' | 'structured' | 'unknown';
    publication?: 'claimed' | 'published';
    githubReviewId?: string;
    savedPublications?: SavedPublications;
};
type PrSummary = {
    recordedRounds: number;
    latestReviewHead: 'current' | 'outdated' | 'unknown' | 'no_stored_review';
    latest: { runId: string; headSha: string; reviewedAt: string; verdict: string;
        source: 'structured' | 'historical' | 'unknown';
        severityCounts: Counts | null } | null;
    currentHead: { state: 'open' | 'closed' | 'unavailable'; sha?: string; checkedAt?: string };
};

type PrTimeline = {
    repository: string; prNumber: number; recordedRounds: number; limit: number; offset: number;
    hasMore: boolean; storedWindowComplete: boolean; resolutionInferred: false; unlinkedObservations: number;
    lineages: { key: string; observationsInPage: number; recurrence: string;
        latestAssessmentInPage?: { state: 'resolved' | 'persisting' | 'unverified';
            evidence: string; runId: string; headSha: string; assertedAt: string } | null;
        observations: { runId: string; findingId: string; headSha: string; reviewedAt: string;
            title: string; severity: string; state: string }[] }[];
    rounds: { runId: string; headSha: string; reviewedAt: string; verdict: string;
        source: 'structured' | 'historical' | 'unknown';
        findingCoverage: 'structured' | 'historical_partial' | 'unknown';
        totalFindingObservations: number; findingsTruncated: boolean;
        resolutions?: { lineageKey: string; state: 'resolved'; evidence: string; assessedHeadSha: string }[];
        findings: { id: string; lineageKey: string | null; title: string;
            severity: string; description: string; state: string; filePath?: string; line?: number;
            lifecycleAssessment?: { state: 'persisting' | 'unverified'; evidence: string; assessedHeadSha: string };
        }[];
    }[];
};

type ReviewFinding = {
    id: string; key: string; severity: 'sev1' | 'sev2' | 'sev3' | 'sev4';
    title: string; description: string; state: string; filePath?: string; line?: number;
    initialRoot?: SavedReceipt; persistingReply?: SavedReceipt;
};

const validRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const validSha = /^[0-9a-f]{40}$/i;
const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const verdicts: Record<string, string> = {
    changes_requested: 'Changes requested',
    concerns_to_verify: 'Concerns to verify',
    non_blocking: 'Non-blocking findings',
    no_findings: 'No actionable findings',
    inconclusive: 'Inconclusive',
};
const severities = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
const findingStates = new Set(['new', 'persisting', 'resolved', 'unverified']);
const pageSize = 30;
const findingPageSize = 50;

function safeCount(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const recordObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** Stored metadata is not an independent GitHub verification. Unsupported
 * receipts are explicitly reported rather than silently called published.
 */
function savedReceipt(value: unknown, idField: string): SavedReceipt | undefined {
    if (value === undefined) return undefined;
    if (!recordObject(value) || !['claimed', 'published'].includes(String(value.state)))
        return { state: 'unsupported' };
    if (value.state === 'published' && !positiveId(value[idField]))
        return { state: 'unsupported' };
    return { state: value.state as 'claimed' | 'published',
        ...(positiveId(value[idField]) && { commentId: value[idField] as number }) };
}
function savedClaimCounts(raw: unknown, idField: string): SavedClaimCounts | undefined {
    if (raw === undefined) return undefined;
    if (!recordObject(raw) || Object.keys(raw).length > 30)
        return { claimed: 0, published: 0, unsupported: 1 };
    const counts = { claimed: 0, published: 0, unsupported: 0 };
    for (const value of Object.values(raw)) {
        const receipt = savedReceipt(value, idField);
        if (receipt) counts[receipt.state]++;
    }
    return counts;
}

function parsedRun(record: AtlasRecord): ReviewRun | undefined {
    const d = record.data;
    if (typeof d.repository !== 'string' || !validRepo.test(d.repository) ||
        typeof d.prNumber !== 'number' || !Number.isSafeInteger(d.prNumber) || d.prNumber < 1 ||
        typeof d.headSha !== 'string' || !validSha.test(d.headSha) ||
        typeof d.reviewedAt !== 'string' || Number.isNaN(Date.parse(d.reviewedAt)) ||
        typeof d.verdict !== 'string' || !Object.hasOwn(verdicts, d.verdict)) return;
    const coverage = d.coverage && typeof d.coverage === 'object' && !Array.isArray(d.coverage)
        ? d.coverage as Record<string, unknown> : undefined;
    const publication = coverage?.githubPublication && typeof coverage.githubPublication === 'object'
        ? coverage.githubPublication as Record<string, unknown> : undefined;
    const managedSummary = savedReceipt(coverage?.githubManagedSummary, 'commentId');
    const fixReplies = savedClaimCounts(coverage?.githubFixReplies, 'replyCommentId');
    // GraphQL thread-resolution claims intentionally have no comment ID.
    const threadResolutions = savedClaimCounts(coverage?.githubThreadResolutions, 'rootCommentId');
    const savedPublications = managedSummary || fixReplies || threadResolutions
        ? { summary: managedSummary, fixReplies, threadResolutions } : undefined;
    return { id: record.id, repository: d.repository, prNumber: d.prNumber,
        headSha: d.headSha, reviewedAt: d.reviewedAt, verdict: d.verdict,
        reviewer: typeof d.reviewer === 'string' ? d.reviewer : 'Unknown',
        counts: d.counts && typeof d.counts === 'object' && !Array.isArray(d.counts)
            ? d.counts as Counts : undefined,
        savedPublications,
        source: coverage?.source === 'github_pull_request_review' ? 'historical'
            : coverage?.source === 'atlas_structured_submission' ? 'structured' : 'unknown',
        publication: publication?.state === 'published' || publication?.state === 'claimed'
            ? publication.state : undefined,
        githubReviewId: typeof publication?.githubReviewId === 'string' && /^\d+$/.test(publication.githubReviewId)
            ? publication.githubReviewId
            : typeof d.githubReviewId === 'string' && /^\d+$/.test(d.githubReviewId) ? d.githubReviewId : undefined };
}

function parsedFinding(record: AtlasRecord): ReviewFinding | undefined {
    const d = record.data;
    if (typeof d.severity !== 'string' || !severities.includes(d.severity as ReviewFinding['severity']) ||
        typeof d.title !== 'string' || !d.title.trim() || d.title.length > 200 ||
        typeof d.description !== 'string' || typeof d.state !== 'string' ||
        !findingStates.has(d.state)) return;
    const evidence = recordObject(d.evidence) ? d.evidence : {};
    return { id: record.id, key: typeof d.findingKey === 'string' ? d.findingKey : record.id,
        severity: d.severity as ReviewFinding['severity'], title: d.title,
        description: d.description, state: d.state,
        initialRoot: savedReceipt(evidence.githubInlineThread, 'rootCommentId'),
        persistingReply: savedReceipt(evidence.githubInlineReply, 'replyCommentId'),
        filePath: typeof d.filePath === 'string' && d.filePath.length <= 1024 ? d.filePath : undefined,
        line: typeof d.line === 'number' && Number.isSafeInteger(d.line) && d.line > 0 ? d.line : undefined };
}

/** Fetch GitHub head state only after the user opens one PR status panel. */
function PrStatusDetails({ entry, refreshVersion }: { entry: ReviewRun; refreshVersion: number }) {
    const lastRefresh = useRef(refreshVersion);
    const [timelineOffset, setTimelineOffset] = useState(0);
    const [showGithubThreads, setShowGithubThreads] = useState(false);
    const timeline = useApplicationRead<PrTimeline>('code_reviews_pr_timeline',
        { repository: entry.repository, prNumber: entry.prNumber, limit: 5, offset: timelineOffset }, true);
    const status = useApplicationRead<PrSummary>('code_reviews_pr_summary',
        { repository: entry.repository, prNumber: entry.prNumber }, true);
    useEffect(() => {
        if (lastRefresh.current !== refreshVersion) {
            lastRefresh.current = refreshVersion;
            void status.refetch();
            void timeline.refetch();
        }
    }, [refreshVersion, status.refetch, timeline.refetch]);
    const data = status.data;
    return <div className="code-reviews-detail" id={`code-reviews-pr-status-${entry.id}`}>
        <div className="code-reviews-detail-header">
            <h3>PR status for {entry.repository} #{entry.prNumber}</h3>
            <span>On-demand GitHub head check</span>
        </div>
        {(status.isLoading || status.isFetching && !data) && !status.error && <SkeletonRows label="Checking saved reviews and GitHub head" variant="metrics" rows={2} />}
        {status.error && <p className="notice error" role="alert">Unable to check PR status: {status.error.message}</p>}
        {data && !status.error && <>
            <p>{data.recordedRounds} saved review round{data.recordedRounds === 1 ? '' : 's'}.
                This is not a count of distinct commits or complete GitHub review history.</p>
            {data.currentHead.state === 'unavailable'
                ? <p>Current GitHub head unavailable — review freshness is unknown.</p>
                : <p>GitHub PR is {data.currentHead.state}; current head: <code>{data.currentHead.sha?.slice(0, 7)}</code>.</p>}
            {data.latestReviewHead === 'no_stored_review' &&
                <p>No review stored for this PR. This does not mean it has never been reviewed or has no issues.</p>}
            {data.latestReviewHead === 'unknown' &&
                <p>The latest saved review cannot be compared with the current PR head.</p>}
            {data.latestReviewHead === 'current' &&
                <p>The latest saved review matches the current PR head.</p>}
            {data.latestReviewHead === 'outdated' &&
                <p>The latest saved review targets a different commit — re-review may be needed.</p>}
            {data.latest && <p>Latest saved round: <code>{data.latest.headSha.slice(0, 7)}</code> ·
                {' '}{data.latest.source === 'historical' ? 'Historical Markdown import (partial finding coverage)'
                    : data.latest.source === 'structured' ? 'Structured Atlas submission'
                        : 'Source completeness unknown'}.
                {data.latest.severityCounts
                    ? ` Recorded: ${severities.map(level =>
                        `${level.toUpperCase()} ${data.latest!.severityCounts![level] ?? 0}`).join(' · ')}.`
                    : ' Full severity totals unavailable.'}
            </p>}
        </>}
        <div className="code-reviews-remote-toggle">
            <button type="button" className="ghost" aria-expanded={showGithubThreads}
                aria-controls={`code-reviews-github-threads-${entry.id}`}
                onClick={() => setShowGithubThreads(value => !value)}>
                {showGithubThreads ? 'Hide GitHub conversations' : 'Check GitHub conversations'}
            </button>
            <span className="code-reviews-subtitle">Makes an independent GitHub API request; it never publishes or resolves a thread.</span>
        </div>
        {showGithubThreads && <div id={`code-reviews-github-threads-${entry.id}`}>
            <CodeReviewThreads repository={entry.repository} prNumber={entry.prNumber}
                refreshVersion={refreshVersion} />
        </div>}
        <div className="code-reviews-timeline" aria-label="Saved PR review timeline">
            <h4>Saved review timeline</h4>
            {(timeline.isLoading || timeline.isFetching && !timeline.data) &&
                <SkeletonRows label="Loading saved PR rounds" variant="activity" rows={3} />}
            {timeline.error && <p className="notice error" role="alert">Unable to load PR timeline: {timeline.error.message}</p>}
            {timeline.data && !timeline.error && <>
                <p className="code-reviews-subtitle">
                    Showing saved rounds {timeline.data.rounds.length ? timelineOffset + 1 : 0}–
                    {timelineOffset + timeline.data.rounds.length} of {timeline.data.recordedRounds}.
                    {' '}Lineage counts refer only to this page, not all GitHub reviews.
                </p>
                {timeline.data.rounds.length === 0 &&
                    <p>No rounds saved for this PR on this page. Missing records do not establish a clean review.</p>}
                {timeline.data.rounds.some(round => round.findingCoverage !== 'structured' || round.findingsTruncated) &&
                    <p role="status">Some review evidence is partial or truncated. Missing findings cannot be interpreted as fixes.</p>}
                {timeline.data.lineages.length > 0 && <div className="code-reviews-lineages">
                    <h5>Explicit finding lineages in this page</h5>
                    {timeline.data.lineages.map(lineage => <div key={lineage.key} className="code-reviews-lineage">
                        <strong>{lineage.observations[0]?.title ?? lineage.key}</strong>
                        <span>{lineage.observationsInPage} observed round{lineage.observationsInPage === 1 ? '' : 's'}
                            {' '}· {lineage.observationsInPage > 1 ? 'Repeated root-cause identity' : 'No prior match in this page'}
                        </span>
                        <div className="code-reviews-subtitle">Key: <code>{lineage.key}</code></div>
                        {lineage.latestAssessmentInPage && <div className="code-reviews-subtitle">
                            Latest reviewer assertion in this page: <strong>{lineage.latestAssessmentInPage.state}</strong>
                            {' '}at <code>{lineage.latestAssessmentInPage.headSha.slice(0, 7)}</code>
                            <p>{lineage.latestAssessmentInPage.evidence}</p>
                        </div>}
                    </div>)}
                </div>}
                {timeline.data.unlinkedObservations > 0 &&
                    <p>{timeline.data.unlinkedObservations} observation{timeline.data.unlinkedObservations === 1 ? '' : 's'}
                        {' '}have no explicit cross-round lineage assertion in this page.</p>}
                <div className="code-reviews-rounds">
                    {timeline.data.rounds.map((round, index) => <details className="code-reviews-round" key={round.runId}>
                        <summary>
                            <strong>Round {timelineOffset + index + 1}</strong>
                            {' '}· <code>{round.headSha.slice(0, 7)}</code>
                            {' '}· {Object.hasOwn(verdicts, round.verdict) ? verdicts[round.verdict] : 'Unknown verdict'}
                            {' '}· {round.totalFindingObservations} saved finding{round.totalFindingObservations === 1 ? '' : 's'}
                        </summary>
                        <p className="code-reviews-subtitle">
                            {new Date(round.reviewedAt).toLocaleString()} ·
                            {' '}{round.findingCoverage === 'structured' ? 'Atlas structured submission'
                                : round.findingCoverage === 'historical_partial' ? 'Historical Markdown (partial)'
                                    : 'Unknown evidence completeness'}
                            {round.findingsTruncated ? ' · Only first 100 findings shown' : ''}
                        </p>
                        {round.findings.length === 0 && <p>No finding observations saved for this round; absence alone is not proof of a fix.</p>}
                        {(round.resolutions ?? []).map(event => <article key={event.lineageKey} className="code-reviews-finding">
                            <div className="code-reviews-finding-title">
                                <strong>Reviewer-assessed resolution · {event.lineageKey}</strong>
                                <span>At reviewed head {event.assessedHeadSha.slice(0, 7)}</span>
                            </div>
                            <p>Supporting evidence: {event.evidence}</p>
                        </article>)}
                        {round.findings.map(finding => <article key={finding.id} className="code-reviews-finding">
                            <div className="code-reviews-finding-title">
                                <strong>{finding.severity.toUpperCase()} · {finding.title}</strong>
                                <span>Stored label: {finding.state}</span>
                            </div>
                            {finding.filePath && <div className="code-reviews-subtitle">
                                {finding.filePath}{finding.line ? `:${finding.line}` : ''}
                            </div>}
                            {finding.lineageKey && <div className="code-reviews-subtitle">
                                Root-cause key: <code>{finding.lineageKey}</code>
                            </div>}
                            <p>{finding.description}</p>
                            {finding.lifecycleAssessment && <p>
                                Reviewer-assessed {finding.lifecycleAssessment.state} at
                                {' '}<code>{finding.lifecycleAssessment.assessedHeadSha.slice(0, 7)}</code>:
                                {' '}{finding.lifecycleAssessment.evidence}
                            </p>}
                        </article>)}
                    </details>)}
                </div>
                <p className="code-reviews-subtitle">Lifecycle outcomes are reviewer assertions supported by
                    supplied evidence, not independently code-verified by Atlas. No resolution is inferred from
                    an absent finding, changed commit or outdated GitHub discussion.</p>
                {timeline.data.recordedRounds > 5 && <div className="code-reviews-pagination">
                    <button type="button" className="ghost" disabled={timelineOffset === 0 || timeline.isFetching}
                        onClick={() => setTimelineOffset(Math.max(0, timelineOffset - 5))}>Previous PR rounds</button>
                    <button type="button" className="ghost"
                        disabled={!timeline.data.hasMore || timeline.isFetching}
                        onClick={() => setTimelineOffset(timelineOffset + 5)}>Next PR rounds</button>
                </div>}
            </>}
        </div>
    </div>;
}

function FindingDetails({ entry, refreshVersion }: { entry: ReviewRun; refreshVersion: number }) {
    const [offset, setOffset] = useState(0);
    const lastRefresh = useRef(refreshVersion);
    const findings = useApplicationRead<Page<AtlasRecord>>('code_reviews_list_findings',
        { reviewRunId: entry.id, limit: findingPageSize, offset }, true);
    // Refresh must update the active detail query as well as its parent summary.
    // Remember the initial version so expanding after Refresh does not fetch twice.
    useEffect(() => {
        if (lastRefresh.current !== refreshVersion) {
            lastRefresh.current = refreshVersion;
            void findings.refetch();
        }
    }, [refreshVersion, findings.refetch]);
    const rows = (findings.data?.items ?? []).map(parsedFinding)
        .filter((item): item is ReviewFinding => !!item);
    return <div className="code-reviews-detail" id={`code-reviews-detail-${entry.id}`}>
        <div className="code-reviews-detail-header">
            <h3>Findings for {entry.repository} #{entry.prNumber}</h3>
            <span>{entry.source === 'historical' ? 'Imported from GitHub'
                : entry.source === 'structured' ? 'Submitted to Atlas' : 'Source not recorded'}</span>
        </div>
        {entry.savedPublications && <div className="code-reviews-saved-receipts">
            <h4>Saved GitHub workflow receipts</h4>
            {entry.savedPublications.summary && <p>
                Managed PR summary: {entry.savedPublications.summary.state === 'published'
                    ? 'Atlas receipt published' : entry.savedPublications.summary.state === 'claimed'
                        ? 'Atlas claim pending / outcome uncertain' : 'Unsupported claim metadata'}.
                {entry.savedPublications.summary.state === 'published' &&
                    entry.savedPublications.summary.commentId && <> {' '}<a
                    href={`https://github.com/${entry.repository}/pull/${entry.prNumber}#issuecomment-${entry.savedPublications.summary.commentId}`}
                    target="_blank" rel="noopener noreferrer">View saved comment ↗</a></>}
            </p>}
            {([
                ['Fix-evidence replies', entry.savedPublications.fixReplies],
                ['Conversation-resolution attempts', entry.savedPublications.threadResolutions],
            ] as const).map(([label, counts]) => counts && <p key={label}>
                {label}: {counts.published} stored published · {counts.claimed} claimed/uncertain
                {counts.unsupported > 0 ? ` · ${counts.unsupported} unsupported` : ''}.
            </p>)}
            <p className="code-reviews-subtitle">These are saved Atlas receipts, not a fresh GitHub check.
                A published fix reply does not mean the GitHub discussion was resolved.</p>
        </div>}
        {entry.publication === 'claimed' && <p role="status">GitHub publication is uncertain; check its claim before retrying.</p>}
        {entry.publication === 'published' && <p>Published on GitHub{entry.githubReviewId
            ? <> · <a href={`https://github.com/${entry.repository}/pull/${entry.prNumber}#pullrequestreview-${entry.githubReviewId}`}
                target="_blank" rel="noopener noreferrer">View review ↗</a></> : null}</p>}
        {(findings.isLoading || findings.isFetching && !findings.data) && !findings.error && <SkeletonRows label="Loading review findings" variant="list" rows={3} />}
        {findings.error && <p className="notice error" role="alert">Unable to load findings: {findings.error.message}</p>}
        {!findings.isLoading && !findings.error && findings.data?.total === 0 &&
            <p>No structured findings recorded for this review. This does not establish that the PR has no issues.</p>}
        {findings.data && rows.length !== findings.data.items.length &&
            <p role="status">Some finding records have invalid or unsupported fields and were not displayed.</p>}
        {rows.map(f => <article key={f.id} className="code-reviews-finding">
            <div className="code-reviews-finding-title">
                <strong>{f.severity.toUpperCase()} · {f.title}</strong>
                <span>{f.state === 'unverified' ? 'Unverified historical finding' : f.state}</span>
            </div>
            {f.filePath && <div className="code-reviews-subtitle">{f.filePath}{f.line ? `:${f.line}` : ''}</div>}
            <p>{f.description}</p>
            {f.initialRoot && <p className="code-reviews-subtitle">
                Inline root: {f.initialRoot.state === 'published' ? 'Atlas published receipt'
                    : f.initialRoot.state === 'claimed' ? 'Claimed / uncertain' : 'Unsupported receipt'}.
                {f.initialRoot.state === 'published' && f.initialRoot.commentId && <> {' '}<a
                    href={`https://github.com/${entry.repository}/pull/${entry.prNumber}#discussion_r${f.initialRoot.commentId}`}
                    target="_blank" rel="noopener noreferrer">View inline root ↗</a></>}
            </p>}
            {f.persistingReply && <p className="code-reviews-subtitle">
                Persisting reply: {f.persistingReply.state === 'published' ? 'Atlas published receipt'
                    : f.persistingReply.state === 'claimed' ? 'Claimed / uncertain' : 'Unsupported receipt'}.
            </p>}
        </article>)}
        {findings.data && findings.data.total > findingPageSize && <div className="code-reviews-pagination">
            <button type="button" className="ghost" disabled={offset === 0 || findings.isFetching}
                onClick={() => setOffset(Math.max(0, offset - findingPageSize))}>Previous findings</button>
            <span>{offset + 1}–{Math.min(offset + findingPageSize, findings.data.total)} of {findings.data.total}</span>
            <button type="button" className="ghost" disabled={offset + findingPageSize >= findings.data.total || findings.isFetching}
                onClick={() => setOffset(offset + findingPageSize)}>Next findings</button>
        </div>}
    </div>;
}

export function CodeReviews() {
    const [offset, setOffset] = useState(0);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [statusId, setStatusId] = useState<string | null>(null);
    const [refreshVersion, setRefreshVersion] = useState(0);
    // Revalidate on each entry: Store writes and imports may happen in other clients.
    const summary = useApplicationRead<Overview>('code_reviews_overview', {}, true);
    const runs = useApplicationRead<Page<AtlasRecord>>('code_reviews_list_runs', { limit: pageSize, offset }, true);
    const entries = (runs.data?.items ?? []).map(parsedRun).filter((item): item is ReviewRun => !!item);
    const loadError = summary.error?.message || runs.error?.message;
    return <section className="code-reviews catalogue-page" aria-label="Code Reviews">
        <header className="code-reviews-header">
            <div><p className="eyebrow">Development quality</p><h1>Code Reviews</h1>
                <p>PR review history and structured findings across repositories.</p></div>
            <button className="ghost" type="button" disabled={summary.isFetching || runs.isFetching}
                onClick={() => { void summary.refetch(); void runs.refetch(); setRefreshVersion(v => v + 1); }}>Refresh</button>
        </header>
        <div className="code-reviews-metrics">
            <article><span>Review rounds recorded</span><strong>{summary.data?.reviewRuns ?? (summary.isLoading ? <Skeleton width={64} height={27} /> : '—')}</strong></article>
            <article><span>Finding observations</span><strong>{summary.data?.findingObservations ?? (summary.isLoading ? <Skeleton width={64} height={27} /> : '—')}</strong></article>
            <article><span>Storage</span><strong>{summary.data ? 'Atlas PostgreSQL' : summary.isLoading ? <Skeleton width="75%" height={17} /> : '—'}</strong></article>
        </div>
        {loadError && <div className="notice error" role="alert">Code Reviews data is unavailable: {loadError}</div>}
        <div className="code-reviews-history">
            <div className="code-reviews-history-head"><h2>Review history</h2>
                <span>{runs.data ? `${runs.data.total} total runs` : runs.isLoading ? <Skeleton width={70} height={12} /> : 'Unavailable'}</span></div>
            {runs.isLoading && !runs.data && !runs.error && <SkeletonRows label="Loading saved reviews" variant="activity" rows={5} />}
            {!runs.isLoading && !runs.error && runs.data?.total === 0 &&
                <div className="code-reviews-empty">
                    <h3>No reviews recorded yet</h3>
                    <p>GitHub review history is separate until it is explicitly imported into Atlas. An empty history here is not evidence that PRs were never reviewed.</p>
                </div>}
            {runs.data && entries.length !== runs.data.items.length &&
                <p role="status">Some saved review records have unsupported or invalid fields and were not displayed.</p>}
            <div className="code-reviews-rows">
                {entries.map(entry => <article className="code-reviews-row" key={entry.id}>
                    <div className="code-reviews-row-main">
                        <div className="code-reviews-row-summary">
                            <div><a href={`https://github.com/${entry.repository}/pull/${entry.prNumber}`}
                                target="_blank" rel="noopener noreferrer">
                                {entry.repository} #{entry.prNumber} ↗</a>
                                <div className="code-reviews-subtitle">
                                    Reviewed {new Date(entry.reviewedAt).toLocaleString()} · {entry.headSha.slice(0, 7)} · {entry.reviewer}
                                </div>
                                <div className="code-reviews-subtitle">
                                    {entry.source === 'historical' ? 'Historical import'
                                        : entry.source === 'structured' ? 'Atlas submission' : 'Unknown source'}
                                    {entry.counts ? ` · ${severities.map(s => `${s.toUpperCase()}: ${safeCount(entry.counts?.[s])}`).join(' · ')}` : ''}
                                </div></div>
                            <div className="code-reviews-row-actions">
                                <span className="code-reviews-verdict">{verdicts[entry.verdict]}</span>
                                {validUuid.test(entry.id) && <button type="button" className="ghost"
                                    aria-expanded={statusId === entry.id}
                                    aria-controls={`code-reviews-pr-status-${entry.id}`}
                                    onClick={() => setStatusId(statusId === entry.id ? null : entry.id)}>
                                    {statusId === entry.id ? 'Hide PR status' : 'PR status'}
                                </button>}
                                {validUuid.test(entry.id) && <button type="button" className="ghost"
                                    aria-expanded={expandedId === entry.id}
                                    aria-controls={`code-reviews-detail-${entry.id}`}
                                    onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}>
                                    {expandedId === entry.id ? 'Hide findings' : 'View findings'}
                                </button>}
                            </div>
                        </div>
                    </div>
                    {statusId === entry.id && validUuid.test(entry.id) && <PrStatusDetails key={entry.id} entry={entry} refreshVersion={refreshVersion}/>}
                    {expandedId === entry.id && validUuid.test(entry.id) && <FindingDetails key={entry.id} entry={entry} refreshVersion={refreshVersion}/>}
                </article>)}
            </div>
            {runs.data && runs.data.total > pageSize && <div className="code-reviews-pagination">
                <button type="button" className="ghost" disabled={offset === 0 || runs.isFetching}
                    onClick={() => { setExpandedId(null); setStatusId(null); setOffset(Math.max(0, offset - pageSize)); }}>Previous</button>
                <span>{offset + 1}–{Math.min(offset + pageSize, runs.data.total)} of {runs.data.total}</span>
                <button type="button" className="ghost" disabled={offset + pageSize >= runs.data.total || runs.isFetching}
                    onClick={() => { setExpandedId(null); setStatusId(null); setOffset(offset + pageSize); }}>Next</button>
            </div>}
        </div>
    </section>;
}
