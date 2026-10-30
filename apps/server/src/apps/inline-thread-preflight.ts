import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { GitHubBroker } from '../workspaces/github-broker.js';
import { canonicalRepository } from './managed-summary.js';
import { CODE_REVIEWS_PROJECT_ID, REVIEW_FINDINGS_STORE, REVIEW_RUNS_STORE } from './review-import.js';
import { readPrTimeline } from './review-timeline.js';

type Reader = Pick<CoreService, 'listStores' | 'queryRecords'>;
type Access = Pick<GitHubBroker, 'pullRequestReadToken'>;
const shaPattern = /^[a-f0-9]{40}$/i;
const safeInt = (x: unknown): x is number =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const object = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object' && !Array.isArray(x);

/** Parse unified diff hunks and validate their declared old/new line counts.
 * Incomplete, malformed and GitHub-truncated patches MUST NOT yield anchors.
 */
export function verifiedAddedRightLines(patch: string, additions: number, deletions: number): Set<number> | null {
    if (patch.length > 120_000 || !safeInt(additions) || !safeInt(deletions)) return null;
    const lines = new Set<number>();
    let oldRemaining = 0, newRemaining = 0, line = 0, seen = false;
    let plus = 0, minus = 0;
    for (const row of patch.split('\n')) {
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(row);
        if (hunk) {
            if (seen && (oldRemaining !== 0 || newRemaining !== 0)) return null;
            seen = true;
            const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
            const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
            line = Number(hunk[3]);
            if (![oldCount, newCount, line].every(safeInt) || line > 10_000_000) return null;
            oldRemaining = oldCount;
            newRemaining = newCount;
            continue;
        }
        if (!seen) return null;
        if (row.startsWith('\\')) {
            if (!row.startsWith('\\ No newline at end of file')) return null;
            continue;
        }
        if (row.startsWith('+')) {
            if (newRemaining < 1 || line < 1) return null;
            lines.add(line++);
            newRemaining--; plus++;
        } else if (row.startsWith('-')) {
            if (oldRemaining < 1) return null;
            oldRemaining--; minus++;
        } else if (row.startsWith(' ')) {
            if (oldRemaining < 1 || newRemaining < 1) return null;
            oldRemaining--; newRemaining--; line++;
        } else if (row === '' && oldRemaining === 0 && newRemaining === 0) {
            // Optional trailing newline from the GitHub patch string.
            continue;
        } else return null;
    }
    return seen && oldRemaining === 0 && newRemaining === 0 &&
        plus === additions && minus === deletions ? lines : null;
}

type FileAnchors = { path: string; lines: Set<number> | null };
type DiffSnapshot = { open: boolean; headSha: string; files: FileAnchors[] };

/** Exact-repository GitHub App reads only. Never posts a review or a thread.
 * Verify the same PR head before and after requesting its bounded diff list.
 */
export class GitHubInlineDiffReader {
    constructor(private readonly broker: Access, private readonly http: typeof fetch = fetch) {}

    private async get(repository: string, path: string, token: string): Promise<unknown> {
        let response: Response;
        try {
            response = await this.http('https://api.github.com/repos/' + repository + path, {
                method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
                headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28' },
            });
        } catch {
            throw new AtlasError('GitHub inline preflight read is unavailable.', 'GITHUB_UNAVAILABLE');
        }
        if (!response.ok)
            throw new AtlasError('GitHub inline preflight read returned HTTP ' + response.status + '.', 'GITHUB_REQUEST_FAILED');
        try { return await response.json(); }
        catch { throw new AtlasError('GitHub inline preflight returned invalid JSON.', 'GITHUB_REQUEST_FAILED'); }
    }

    private parsePr(repository: string, prNumber: number, raw: unknown) {
        const pr = object(raw) ? raw : {};
        const base = object(pr.base) ? pr.base : {};
        const repo = object(base.repo) ? base.repo : {};
        const head = object(pr.head) ? pr.head : {};
        if (pr.number !== prNumber || typeof repo.full_name !== 'string' ||
            repo.full_name.toLowerCase() !== repository ||
            typeof head.sha !== 'string' || !shaPattern.test(head.sha) ||
            !['open', 'closed'].includes(String(pr.state)))
            throw new AtlasError('GitHub inline preflight PR identity is unverified.', 'GITHUB_REQUEST_FAILED');
        return { open: pr.state === 'open', headSha: head.sha.toLowerCase() };
    }

