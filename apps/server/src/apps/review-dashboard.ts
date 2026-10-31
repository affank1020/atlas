import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import { CODE_REVIEWS_PROJECT_ID } from './review-import.js';

type Reader = Pick<CoreService, 'queryRecords'>;
type RemoteHead = { open: boolean; headSha: string };
export type DashboardStatusReader = (repository: string, prNumbers: number[], signal: AbortSignal) => Promise<Record<number, RemoteHead>>;
const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
const VERDICTS = new Set(['changes_requested', 'concerns_to_verify', 'non_blocking', 'no_findings', 'inconclusive']);
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/i;
// Recent bounded window; exceeding it is expected growth, not an outage.
const MAX_SCANNED_RUNS = 500;
const MAX_VISIBLE_PRS = 100;
const MAX_REPO_CONCURRENCY = 3;
const STATUS_DEADLINE_MS = 4_500;
const validCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

type SeverityCounts = Record<(typeof SEVERITIES)[number], number>;
type SummaryRun = {
    id: string; repository: string; prNumber: number; headSha: string;
    reviewedAt: string; verdict: string;
};
type ReviewGroup = {
    key: string; repository: string; prNumber: number; latest: SummaryRun;
    rounds: number; findings: number; countsComplete: boolean; roundsComplete: boolean;
    severities: SeverityCounts;
    status: 'open' | 'closed' | 'unavailable';
    reviewFreshness: 'current' | 'outdated' | 'unknown';
    checkedAt?: string;
};
const counts = (): SeverityCounts => ({ sev1: 0, sev2: 0, sev3: 0, sev4: 0 });

/** Read recent stored review runs in a bounded window.
 * Never present a recent-window aggregate as a complete PR lifetime count.
 * Missing GitHub status remains unavailable and never means closed.
 */
export async function readReviewDashboard(catalog: Reader, storeId: string, statuses?: DashboardStatusReader,
    deadlineMs = STATUS_DEADLINE_MS) {
    const groups = new Map<string, ReviewGroup>();
    const seenIds = new Set<string>();
    let total: number | null = null;
    let scannedRuns = 0;
    let truncatedPrs = false;
    for (let offset = 0; offset < MAX_SCANNED_RUNS; offset += 100) {
        const page = await catalog.queryRecords({
            projectId: CODE_REVIEWS_PROJECT_ID, storeId,
            sort: [{ field: 'reviewedAt', direction: 'desc' }], limit: 100, offset,
        });
        if (!Number.isSafeInteger(page.total) || page.total < 0 ||
            (total !== null && total !== page.total))
            throw new AtlasError('Review dashboard history changed during loading.', 'CAPABILITY_UNAVAILABLE');
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
            scannedRuns++;
            seenIds.add(record.id);
            const key = d.repository.toLowerCase() + '#' + d.prNumber;
            let group = groups.get(key);
            const run = { id: record.id, repository: d.repository, prNumber: d.prNumber as number,
                headSha: d.headSha, reviewedAt: d.reviewedAt, verdict: d.verdict as string };
            if (!group) {
                if (groups.size >= MAX_VISIBLE_PRS) { truncatedPrs = true; continue; }
                group = { key, repository: d.repository.toLowerCase(), prNumber: run.prNumber,
                    latest: run, rounds: 0, findings: 0, countsComplete: true, roundsComplete: true,
                    severities: counts(), status: 'unavailable', reviewFreshness: 'unknown' };
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
    const windowComplete = scannedRuns === (total ?? 0);
    if (!windowComplete) for (const group of groups.values()) {
        group.roundsComplete = false;
        group.countsComplete = false;
    }
    const ordered = [...groups.values()].sort((a, b) =>
        Date.parse(b.latest.reviewedAt) - Date.parse(a.latest.reviewedAt) || a.key.localeCompare(b.key));
    if (statuses && ordered.length) {
        const repos = new Map<string, ReviewGroup[]>();
        for (const group of ordered) repos.set(group.repository, [...(repos.get(group.repository) ?? []), group]);
        const jobs = [...repos.entries()];
        let cursor = 0;
        let acceptingResults = true;
        const controller = new AbortController();
        const worker = async () => {
            while (acceptingResults && cursor < jobs.length) {
                const [repo, entries] = jobs[cursor++]!;
                try {
                    const results = await statuses(repo, entries.map(group => group.prNumber), controller.signal);
                    if (!acceptingResults) return;
                    for (const group of entries) {
                        const remote = results[group.prNumber];
                        if (!remote || typeof remote.open !== 'boolean' ||
                            typeof remote.headSha !== 'string' || !SHA.test(remote.headSha)) continue;
                        group.status = remote.open ? 'open' : 'closed';
                        group.reviewFreshness = remote.headSha.toLowerCase() === group.latest.headSha.toLowerCase()
                            ? 'current' : 'outdated';
                        group.checkedAt = new Date().toISOString();
                    }
                } catch {
                    // No verified status: preserve unavailable instead of inventing a closed state.
                }
            }
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                Promise.all(Array.from({ length: Math.min(MAX_REPO_CONCURRENCY, jobs.length) }, worker)),
                new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, deadlineMs); }),
            ]);
        } finally {
            acceptingResults = false;
            controller.abort();
            if (timer) clearTimeout(timer);
        }
    }
    return {
        totalRuns: total ?? 0, scannedRuns, windowComplete, truncatedPrs, groups: ordered,
    };
}
