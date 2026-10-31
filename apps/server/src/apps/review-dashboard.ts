import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import { CODE_REVIEWS_PROJECT_ID } from './review-import.js';

type Reader = Pick<CoreService, 'queryRecords'>;
type HeadReader = (repository: string, prNumber: number) => Promise<{ open: boolean; headSha: string }>;
const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
const VERDICTS = new Set(['changes_requested', 'concerns_to_verify', 'non_blocking', 'no_findings', 'inconclusive']);
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/i;
const MAX_RUNS = 2_000;
const MAX_PRS = 100;
const BATCH_SIZE = 5;
const validCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

type SeverityCounts = Record<(typeof SEVERITIES)[number], number>;
type SummaryRun = {
    id: string; repository: string; prNumber: number; headSha: string;
    reviewedAt: string; verdict: string;
};
type ReviewGroup = {
    key: string; repository: string; prNumber: number; latest: SummaryRun;
    rounds: number; findings: number; countsComplete: boolean; severities: SeverityCounts;
    status: 'open' | 'closed' | 'unavailable';
    reviewFreshness: 'current' | 'outdated' | 'unknown';
    checkedAt?: string;
};
const counts = (): SeverityCounts => ({ sev1: 0, sev2: 0, sev3: 0, sev4: 0 });

/** Full bounded saved-review aggregation, never an unlabelled page-local PR verdict.
 * GitHub state is independently verified; failed reads remain unavailable (not closed).
 */
export async function readReviewDashboard(catalog: Reader, storeId: string, currentHead?: HeadReader) {
    const groups = new Map<string, ReviewGroup>();
    const seenIds = new Set<string>();
    let total: number | null = null;
    for (let offset = 0; offset < MAX_RUNS; offset += 100) {
        const page = await catalog.queryRecords({
            projectId: CODE_REVIEWS_PROJECT_ID, storeId,
            sort: [{ field: 'reviewedAt', direction: 'desc' }], limit: 100, offset,
        });
        if (!Number.isSafeInteger(page.total) || page.total < 0 || page.total > MAX_RUNS ||
            (total !== null && total !== page.total))
            throw new AtlasError('Review dashboard exceeds the bounded history or history changed during loading.', 'CAPABILITY_UNAVAILABLE');
        total = page.total;
        const expected = Math.min(100, Math.max(0, total - offset));
        if (page.items.length !== expected)
            throw new AtlasError('Review dashboard history is incomplete.', 'CAPABILITY_UNAVAILABLE');
        for (const record of page.items) {
            const d = record.data;
            if (seenIds.has(record.id) || typeof d.repository !== 'string' || !REPO.test(d.repository) ||
                d.repository.split('/').some(part => part === '.' || part === '..') ||
                !Number.isSafeInteger(d.prNumber) || Number(d.prNumber) < 1 ||
                typeof d.headSha !== 'string' || !SHA.test(d.headSha) ||
                typeof d.reviewedAt !== 'string' || !Number.isFinite(Date.parse(d.reviewedAt)) ||
                !VERDICTS.has(String(d.verdict)))
                throw new AtlasError('Review dashboard contains invalid or duplicate saved runs.', 'CAPABILITY_UNAVAILABLE');
            seenIds.add(record.id);
            const key = d.repository.toLowerCase() + '#' + d.prNumber;
            let group = groups.get(key);
            const run = { id: record.id, repository: d.repository, prNumber: d.prNumber as number,
                headSha: d.headSha, reviewedAt: d.reviewedAt, verdict: d.verdict as string };
            if (!group) {
                if (groups.size >= MAX_PRS)
                    throw new AtlasError('Review dashboard exceeds the supported 100 reviewed PRs.', 'CAPABILITY_UNAVAILABLE');
                group = { key, repository: d.repository.toLowerCase(), prNumber: run.prNumber,
                    latest: run, rounds: 0, findings: 0, countsComplete: true, severities: counts(),
                    status: 'unavailable', reviewFreshness: 'unknown' };
                groups.set(key, group);
            }
            group.rounds++;
            if (Date.parse(run.reviewedAt) > Date.parse(group.latest.reviewedAt)) group.latest = run;
            const values = d.counts;
            if (!values || typeof values !== 'object' || Array.isArray(values) ||
                !SEVERITIES.every(severity => (values as Record<string, unknown>)[severity] === undefined ||
                    validCount((values as Record<string, unknown>)[severity]))) {
                group.countsComplete = false;
                continue;
            }
            for (const severity of SEVERITIES) {
                const n = (values as Record<string, number>)[severity] ?? 0;
                group.severities[severity] += n;
                group.findings += n;
            }
        }
        if (offset + expected >= total) break;
    }
    const ordered = [...groups.values()].sort((a, b) =>
        Date.parse(b.latest.reviewedAt) - Date.parse(a.latest.reviewedAt) || a.key.localeCompare(b.key));
    // Bound GitHub API concurrency; a single inaccessible repository never becomes a false "closed" PR.
    for (let i = 0; i < ordered.length; i += BATCH_SIZE) {
        await Promise.all(ordered.slice(i, i + BATCH_SIZE).map(async group => {
            if (!currentHead) return;
            try {
                const remote = await currentHead(group.repository, group.prNumber);
                if (typeof remote.open !== 'boolean' || !SHA.test(remote.headSha)) return;
                group.status = remote.open ? 'open' : 'closed';
                group.reviewFreshness = remote.headSha.toLowerCase() === group.latest.headSha.toLowerCase()
                    ? 'current' : 'outdated';
                group.checkedAt = new Date().toISOString();
            } catch {
                // GitHub errors, including missing authorization, must never be treated as a closed PR.
            }
        }));
    }
    return { totalRuns: total ?? 0, groups: ordered };
}
