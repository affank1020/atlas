import { createHash } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { GitHubBroker } from '../workspaces/github-broker.js';
import { canonicalRepository } from './managed-summary.js';
import { CODE_REVIEWS_PROJECT_ID, REVIEW_FINDINGS_STORE, REVIEW_RUNS_STORE } from './review-import.js';
import { readPrTimeline } from './review-timeline.js';

type Reader = Pick<CoreService, 'listStores' | 'queryRecords'>;
type Broker = Pick<GitHubBroker, 'pullRequestReadToken' | 'reviewPublisherBot'>;
type Round = Awaited<ReturnType<typeof readPrTimeline>>['rounds'][number];
type ThreadRoot = {
    id: number; marker: string; path: string; originalCommitSha: string | null;
    originalLine: number | null; currentLine: number | null; url: string;
};
type Inventory = { roots: ThreadRoot[]; copiedMarkers: string[]; replies: Map<number, number> };
const lineagePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const markerPattern = /<!-- atlas-code-reviews-thread:v1:([a-f0-9]{64}) -->/g;
const shaPattern = /^[a-f0-9]{40}$/i;
const positive = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);

/** Opaque marker derived from the full canonical PR identity and a reviewer-
 * asserted stable root-cause key. Do not use titles or moving line numbers.
 * This marker is NOT ownership: only the verified App Bot ID is trusted.
 */
export function inlineThreadMarker(repository: string, prNumber: number, lineageKey: string) {
    repository = canonicalRepository(repository);
    if (!positive(prNumber) || prNumber > 1_000_000 || !lineagePattern.test(lineageKey))
        throw new AtlasError('Invalid managed inline thread identity.', 'INVALID_REQUEST');
    const identity = JSON.stringify([repository, prNumber, lineageKey]);
    const digest = createHash('sha256').update('atlas-code-reviews-thread:v1:' + identity).digest('hex');
    return '<!-- atlas-code-reviews-thread:v1:' + digest + ' -->';
}

/** The GitHub review-comments REST API lists root inline comments and replies.
 * Read ALL bounded pages before making any claim about missing/unique roots.
 * External marker copies are not trusted; ambiguous App Bot roots fail closed.
 */
export class GitHubInlineThreadReader {
    constructor(private readonly broker: Broker, private readonly http: typeof fetch = fetch) {}

    async inspect(repository: string, prNumber: number): Promise<Inventory> {
        repository = canonicalRepository(repository);
        if (!positive(prNumber) || prNumber > 1_000_000)
            throw new AtlasError('Invalid managed inline thread PR number.', 'INVALID_REQUEST');
        const token = await this.broker.pullRequestReadToken(repository);
        const bot = await this.broker.reviewPublisherBot(repository);
        if (!positive(bot.id))
            throw new AtlasError('GitHub inline thread Bot identity is unavailable.', 'GITHUB_REQUEST_FAILED');

        const roots: ThreadRoot[] = [];
        const copiedMarkers: string[] = [];
        const replies = new Map<number, number>();
        const seenIds = new Set<number>();
        const seenOwnedMarkers = new Set<string>();
        for (let page = 1; page <= 5; page++) {
            let response: Response;
            try {
                response = await this.http('https://api.github.com/repos/' + repository +
                    '/pulls/' + prNumber + '/comments?per_page=100&page=' + page, {
                    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
                    headers: { Authorization: 'Bearer ' + token,
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28' },
                });
            } catch {
                throw new AtlasError('GitHub inline thread inspection is unavailable.', 'GITHUB_UNAVAILABLE');
            }
            if (!response.ok)
                throw new AtlasError('GitHub inline thread inspection returned HTTP ' +
                    response.status + '.', 'GITHUB_REQUEST_FAILED');
            let raw: unknown;
            try { raw = await response.json(); }
            catch {
                throw new AtlasError('GitHub inline thread inspection returned invalid JSON.', 'GITHUB_REQUEST_FAILED');
            }
            if (!Array.isArray(raw) || raw.length > 100)
                throw new AtlasError('GitHub inline thread page is incomplete.', 'GITHUB_REQUEST_FAILED');

            for (const entry of raw) {
                if (!object(entry) || !positive(entry.id) || seenIds.has(entry.id))
                    throw new AtlasError('GitHub inline thread IDs are invalid or duplicated.', 'CONFLICT');
                seenIds.add(entry.id);
                if (entry.in_reply_to_id !== undefined && entry.in_reply_to_id !== null) {
                    if (!positive(entry.in_reply_to_id) || entry.in_reply_to_id === entry.id)
                        throw new AtlasError('GitHub inline reply has invalid parent identity.', 'CONFLICT');
                    replies.set(entry.in_reply_to_id, (replies.get(entry.in_reply_to_id) ?? 0) + 1);
                }
                const author = object(entry.user) ? entry.user : {};
                const owned = author.id === bot.id && author.type === 'Bot';
                if (typeof entry.body !== 'string') {
                    if (owned) throw new AtlasError('App-owned GitHub inline comment has no body.', 'CONFLICT');
                    continue;
                }
                const matches = [...entry.body.matchAll(markerPattern)];
                if (!matches.length) {
                    if (owned && entry.body.includes('<!-- atlas-code-reviews-thread:'))
                        throw new AtlasError('App-owned inline marker has an unsupported format.', 'CONFLICT');
                    continue;
                }
                const marker = matches[0]![0];
                if (!owned) {
                    // A user or another Bot may copy the marker, but is not its owner.
                    for (const match of matches) copiedMarkers.push(match[0]);
                    continue;
                }
                if (matches.length !== 1 || !entry.body.endsWith(marker) ||
                    entry.body.length > 65_000 || seenOwnedMarkers.has(marker) ||
                    (entry.in_reply_to_id !== undefined && entry.in_reply_to_id !== null) ||
                    typeof entry.path !== 'string' || !entry.path || entry.path.length > 1_024 ||
                    (entry.original_commit_id != null &&
                        (typeof entry.original_commit_id !== 'string' ||
                         !shaPattern.test(entry.original_commit_id))) ||
                    (entry.original_line != null && !positive(entry.original_line)) ||
                    (entry.line != null && !positive(entry.line)))
                    throw new AtlasError('App-owned GitHub inline root has conflicting identity.', 'CONFLICT');
                seenOwnedMarkers.add(marker);
                roots.push({
                    id: entry.id, marker, path: entry.path,
                    originalCommitSha: typeof entry.original_commit_id === 'string'
                        ? entry.original_commit_id.toLowerCase() : null,
                    originalLine: positive(entry.original_line) ? entry.original_line : null,
                    currentLine: positive(entry.line) ? entry.line : null,
                    url: 'https://github.com/' + repository + '/pull/' + prNumber +
                        '#discussion_r' + entry.id,
                });
            }
            if (raw.length < 100) {
                // Every reply parent must exist in this complete PR comment set.
                // Otherwise it is unsafe to conclude a managed thread is unique.
                if ([...replies.keys()].some(id => !seenIds.has(id)))
                    throw new AtlasError('GitHub inline thread reply references an absent root.', 'CONFLICT');
                return { roots, copiedMarkers, replies };
            }
        }
        throw new AtlasError('GitHub inline thread inventory exceeds five complete pages.',
            'CAPABILITY_UNAVAILABLE');
    }
}

/** Read-only identity reconciliation. A root comment's marker and verified
 * author link to an explicit lineage, never its title, location or text.
 * We do not claim a GitHub discussion is resolved from REST comment status.
 */
export class InlineThreadInventoryService {
    constructor(private readonly catalog: Reader,
        private readonly github: Pick<GitHubInlineThreadReader, 'inspect'>) {}