    async inspect(repository: string, prNumber: number): Promise<DiffSnapshot> {
        repository = canonicalRepository(repository);
        if (!Number.isSafeInteger(prNumber) || prNumber < 1 || prNumber > 1_000_000)
            throw new AtlasError('Invalid inline thread PR number.', 'INVALID_REQUEST');
        const token = await this.broker.pullRequestReadToken(repository);
        const first = this.parsePr(repository, prNumber,
            await this.get(repository, '/pulls/' + prNumber, token));
        if (!first.open) return { ...first, files: [] };
        const raw = await this.get(repository, '/pulls/' + prNumber + '/files?per_page=100&page=1', token);
        // A full first page is ambiguous: never treat it as the entire diff.
        if (!Array.isArray(raw) || raw.length >= 100)
            throw new AtlasError('GitHub inline diff file list may be incomplete.', 'CAPABILITY_UNAVAILABLE');
        const found = new Set<string>();
        const files: FileAnchors[] = [];
        for (const value of raw) {
            if (!object(value) || typeof value.filename !== 'string' ||
                !value.filename || value.filename.length > 1024 ||
                found.has(value.filename) || typeof value.status !== 'string' ||
                !['added', 'modified', 'renamed', 'removed', 'copied', 'changed'].includes(value.status) ||
                !safeInt(value.additions) || !safeInt(value.deletions) ||
                !safeInt(value.changes) || value.changes !== value.additions + value.deletions)
                throw new AtlasError('GitHub inline diff file metadata is invalid.', 'GITHUB_REQUEST_FAILED');
            found.add(value.filename);
            const validPatch = ['added', 'modified'].includes(value.status) &&
                typeof value.patch === 'string'
                ? verifiedAddedRightLines(value.patch, value.additions, value.deletions) : null;
            files.push({ path: value.filename, lines: validPatch });
        }
        const last = this.parsePr(repository, prNumber,
            await this.get(repository, '/pulls/' + prNumber, token));
        if (!last.open || last.headSha !== first.headSha)
            throw new AtlasError('GitHub PR changed during inline diff preflight.', 'CONFLICT');
        return { ...first, files };
    }
}

type DiffReader = Pick<GitHubInlineDiffReader, 'inspect'>;
type TimelineRound = Awaited<ReturnType<typeof readPrTimeline>>['rounds'][number];

/** Read-only candidates: no automatic new thread or lifecycle reply is safe
 * until remote thread identity, publisher ownership and one-shot claims exist.
 */
export class InlineThreadPreflightService {
    constructor(private readonly catalog: Reader, private readonly github: DiffReader) {}

    async preview(repository: string, prNumber: number) {
        repository = canonicalRepository(repository);
        if (!Number.isSafeInteger(prNumber) || prNumber < 1 || prNumber > 1_000_000)
            throw new AtlasError('Invalid inline thread PR number.', 'INVALID_REQUEST');
        const stores = await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs = stores.find(store => store.name === REVIEW_RUNS_STORE);
        const findings = stores.find(store => store.name === REVIEW_FINDINGS_STORE);
        if (!runs || !findings)
            throw new AtlasError('Code Reviews Stores are unavailable.', 'CAPABILITY_UNAVAILABLE');
        const saved = await readPrTimeline(this.catalog, { runs: runs.id, findings: findings.id },
            repository, prNumber, 1, 0, true);
        const latest: TimelineRound | undefined = saved.rounds[0];
        if (!latest)
            return { repository, prNumber, status: 'no_saved_review', recordedRounds: saved.recordedRounds,
                dryRun: true, publicationSupported: false, findings: [], resolutions: [] };

        // We still retrieve the PR snapshot for historical/partial runs, but
        // never treat their extracted Markdown findings as trusted new threads.
        const remote = await this.github.inspect(repository, prNumber);
        const usableHead = remote.open && remote.headSha === latest.headSha;
        const full = latest.source === 'structured' && !latest.findingsTruncated;
        const locations = new Map(remote.files.map(file => [file.path, file.lines]));
        const occupied = new Map<string, number>();
        for (const finding of latest.findings) if (finding.filePath && finding.line) {
            const key = finding.filePath + ':' + finding.line;
            occupied.set(key, (occupied.get(key) ?? 0) + 1);
        }
        const findingsPreview = latest.findings.map(item => {
            const location = item.filePath && item.line ? item.filePath + ':' + item.line : null;
            let reason: string;
            if (!usableHead) reason = remote.open ? 'review_head_outdated' : 'pr_closed';
            else if (!full) reason = 'historical_or_partial_evidence';
            else if (item.state !== 'new') reason = 'existing_thread_identity_required';
            else if (!item.filePath || !item.line) reason = 'no_exact_diff_location';
            else if ((occupied.get(location!) ?? 0) > 1) reason = 'multiple_findings_share_anchor';
            else if (!locations.get(item.filePath)?.has(item.line)) reason = 'line_not_verified_as_added_right_side';
            else reason = 'verified_new_line_candidate';
            return {
                findingId: item.id, runId: item.runId, lineageKey: item.lineageKey,
                state: item.state, severity: item.severity, title: item.title,
                ...(item.filePath && { path: item.filePath }),
                ...(item.line && { line: item.line }),
                classification: reason === 'verified_new_line_candidate' ? 'candidate' : 'summary_only',
                reason,
                // A candidate is a validated location, not a publication permit.
                requiresPublisherIdentityAndDeduplication: true,
            };
        });
        return {
            repository, prNumber, runId: latest.runId, recordedRounds: saved.recordedRounds,
            reviewedHeadSha: latest.headSha, currentHeadSha: remote.headSha,
            status: !remote.open ? 'pr_closed' : usableHead ? 'review_head_current' : 'review_head_outdated',
            source: latest.source, completeStructuredEvidence: full,
            dryRun: true, publicationSupported: false,
            findings: findingsPreview,
            resolutions: latest.resolutions.map(item => ({
                lineageKey: item.lineageKey, state: item.state,
                evidence: item.evidence, classification: 'existing_thread_identity_required',
                reviewerAssertionOnly: true,
            })),
        };
    }
}
