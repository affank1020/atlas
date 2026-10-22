import { AtlasError } from '../shared/errors.js';
import type { AtlasData, RecordData } from '../types.js';
import type { CoreService } from '../core/service.js';
import type { GitHubInlineComment, GitHubReview } from './github-review-history.js';

export const CODE_REVIEWS_PROJECT_ID = '008b191b-96c2-4a5f-92f6-1f13d6d790d5';
export const REVIEW_RUNS_STORE = 'Review Runs';
export const REVIEW_FINDINGS_STORE = 'Review Findings';

export type ReviewSource = { reviews: GitHubReview[]; comments: GitHubInlineComment[] };
type Candidate = {
    sourceId: string;
    run: RecordData;
    comments: { sourceId: string; finding: Omit<RecordData, 'reviewRunId'> }[];
};
const reviewerHeader = /^##\s*(?:🔎\s*)?Code Reviewer\b/im;

function verdict(body: string) {
    const heading = body.slice(0, 1_500);
    if (/\bChanges requested\b/i.test(heading)) return 'changes_requested';
    if (/\bNon.blocking findings\b/i.test(heading)) return 'non_blocking';
    if (/\b(?:No actionable findings|Clean review)\b/i.test(heading)) return 'no_findings';
    if (/\bConcerns to verify\b/i.test(heading)) return 'concerns_to_verify';
    return 'inconclusive';
}

function parseInline(comment: GitHubInlineComment) {
    const match = /\bSev([1-4])\s*[·:\-–]\s*([^\n*]{1,180})/i.exec(comment.body.slice(0, 600));
    if (!match) return undefined;
    const title = match[2]!.trim();
    if (!title) return undefined;
    return {
        sourceId: String(comment.id),
        finding: {
            findingKey: `github-review-comment:${comment.id}`,
            severity: `sev${match[1]}`,
            title: title.slice(0, 180),
            description: comment.body,
            state: 'unverified',
            githubCommentId: String(comment.id),
            schemaVersion: 1,
            ...(comment.path && { filePath: comment.path }),
            ...((comment.line ?? comment.original_line) && { line: comment.line ?? comment.original_line }),
            evidence: {
                source: 'github_inline_review_comment',
                url: comment.html_url,
                originalLine: comment.original_line,
                // No inferences about whether old code was fixed.
                lifecycleKnown: false,
            },
        },
    };
}

export function prepareGitHubReviews(repository: string, prNumber: number, snapshot: ReviewSource) {
    const candidates: Candidate[] = [];
    const allCommentIds = new Set<number>();
    for (const comment of snapshot.comments) {
        if (allCommentIds.has(comment.id)) throw new AtlasError('GitHub returned duplicate review comment IDs.', 'GITHUB_REQUEST_FAILED');
        allCommentIds.add(comment.id);
    }
    const commentsByReview = new Map<number, GitHubInlineComment[]>();
    for (const comment of snapshot.comments) {
        const group = commentsByReview.get(comment.pull_request_review_id) ?? [];
        group.push(comment);
        commentsByReview.set(comment.pull_request_review_id, group);
    }
    const seen = new Set<number>();
    let skippedUnrecognized = 0;
    let skippedIncomplete = 0;
    let commentsWithoutSeverity = 0;
    for (const review of snapshot.reviews) {
        if (seen.has(review.id)) throw new AtlasError('GitHub returned duplicate review IDs.', 'GITHUB_REQUEST_FAILED');
        seen.add(review.id);
        if (typeof review.body !== 'string' || !reviewerHeader.test(review.body)) { skippedUnrecognized++; continue; }
        if (!review.commit_id || !/^[a-f0-9]{40}$/i.test(review.commit_id) || !review.submitted_at || !review.user ||
            Number.isNaN(Date.parse(review.submitted_at))) { skippedIncomplete++; continue; }
        const comments = (commentsByReview.get(review.id) ?? []).flatMap(comment => {
            const parsed = parseInline(comment);
            if (!parsed) commentsWithoutSeverity++;
            return parsed ? [parsed] : [];
        });
        candidates.push({
            sourceId: String(review.id),
            run: {
                repository, prNumber,
                headSha: review.commit_id.toLowerCase(),
                reviewer: review.user.login,
                verdict: verdict(review.body),
                reviewedAt: new Date(review.submitted_at).toISOString(),
                githubReviewId: String(review.id),
                githubReviewUrl: review.html_url,
                schemaVersion: 1,
                coverage: {
                    source: 'github_pull_request_review',
                    format: 'historical_markdown',
                    originalReviewBody: review.body,
                    githubReviewState: review.state,
                    findingCapture: 'severity_labeled_inline_comments_only',
                    // Review summary sections may mention additional findings not posted inline.
                    summaryFindingsNotParsed: true,
                    lifecycleKnown: false,
                },
            },
            comments,
        });
    }
    return { candidates, skippedUnrecognized, skippedIncomplete, commentsWithoutSeverity };
}