    async preview(repository: string, prNumber: number) {
        repository = canonicalRepository(repository);
        if (!positive(prNumber) || prNumber > 1_000_000)
            throw new AtlasError('Invalid inline thread inventory PR number.', 'INVALID_REQUEST');
        const stores = await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs = stores.find(store => store.name === REVIEW_RUNS_STORE);
        const findings = stores.find(store => store.name === REVIEW_FINDINGS_STORE);
        if (!runs || !findings)
            throw new AtlasError('Code Reviews Stores unavailable.', 'CAPABILITY_UNAVAILABLE');

        const saved = await readPrTimeline(this.catalog, { runs: runs.id, findings: findings.id },
            repository, prNumber, 1, 0, true);
        const latest: Round | undefined = saved.rounds[0];
        if (!latest) return {
            repository, prNumber, status: 'no_saved_review', recordedRounds: saved.recordedRounds,
            dryRun: true, publicationSupported: false, findings: [], resolutions: [],
        };
        const inventory = await this.github.inspect(repository, prNumber);
        const roots = new Map(inventory.roots.map(root => [root.marker, root]));
        const copies = new Set(inventory.copiedMarkers);
        const match = (key: string | null) => {
            if (!key) return { state: 'missing_stable_lineage' as const };
            const marker = inlineThreadMarker(repository, prNumber, key);
            const root = roots.get(marker);
            return root
                ? { state: 'owned_thread_found' as const, rootCommentId: root.id,
                    rootUrl: root.url, originalCommitSha: root.originalCommitSha,
                    originalLine: root.originalLine,
                    currentLine: root.currentLine,
                    observedReplyCount: inventory.replies.get(root.id) ?? 0,
                    resolutionState: 'unknown' as const }
                : { state: 'no_owned_thread' as const,
                    copiedMarkerFromOtherAuthor: copies.has(marker) };
        };
        // Historical imports cannot assert stable lineage from imported Markdown.
        const full = latest.source === 'structured' && !latest.findingsTruncated;
        const linkedMarkers = new Set([
            ...latest.findings.map(f => f.lineageKey),
            ...latest.resolutions.map(r => r.lineageKey),
        ].filter((value): value is string => typeof value === 'string')
            .map(key => inlineThreadMarker(repository, prNumber, key)));
        return {
            repository, prNumber, status: 'inventory_complete', recordedRounds: saved.recordedRounds,
            runId: latest.runId, reviewedHeadSha: latest.headSha,
            source: latest.source, completeStructuredEvidence: full,
            ownedRootCount: inventory.roots.length, dryRun: true, publicationSupported: false,
            findings: latest.findings.map(finding => ({
                findingId: finding.id, lineageKey: finding.lineageKey,
                findingState: finding.state,
                ...(full ? match(finding.lineageKey) :
                    { state: 'historical_or_partial_evidence' as const }),
            })),
            resolutions: latest.resolutions.map(resolution => ({
                lineageKey: resolution.lineageKey, assessment: 'reviewer_asserted_resolved' as const,
                ...match(resolution.lineageKey),
            })),
            // Markers for other, older lineages are retained and never deleted.
            unlinkedOwnedRootCount: inventory.roots.filter(root =>
                !linkedMarkers.has(root.marker)).length,
        };
    }
}
