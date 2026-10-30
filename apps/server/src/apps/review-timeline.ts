import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { AtlasRecord } from '../types.js';
import { CODE_REVIEWS_PROJECT_ID } from './review-import.js';

type Reader = Pick<CoreService, 'queryRecords'>;
type StoreIds = { runs: string; findings: string };
type Origin = 'structured' | 'historical' | 'unknown';
type Observation = {
    id: string; runId: string; findingKey: string; lineageKey: string | null;
    severity: 'sev1' | 'sev2' | 'sev3' | 'sev4';
    title: string; description: string; state: 'new' | 'persisting' | 'resolved' | 'unverified';
    filePath?: string; line?: number;
};
type Round = {
    runId: string; headSha: string; reviewedAt: string; verdict: string; source: Origin;
    findingCoverage: 'structured' | 'historical_partial' | 'unknown';
    totalFindingObservations: number; findingsTruncated: boolean; findings: Observation[];
};
const sha = /^[a-f0-9]{40}$/i;
const key = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const verdicts = new Set(['changes_requested', 'concerns_to_verify', 'non_blocking', 'no_findings', 'inconclusive']);
const severities = new Set(['sev1', 'sev2', 'sev3', 'sev4']);
const states = new Set(['new', 'persisting', 'resolved', 'unverified']);
const object = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

function parseRound(record: AtlasRecord, repository: string, prNumber: number): Round {
    const data = record.data;
    if (data.repository !== repository || data.prNumber !== prNumber ||
        typeof data.headSha !== 'string' || !sha.test(data.headSha) ||
        typeof data.reviewedAt !== 'string' || !Number.isFinite(Date.parse(data.reviewedAt)) ||
        !verdicts.has(String(data.verdict)))
        throw new AtlasError('PR timeline contains an invalid or mismatched review run.', 'CAPABILITY_UNAVAILABLE');
    const coverage = object(data.coverage) ? data.coverage : {};
    const source: Origin = coverage.source === 'atlas_structured_submission' ? 'structured'
        : coverage.source === 'github_pull_request_review' ? 'historical' : 'unknown';
    return {
        runId: record.id, headSha: data.headSha.toLowerCase(),
        reviewedAt: data.reviewedAt, verdict: String(data.verdict), source,
        findingCoverage: source === 'structured' ? 'structured'
            : source === 'historical' ? 'historical_partial' : 'unknown',
        totalFindingObservations: 0, findingsTruncated: false, findings: [],
    };
}

function parseFinding(record: AtlasRecord, round: Round, submissionId: unknown): Observation {
    const d = record.data;
    if (d.reviewRunId !== round.runId || typeof d.findingKey !== 'string' ||
        !key.test(d.findingKey.replace(/^structured:[^:]+:/, '').replace(/^github-review-comment:/, '')) ||
        !severities.has(String(d.severity)) || !states.has(String(d.state)) ||
        typeof d.title !== 'string' || !d.title.trim() || d.title.length > 200 ||
        typeof d.description !== 'string')
        throw new AtlasError('PR timeline contains an invalid or mismatched finding.', 'CAPABILITY_UNAVAILABLE');
    if (d.filePath !== undefined && (typeof d.filePath !== 'string' || !d.filePath || d.filePath.length > 1024))
        throw new AtlasError('PR timeline contains an invalid finding location.', 'CAPABILITY_UNAVAILABLE');
    if (d.line !== undefined && (typeof d.line !== 'number' || !Number.isSafeInteger(d.line) || d.line < 1))
        throw new AtlasError('PR timeline contains an invalid finding line.', 'CAPABILITY_UNAVAILABLE');
    const evidence = object(d.evidence) ? d.evidence : {};
    const explicit = evidence.lineageKey;
    // History import comment IDs, matching titles and line numbers never imply identity.
    // An asserted structured key must also belong to this run's submission namespace.
    const trustedNamespace = round.source === 'structured' &&
        typeof submissionId === 'string' && typeof evidence.localKey === 'string' &&
        d.findingKey === `structured:${submissionId}:${evidence.localKey}` &&
        evidence.source === 'atlas_structured_submission';
    if (explicit !== undefined && (!trustedNamespace || typeof explicit !== 'string' || !key.test(explicit)))
        throw new AtlasError('PR timeline contains an unsupported lineage assertion.', 'CAPABILITY_UNAVAILABLE');
    return {
        id: record.id, runId: round.runId, findingKey: d.findingKey,
        lineageKey: trustedNamespace && typeof explicit === 'string' ? explicit : null,
        severity: d.severity as Observation['severity'], title: d.title,
        description: d.description, state: d.state as Observation['state'],
        ...(typeof d.filePath === 'string' && { filePath: d.filePath }),
        ...(typeof d.line === 'number' && { line: d.line }),
    };
}

