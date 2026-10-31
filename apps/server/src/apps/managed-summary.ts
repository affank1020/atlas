import { createHash } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { GitHubBroker } from '../workspaces/github-broker.js';
import { CODE_REVIEWS_PROJECT_ID, REVIEW_FINDINGS_STORE, REVIEW_RUNS_STORE } from './review-import.js';
import { readPrTimeline } from './review-timeline.js';

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const sha = /^[a-f0-9]{40}$/i;
const safeNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const safeText = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length <= max;
/** Safe inline Markdown for fields taken from submitted review text.
 * Never allow a line break to escape into a new heading, quote or alert.
 */
const inlineText = (value: string, max: number) =>
    value.slice(0, max)
        .replace(/[\r\n\t\u2028\u2029]/g, ' ')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/([\\`*_{}\[\]()#+.!|~\\-])/g, '\\$1');

/** A backslash does not escape a backtick inside a Markdown code span.
 * Delimit each value with a fence longer than its longest backtick run.
 */
function inlineCode(value: string, max: number) {
    const safe = value.slice(0, max).replace(/[\r\n\t\u2028\u2029]/g, ' ');
    const longest = Math.max(0, ...(safe.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    return fence + ' ' + safe + ' ' + fence;
}

/** Stored structured reviews use lowercase owner/repository names. Validate
 * both path segments before canonicalization so "." and ".." never pass.
 */
export function canonicalRepository(repository: string) {
    if (!repositoryPattern.test(repository) ||
        repository.split('/').some(segment => segment === '.' || segment === '..'))
        throw new AtlasError('Invalid managed summary repository identity.', 'INVALID_REQUEST');
    return repository.toLowerCase();
}
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

type Reader = Pick<CoreService, 'listStores' | 'queryRecords'>;
type Bot = Pick<GitHubBroker, 'pullRequestReadToken' | 'reviewPublisherBot'>;
type Round = Awaited<ReturnType<typeof readPrTimeline>>['rounds'][number];

/** Stable identity for the PR-level comment, distinct from the legacy per-run review marker. */
export function managedSummaryMarker(repository: string, prNumber: number) {
    const canonical = canonicalRepository(repository);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1 || prNumber > 1_000_000)
        throw new AtlasError('Invalid managed summary PR identity.', 'INVALID_REQUEST');
    return `<!-- atlas-code-reviews-managed-summary:v1:${canonical}#${prNumber} -->`;
}

/** The latest *saved* round, not a claim of exhaustive GitHub review history.
 * Explicit round-level lifecycle outcomes are reviewer assertions, not verified fixes.
 */
export function renderManagedSummary(repository: string, prNumber: number, round: Round, savedRounds: number) {
    const marker = managedSummaryMarker(repository, prNumber);
    if (!sha.test(round.headSha) || !Number.isFinite(Date.parse(round.reviewedAt)))
        throw new AtlasError('Invalid stored review for managed summary.', 'CONFLICT');
    const full = round.source === 'structured' && !round.findingsTruncated;
    const counts = { sev1: 0, sev2: 0, sev3: 0, sev4: 0 };
    for (const finding of round.findings) counts[finding.severity]++;
    const outcomes: Record<Round['verdict'], { label: string; alert: string }> = {
        changes_requested: { label: 'Changes requested', alert: 'CAUTION' },
        concerns_to_verify: { label: 'Concerns to verify', alert: 'WARNING' },
        non_blocking: { label: 'Non-blocking findings', alert: 'NOTE' },
        no_findings: { label: 'No actionable findings identified', alert: 'TIP' },
        inconclusive: { label: 'Inconclusive review', alert: 'WARNING' },
    };
    const outcome = outcomes[round.verdict];
    const severities = ([
        [counts.sev1, 'Sev1'], [counts.sev2, 'Sev2'],
        [counts.sev3, 'Sev3'], [counts.sev4, 'Sev4'],
    ] as const).filter(([count]) => count > 0)
        .map(([count, severity]) => count + ' ' + severity).join(' · ') || '0 findings';
    const visible = full ? round.findings.slice(0, 5) : [];
    const lines = [
        '## 🔎 Atlas Code Review · PR #' + prNumber,
        '',
        '> [!' + outcome.alert + ']',
        '> **' + outcome.label + '**' + (full ? ' · ' + severities : ' · Partial evidence'),
        '',
        '**Reviewed head:** ' + inlineCode(round.headSha.slice(0, 7), 7) +
            ' · **Saved rounds:** ' + savedRounds +
            ' · **Source:** ' + (full ? 'Structured review' : 'Partial / historical'),
        ...(full ? [
            '**Latest round:** ' + severities +
                ' · **Reviewer-asserted fixes:** ' + round.resolutions.length,
            ...visible.map(finding => '- **' + finding.severity.toUpperCase() + '** ' +
                inlineText(finding.title, 200) +
                (finding.filePath ? ' — ' + inlineCode(finding.filePath, 1_024) : '') +
                (finding.line ? ':' + finding.line : '')),
            ...(round.findings.length > visible.length ?
                ['- +' + (round.findings.length - visible.length) +
                    ' more findings in Atlas / inline discussions'] : []),
        ] : ['**Finding counts:** unavailable for this partial review. See Atlas for evidence.']),
        '',
        '_Latest saved review only; missing findings are not proof of a fix. ' +
            'Reviewer-assessed fixes and GitHub conversation resolution are separate._',
        '',
        marker,
    ];
    const body = lines.join('\n');
    if (body.length > 26_000) throw new AtlasError('Managed summary exceeds safe GitHub body size.', 'CAPABILITY_UNAVAILABLE');
    return { body, marker, fullEvidence: full, reviewedHeadSha: round.headSha,
        runId: round.runId, recordedRounds: savedRounds };
}

type MatchingComment = { id: number; body: string; url: string };
/** Read only. A marker is not ownership: verify the actual App Bot user ID.
 * Never accept a partial list as proof that a managed summary does not exist.
 */
export class GitHubManagedSummaryReader {
    constructor(private readonly broker: Bot, private readonly http: typeof fetch = fetch) {}

    async inspect(repository: string, prNumber: number, expectedBody: string) {
        const marker = managedSummaryMarker(repository, prNumber);
        repository = canonicalRepository(repository);
        if (!expectedBody.endsWith(marker) || expectedBody.split(marker).length !== 2)
            throw new AtlasError('Managed summary preview has an invalid identity marker.', 'CONFLICT');
        const token = await this.broker.pullRequestReadToken(repository);
        const bot = await this.broker.reviewPublisherBot(repository);
        if (!safeNumber(bot.id))
            throw new AtlasError('GitHub App bot identity could not be verified.', 'GITHUB_REQUEST_FAILED');

        const matched: MatchingComment[] = [];
        for (let page = 1; page <= 5; page++) {
            let response: Response;
            try {
                response = await this.http('https://api.github.com/repos/' + repository +
                    '/issues/' + prNumber + '/comments?per_page=100&page=' + page, {
                    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
                    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28' },
                });
            } catch {
                throw new AtlasError('GitHub managed comment lookup is unavailable.', 'GITHUB_UNAVAILABLE');
            }
            if (!response.ok)
                throw new AtlasError('GitHub managed comment lookup returned HTTP ' +
                    response.status + '.', 'GITHUB_REQUEST_FAILED');
            let data: unknown;
            try { data = await response.json(); }
            catch { throw new AtlasError('GitHub managed comment lookup returned invalid JSON.', 'GITHUB_REQUEST_FAILED'); }
            if (!Array.isArray(data) || data.length > 100)
                throw new AtlasError('Incomplete GitHub PR comment list.', 'GITHUB_REQUEST_FAILED');

            for (const value of data) {
                if (!record(value) || typeof value.body !== 'string' || !value.body.includes(marker))
                    continue;
                // Another GitHub user copying this marker is not proof of ownership.
                const author = record(value.user) ? value.user : {};
                if (author.id !== bot.id || author.type !== 'Bot') continue;
                if (!safeNumber(value.id) || !safeText(value.body, 65_000) ||
                    !value.body.endsWith(marker) || value.body.split(marker).length !== 2)
                    throw new AtlasError('App-owned managed summary has invalid identity or content.', 'CONFLICT');
                matched.push({ id: value.id, body: value.body,
                    url: `https://github.com/${repository}/pull/${prNumber}#issuecomment-${value.id}` });
            }
            if (data.length < 100) {
                if (matched.length > 1)
                    throw new AtlasError('Multiple App-owned managed PR summaries exist.', 'CONFLICT');
                const found = matched[0];
                return found ? { status: found.body === expectedBody ? 'current' : 'needs_update',
                    commentId: found.id, commentUrl: found.url,
                    bodySha256: createHash('sha256').update(found.body).digest('hex') } :
                    { status: 'no_owned_comment' };
            }
        }
        throw new AtlasError('GitHub PR comments exceed safe inspection window.', 'CAPABILITY_UNAVAILABLE');
    }
}

/** Read-only preflight for a future one-comment-per-PR publisher. Does not create
 * durable claims, upload anything or enable the existing per-run publisher.
 */
export class ManagedSummaryPreviewService {
    constructor(private readonly catalog: Reader,
        private readonly github: Pick<GitHubManagedSummaryReader, 'inspect'>) {}
    async preview(repository: string, prNumber: number) {
        managedSummaryMarker(repository, prNumber);
        repository = canonicalRepository(repository);
        const stores = await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs = stores.find(s => s.name === REVIEW_RUNS_STORE);
        const findings = stores.find(s => s.name === REVIEW_FINDINGS_STORE);
        if (!runs || !findings)
            throw new AtlasError('Code Reviews Stores unavailable.', 'CAPABILITY_UNAVAILABLE');
        const saved = await readPrTimeline(this.catalog, { runs: runs.id, findings: findings.id },
            repository, prNumber, 1, 0, true);
        const latest = saved.rounds[0];
        if (!latest) return { repository, prNumber, recordedRounds: saved.recordedRounds,
            status: 'no_saved_review', publishSupported: false, dryRun: true };
        const rendered = renderManagedSummary(repository, prNumber, latest, saved.recordedRounds);
        const remote = await this.github.inspect(repository, prNumber, rendered.body);
        return { repository, prNumber, dryRun: true, publishSupported: false,
            ...rendered, remote, source: latest.source, previewBody: rendered.body,
            // Even a current owned comment is not proof of a durable publish receipt.
            publicationVerified: false };
    }
}
