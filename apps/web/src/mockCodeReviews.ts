/**
 * Offline-only Code Reviews sample records for local UI iteration.
 * Every repository, SHA, GitHub status and finding is synthetic.
 * Nothing here calls GitHub or the production Atlas Server.
 */
import type { AtlasRecord, Page } from './types';

const repository = 'example/atlas-demo';
const projectId = '00000000-0000-4000-8000-000100000001';
const storeId = '00000000-0000-4000-8000-008800000001';
const stamp = '2026-10-30T12:00:00.000Z';
const uuid = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const sha = (letter: string) => letter.repeat(40);
const at = (date: string) => date + 'T12:00:00.000Z';

type FixtureRun = AtlasRecord;
type FixtureFinding = AtlasRecord;

const makeRun = (id: number, pr: number, head: string, reviewedAt: string,
    verdict: string, counts: Record<string, number>): FixtureRun => ({
    id: uuid(id), projectId, storeId, createdAt: reviewedAt, updatedAt: reviewedAt,
    data: {
        repository, prNumber: pr, headSha: head, reviewedAt, verdict,
        reviewer: 'Demo Code Reviewer', counts,
        coverage: { source: 'atlas_structured_submission' },
    },
});
const runs: FixtureRun[] = [
    makeRun(1004, 59, sha('d'), at('2026-10-30'), 'non_blocking', { sev4: 1 }),
    makeRun(1003, 54, sha('c'), at('2026-10-29'), 'no_findings', {}),
    makeRun(1002, 42, sha('b'), at('2026-10-28'), 'concerns_to_verify', { sev3: 1 }),
    makeRun(1001, 42, sha('a'), at('2026-10-27'), 'changes_requested', { sev2: 1 }),
];
const makeFinding = (id: number, reviewRunId: string, lineageKey: string, severity: string,
    title: string, description: string, state: string, filePath: string, line: number): FixtureFinding => ({
    id: uuid(id), projectId, storeId, createdAt: stamp, updatedAt: stamp,
    data: { reviewRunId, findingKey: `demo:${lineageKey}`, lineageKey, severity,
        title, description, state, filePath, line, evidence: {} },
});
const findings: FixtureFinding[] = [
    makeFinding(2004, uuid(1004), 'demo-stale-loading', 'sev4',
        'Loading indicator shifts the panel layout',
        'The empty review panel uses a different height from the loaded result. Reserve space while loading.',
        'new', 'apps/web/src/CodeReviews.tsx', 351),
    makeFinding(2002, uuid(1002), 'demo-token-expiry', 'sev3',
        'Expired GitHub token still returns an empty timeline',
        'A rejected GitHub read should surface an unavailable status rather than display a clean timeline.',
        'persisting', 'apps/server/src/apps/code-reviews.ts', 174),
    makeFinding(2001, uuid(1001), 'demo-token-expiry', 'sev2',
        'Review reads hide authorization failures',
        'When the GitHub token expires, the original implementation treats failed reads as empty results.',
        'new', 'apps/server/src/apps/github-review-history.ts', 91),
];
const page = (items: AtlasRecord[], input: Record<string, unknown>): Page<AtlasRecord> => {
    const offset = Number.isSafeInteger(input.offset) && Number(input.offset) >= 0 ? Number(input.offset) : 0;
    const limit = Number.isSafeInteger(input.limit) && Number(input.limit) > 0
        ? Math.min(100, Number(input.limit)) : 30;
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
};
const ownRuns = (prNumber: number) => runs.filter(r => r.data.prNumber === prNumber);
const ownFindings = (runId: string) => findings.filter(f => f.data.reviewRunId === runId);

function timeline(input: Record<string, unknown>) {
    const prNumber = Number(input.prNumber);
    const all = ownRuns(prNumber);
    const window = page(all, input);
    const lineages = [...new Set(all.flatMap(r =>
        ownFindings(r.id).map(f => String(f.data.lineageKey))))];
    return {
        repository, prNumber, recordedRounds: all.length, limit: window.limit,
        offset: window.offset, hasMore: window.offset + window.items.length < all.length,
        storedWindowComplete: true, resolutionInferred: false, unlinkedObservations: 0,
        lineages: lineages.map(key => {
            const occurrences = window.items.flatMap(r => ownFindings(r.id)
                .filter(f => f.data.lineageKey === key).map(f => ({
                    runId: r.id, findingId: f.id, headSha: r.data.headSha,
                    reviewedAt: r.data.reviewedAt, title: f.data.title,
                    severity: f.data.severity, state: f.data.state,
                })));
            return { key, observationsInPage: occurrences.length,
                recurrence: occurrences.length > 1 ? 'repeated_in_page' : 'observed_once_in_page',
                latestAssessmentInPage: null, observations: occurrences };
        }).filter(l => l.observationsInPage > 0),
        rounds: window.items.map(r => ({
            runId: r.id, headSha: r.data.headSha, reviewedAt: r.data.reviewedAt,
            verdict: r.data.verdict, source: 'structured', findingCoverage: 'structured',
            totalFindingObservations: ownFindings(r.id).length, findingsTruncated: false,
            resolutions: [],
            findings: ownFindings(r.id).map(f => ({
                id: f.id, lineageKey: f.data.lineageKey, title: f.data.title,
                severity: f.data.severity, description: f.data.description,
                state: f.data.state, filePath: f.data.filePath, line: f.data.line,
            })),
        })),
    };
}

/** Only readonly demo operations are supported. No GitHub publication is faked. */
export function mockCodeReviewTool(name: string, input: Record<string, unknown>): unknown {
    switch (name) {
        case 'code_reviews_overview':
            return { projectId, reviewRuns: runs.length, findingObservations: findings.length };
        case 'code_reviews_list_runs':
            return page(runs, input);
        case 'code_reviews_list_findings':
            return page(ownFindings(String(input.reviewRunId ?? '')), input);
        case 'code_reviews_pr_summary': {
            const prNumber = Number(input.prNumber);
            const current = ownRuns(prNumber)[0];
            return {
                repository, prNumber, recordedRounds: ownRuns(prNumber).length,
                latestReviewHead: current ? 'unknown' : 'no_stored_review',
                // Local mock cannot independently verify a GitHub head.
                currentHead: { state: 'unavailable' },
                latest: current ? {
                    runId: current.id, headSha: current.data.headSha,
                    reviewedAt: current.data.reviewedAt,
                    verdict: current.data.verdict, source: 'structured',
                    severityCounts: current.data.counts,
                } : null,
            };
        }
        case 'code_reviews_pr_timeline':
            return timeline(input);
        case 'code_reviews_review_thread_state':
            throw new Error('Live GitHub conversation verification is unavailable in local demo mode.');
        default:
            throw new Error('This Code Reviews operation is not available in local demo mode (' + name + ').');
    }
}