/** Exactly one bounded page of saved PR rounds, no GitHub writes or inferred resolutions.
 * Lineage counts are scoped to this page, not to an unknown global history.
 */
export async function readPrTimeline(catalog: Reader, ids: StoreIds,
    repository: string, prNumber: number, limit: number, offset: number) {
    const saved = await catalog.queryRecords({
        projectId: CODE_REVIEWS_PROJECT_ID, storeId: ids.runs,
        filters: [
            { field: 'repository', operator: 'eq', value: repository },
            { field: 'prNumber', operator: 'eq', value: prNumber },
        ],
        sort: [{ field: 'reviewedAt', direction: 'desc' }], limit, offset,
    });
    if (saved.items.length > limit ||
        saved.items.length < Math.min(limit, Math.max(0, saved.total - offset)))
        throw new AtlasError('PR timeline returned an incomplete review page.', 'CAPABILITY_UNAVAILABLE');

    const rounds: Round[] = await Promise.all(saved.items.map(async record => {
        const round = parseRound(record, repository, prNumber);
        const page = await catalog.queryRecords({
            projectId: CODE_REVIEWS_PROJECT_ID, storeId: ids.findings,
            filters: [{ field: 'reviewRunId', operator: 'eq', value: round.runId }],
            sort: [{ field: 'createdAt', direction: 'asc' }], limit: 100, offset: 0,
        });
        if (page.items.length > 100 || page.items.length < Math.min(100, page.total))
            throw new AtlasError('PR timeline returned an incomplete finding page.', 'CAPABILITY_UNAVAILABLE');
        round.totalFindingObservations = page.total;
        round.findingsTruncated = page.total > 100;
        const coverage = object(record.data.coverage) ? record.data.coverage : {};
        round.findings = page.items.map(item => parseFinding(item, round, coverage.submissionId));
        const withinRound = new Set<string>();
        for (const finding of round.findings) {
            if (finding.lineageKey) {
                if (withinRound.has(finding.lineageKey))
                    throw new AtlasError('PR timeline has duplicate lineage observations in one round.', 'CONFLICT');
                withinRound.add(finding.lineageKey);
            }
        }
        return round;
    }));

    const grouped = new Map<string, { key: string; observations: {
        runId: string; findingId: string; headSha: string; reviewedAt: string;
        severity: string; title: string; state: string;
    }[] }>();
    let unlinkedObservations = 0;
    for (const round of rounds) for (const finding of round.findings) {
        if (!finding.lineageKey) { unlinkedObservations++; continue; }
        if (!grouped.has(finding.lineageKey))
            grouped.set(finding.lineageKey, { key: finding.lineageKey, observations: [] });
        grouped.get(finding.lineageKey)!.observations.push({
            runId: round.runId, findingId: finding.id, headSha: round.headSha,
            reviewedAt: round.reviewedAt, severity: finding.severity,
            title: finding.title, state: finding.state,
        });
    }
    const more = offset + rounds.length < saved.total;
    return {
        repository, prNumber, recordedRounds: saved.total, limit, offset,
        hasMore: more, storedWindowComplete: offset === 0 && !more &&
            rounds.every(round => !round.findingsTruncated),
        rounds, unlinkedObservations,
        lineages: [...grouped.values()].map(item => ({
            ...item, observationsInPage: item.observations.length,
            recurrence: item.observations.length > 1 ? 'observed_multiple_times_in_page'
                : 'observed_once_in_page',
        })),
        // Missing observations never prove a fix, and imported Markdown is partial.
        resolutionInferred: false,
    };
}