type RecordInState = Pick<CoreService, 'createRecordInState'>;
type Totals = {
    repository: string; prNumber: number; dryRun: boolean; sourceReviews: number; recognizedReviews: number;
    skippedUnrecognized: number; skippedIncomplete: number; commentsWithoutSeverity: number;
    runsCreated: number; runsAlreadyPresent: number; findingsCreated: number; findingsAlreadyPresent: number;
};

/** Reconcile against IDs in the PostgreSQL-backed Atlas Store transaction.
 * Never merge two independent review rounds by PR or commit SHA.
 */
export function reconcileGitHubReviews(
    catalog: RecordInState,
    state: AtlasData,
    stores: { runs: string; findings: string },
    repository: string,
    prNumber: number,
    snapshot: ReviewSource,
    write: boolean,
): Totals {
    const runStore = state.stores.find(s => s.id === stores.runs && s.projectId === CODE_REVIEWS_PROJECT_ID && !s.archivedAt);
    const findingStore = state.stores.find(s => s.id === stores.findings && s.projectId === CODE_REVIEWS_PROJECT_ID && !s.archivedAt);
    if (!state.projects.some(p => p.id === CODE_REVIEWS_PROJECT_ID && !p.archivedAt) ||
        !runStore || runStore.name !== REVIEW_RUNS_STORE ||
        !findingStore || findingStore.name !== REVIEW_FINDINGS_STORE)
        throw new AtlasError('Code Reviews project or Stores are unavailable.', 'CAPABILITY_UNAVAILABLE');

    const prepared = prepareGitHubReviews(repository, prNumber, snapshot);
    const runs = new Map<string, { id: string; data: RecordData }>();
    const findings = new Map<string, { id: string; data: RecordData }>();
    for (const record of state.records) {
        if (record.archivedAt) continue;
        if (record.storeId === stores.runs && typeof record.data.githubReviewId === 'string') {
            if (runs.has(record.data.githubReviewId))
                throw new AtlasError('Duplicate imported GitHub review IDs were detected.', 'CONFLICT');
            runs.set(record.data.githubReviewId, record);
        }
        if (record.storeId === stores.findings && typeof record.data.githubCommentId === 'string') {
            if (findings.has(record.data.githubCommentId))
                throw new AtlasError('Duplicate imported GitHub comment IDs were detected.', 'CONFLICT');
            findings.set(record.data.githubCommentId, record);
        }
    }
    const result: Totals = {
        repository, prNumber, dryRun: !write, sourceReviews: snapshot.reviews.length,
        recognizedReviews: prepared.candidates.length,
        skippedUnrecognized: prepared.skippedUnrecognized, skippedIncomplete: prepared.skippedIncomplete,
        commentsWithoutSeverity: prepared.commentsWithoutSeverity,
        runsCreated: 0, runsAlreadyPresent: 0, findingsCreated: 0, findingsAlreadyPresent: 0,
    };
    for (const candidate of prepared.candidates) {
        let run = runs.get(candidate.sourceId);
        if (run) {
            if (String(run.data.repository).toLowerCase() !== repository.toLowerCase() ||
                run.data.prNumber !== prNumber || run.data.headSha !== candidate.run.headSha)
                throw new AtlasError('Existing GitHub review identity conflicts with its source.', 'CONFLICT');
            result.runsAlreadyPresent++;
        } else {
            result.runsCreated++;
            run = write ? catalog.createRecordInState(state, {
                projectId: CODE_REVIEWS_PROJECT_ID, storeId: stores.runs, data: candidate.run,
                client: 'atlas-code-reviews-import',
            }) : { id: `dry-run:${candidate.sourceId}`, data: candidate.run };
            runs.set(candidate.sourceId, run);
        }
        for (const comment of candidate.comments) {
            const existing = findings.get(comment.sourceId);
            if (existing) {
                if (existing.data.reviewRunId !== run.id || existing.data.findingKey !== comment.finding.findingKey)
                    throw new AtlasError('Existing GitHub comment identity conflicts with its review.', 'CONFLICT');
                result.findingsAlreadyPresent++;
            } else {
                result.findingsCreated++;
                const data = { ...comment.finding, reviewRunId: run.id };
                const finding = write ? catalog.createRecordInState(state, {
                    projectId: CODE_REVIEWS_PROJECT_ID, storeId: stores.findings, data,
                    client: 'atlas-code-reviews-import',
                }) : { id: `dry-comment:${comment.sourceId}`, data };
                findings.set(comment.sourceId, finding);
            }
        }
    }
    return result;
}
