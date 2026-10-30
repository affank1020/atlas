import { createHash, randomUUID } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';
import type { AtlasData, AtlasRecord } from '../types.js';
import type { CoreService } from '../core/service.js';
import type { ApplicationCaller } from './registry.js';
import { assertStructuredCaller } from './review-submission.js';
import { CODE_REVIEWS_PROJECT_ID, REVIEW_FINDINGS_STORE, REVIEW_RUNS_STORE } from './review-import.js';
import { canonicalRepository } from './managed-summary.js';
import { inlineThreadMarker, type GitHubInlineThreadReader } from './inline-thread-inventory.js';
import type { InlineThreadPreflightService } from './inline-thread-preflight.js';
import type { InlineThreadInventoryService } from './inline-thread-inventory.js';
import type { GitHubInlineRootWriter } from './inline-thread-writer.js';

type Catalogue = Pick<CoreService, 'store' | 'listStores' | 'updateRecordInState'>;
type Preflight = Awaited<ReturnType<InlineThreadPreflightService['preview']>>;
type Inventory = Awaited<ReturnType<InlineThreadInventoryService['preview']>>;
type Stores = { runs: string; findings: string };
type Identity = Stores & { repository: string; prNumber: number };
type Claim = {
    state: 'claimed' | 'published'; claimId: string; findingId: string;
    marker: string; bodySha256: string; headSha: string;
    path: string; line: number; claimedAt: string; rootCommentId?: number;
};
const obj = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const markdown = (value: string, limit: number) => value.slice(0, limit)
    .replace(/[\r\n\t\u2028\u2029]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~\-])/g, '\\$1');

function parseClaim(finding: AtlasRecord): Claim | undefined {
    const evidence = finding.data.evidence;
    const raw = obj(evidence) ? evidence.githubInlineThread : undefined;
    if (raw === undefined) return undefined;
    if (!obj(raw) || !['claimed', 'published'].includes(String(raw.state)) ||
        typeof raw.claimId !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.claimId) ||
        raw.findingId !== finding.id ||
        typeof raw.marker !== 'string' || !/^<!-- atlas-code-reviews-thread:v1:[a-f0-9]{64} -->$/.test(raw.marker) ||
        typeof raw.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.bodySha256) ||
        typeof raw.headSha !== 'string' || !/^[a-f0-9]{40}$/.test(raw.headSha) ||
        typeof raw.path !== 'string' || !raw.path || raw.path.length > 1024 ||
        !positive(raw.line) || typeof raw.claimedAt !== 'string' ||
        (raw.rootCommentId !== undefined && !positive(raw.rootCommentId)) ||
        (raw.state === 'published' && !positive(raw.rootCommentId)))
        throw new AtlasError('Stored inline thread publication claim is malformed.', 'CONFLICT');
    return raw as Claim;
}

function render(finding: AtlasRecord, marker: string) {
    const data = finding.data;
    if (typeof data.title !== 'string' || typeof data.description !== 'string' ||
        typeof data.severity !== 'string' ||
        !['sev1', 'sev2', 'sev3', 'sev4'].includes(data.severity))
        throw new AtlasError('Inline finding has unsupported body metadata.', 'CONFLICT');
    const body = '**' + data.severity.toUpperCase() + ' · ' +
        markdown(data.title, 200) + '**\n\n' + markdown(data.description, 4_000) +
        '\n\n_Atlas Code Reviews · source finding ' + finding.id + '_\n\n' + marker;
    if (body.length > 8_000) throw new AtlasError('Inline thread comment exceeds safe size.', 'CONFLICT');
    return body;
}

/** Create exactly one initial GitHub inline root for an explicitly lineage-keyed
 * new finding. Never publish replies, reviews, resolutions or a second root.
 * Claims are stored against the finding and fenced across all PR rounds.
 */
export class InlineRootPublicationService {
    constructor(private readonly catalog: Catalogue,
        private readonly preflight: Pick<InlineThreadPreflightService, 'preview'>,
        private readonly inventory: Pick<InlineThreadInventoryService, 'preview'>,
        private readonly github: Pick<GitHubInlineRootWriter, 'checkHead' | 'prepareWrite' | 'post'>,
        private readonly enabled: ReadonlySet<string> = new Set(),
        private readonly ownedRoots?: Pick<GitHubInlineThreadReader, 'inspect'>) {}

    private async storeIds(): Promise<Stores> {
        const rows = await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs = rows.find(x => x.name === REVIEW_RUNS_STORE);
        const findings = rows.find(x => x.name === REVIEW_FINDINGS_STORE);
        if (!runs || !findings)
            throw new AtlasError('Code Reviews Stores unavailable.', 'CAPABILITY_UNAVAILABLE');
        return { runs: runs.id, findings: findings.id };
    }

    private related(state: AtlasData, identity: Identity) {
        const runs = state.records.filter(r => r.projectId === CODE_REVIEWS_PROJECT_ID &&
            r.storeId === identity.runs && typeof r.data.repository === 'string' &&
            r.data.repository.toLowerCase() === identity.repository &&
            r.data.prNumber === identity.prNumber);
        const byRun = new Map(runs.map(r => [r.id, r]));
        const findings = state.records.filter(r => r.projectId === CODE_REVIEWS_PROJECT_ID &&
            r.storeId === identity.findings && byRun.has(String(r.data.reviewRunId)));
        return { runs, findings, byRun };
    }

    private fingerprint(state: AtlasData, identity: Identity) {
        const { runs, findings } = this.related(state, identity);
        return digest({ runs: [...runs].sort((a, b) => a.id.localeCompare(b.id)),
            findings: [...findings].sort((a, b) => a.id.localeCompare(b.id)) });
    }

    private plan(state: AtlasData, identity: Identity, findingId: string,
        preview: Preflight, remote: Inventory, caller: ApplicationCaller) {
        const related = this.related(state, identity);
        const sorted = related.runs.filter(r => !r.archivedAt)
            .sort((a, b) => String(b.data.reviewedAt).localeCompare(String(a.data.reviewedAt)) ||
                a.id.localeCompare(b.id));
        const run = sorted[0];
        const finding = related.findings.find(f => f.id === findingId && !f.archivedAt);
        if (!run || !finding || finding.data.reviewRunId !== run.id ||
            !('runId' in preview) || preview.runId !== run.id ||
            !('runId' in remote) || remote.runId !== run.id ||
            sorted.length !== preview.recordedRounds || sorted.length !== remote.recordedRounds)
            throw new AtlasError('Latest saved PR findings or lineage changed during publication.', 'CONFLICT');
        const coverage = run.data.coverage;
        const actor = obj(coverage) && obj(coverage.authenticatedCaller) ? coverage.authenticatedCaller : null;
        if (!obj(coverage) || coverage.source !== 'atlas_structured_submission' ||
            typeof coverage.submissionId !== 'string' ||
            typeof coverage.payloadSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(coverage.payloadSha256) ||
            !actor || actor.kind !== caller.kind || actor.subject !== caller.subject ||
            actor.issuer !== caller.issuer || coverage.githubPublication !== undefined)
            throw new AtlasError('Only unpublished native reviews from their authenticated submitter can create inline roots.', 'WORKSPACE_DENIED');
        if (remote.completeStructuredEvidence !== true ||
            preview.reviewedHeadSha !== run.data.headSha ||
            remote.reviewedHeadSha !== run.data.headSha)
            throw new AtlasError('Inline publication requires a complete recorded review.', 'CONFLICT');
        const target = preview.findings.find(f => f.findingId === findingId);
        const match = remote.findings.find(f => f.findingId === findingId);
        if (!target || !match || !('lineageKey' in target) || !target.lineageKey ||
            !('lineageKey' in match) || match.lineageKey !== target.lineageKey ||
            typeof finding.data.filePath !== 'string' || !positive(finding.data.line) ||
            target.path !== finding.data.filePath || target.line !== finding.data.line)
            throw new AtlasError('Finding has no verified new inline root target or already has a thread.', 'CONFLICT');
        const evidence = finding.data.evidence;
        if (!obj(evidence) || evidence.source !== 'atlas_structured_submission' ||
            typeof evidence.localKey !== 'string' ||
            finding.data.findingKey !== 'structured:' + coverage.submissionId + ':' + evidence.localKey ||
            evidence.lineageKey !== target.lineageKey ||
            finding.data.state !== 'new')
            throw new AtlasError('Only trusted new structured lineage can create a root.', 'CONFLICT');
        const marker = inlineThreadMarker(identity.repository, identity.prNumber, target.lineageKey);
        const peers = related.findings.filter(item => obj(item.data.evidence) &&
            item.data.evidence.lineageKey === target.lineageKey);
        // A prior publication for the same lineage MUST never be re-created.
        const claimed = peers.map(item => ({ item, claim: parseClaim(item) }))
            .filter(entry => entry.claim !== undefined);
        if (claimed.length > 1)
            throw new AtlasError('Multiple inline publication claims share one lineage.', 'CONFLICT');
        if (claimed[0]?.claim?.marker !== undefined && claimed[0].claim.marker !== marker)
            throw new AtlasError('Inline root publication claim has mismatched lineage.', 'CONFLICT');
        // A prior claim can be reconciled even after the GitHub head advances.
        // Only a brand-new POST demands the current open head and valid diff.
        if (!claimed.length && (preview.status !== 'review_head_current' ||
            preview.completeStructuredEvidence !== true ||
            target.classification !== 'candidate' || match.state !== 'no_owned_thread'))
            throw new AtlasError('New inline root requires a current unoccupied diff anchor.', 'CONFLICT');
        const body = render(finding, marker);
        return { run, finding, marker, body, bodySha256: sha(body),
            prior: claimed[0]?.claim, priorFinding: claimed[0]?.item };
    }

    private writeClaim(state: AtlasData, identity: Identity, findingId: string, claim?: Claim) {
        const found = state.records.find(r => r.id === findingId && r.projectId === CODE_REVIEWS_PROJECT_ID &&
            r.storeId === identity.findings && !r.archivedAt);
        if (!found || !obj(found.data.evidence))
            throw new AtlasError('Inline publication finding was changed or archived.', 'CONFLICT');
        const { githubInlineThread: _previous, ...evidence } = found.data.evidence;
        this.catalog.updateRecordInState(state, {
            projectId: CODE_REVIEWS_PROJECT_ID, storeId: identity.findings,
            recordId: findingId, client: 'atlas-inline-review-root',
            data: { evidence: { ...evidence, ...(claim ? { githubInlineThread: claim } : {}) } },
        });
    }

    /** A saved claim can be reconciled by its original finding ID even if a
     * newer round has replaced the latest finding or the PR head has advanced.
     * Only the real Bot-root inventory can attest a match; no GitHub writes.
     */
    private async reconcileClaim(identity: Identity, finding: AtlasRecord,
        claim: Claim, caller: ApplicationCaller, apply: boolean) {
        if (!this.ownedRoots)
            throw new AtlasError('Inline root ownership reconciliation is unavailable.', 'CAPABILITY_UNAVAILABLE');
        const saved = await this.catalog.store.snapshot();
        const related = this.related(saved, identity);
        const stored = related.findings.find(f => f.id === finding.id);
        const run = stored && related.byRun.get(String(stored.data.reviewRunId));
        const actor = run && obj(run.data.coverage) && obj(run.data.coverage.authenticatedCaller)
            ? run.data.coverage.authenticatedCaller : null;
        if (!stored || !run || !actor || actor.kind !== caller.kind ||
            actor.subject !== caller.subject || actor.issuer !== caller.issuer ||
            parseClaim(stored)?.claimId !== claim.claimId)
            throw new AtlasError('Inline publication receipt belongs to another owner or changed.', 'CONFLICT');
        const remote = await this.ownedRoots.inspect(identity.repository, identity.prNumber);
        const root = remote.roots.find(item => item.marker === claim.marker);
        const verified = root && root.bodySha256 === claim.bodySha256 &&
            root.originalCommitSha === claim.headSha &&
            root.originalLine === claim.line && root.path === claim.path &&
            (!claim.rootCommentId || root.id === claim.rootCommentId);
        if (!verified) return { status: claim.state === 'published' ?
            'published_remote_drift' : 'uncertain', findingId: finding.id,
            dryRun: true, postedAgain: false };
        if (apply && claim.state === 'claimed') await this.catalog.store.transaction(state => {
            const candidate = this.related(state, identity).findings.find(f => f.id === finding.id);
            const pending = candidate && parseClaim(candidate);
            if (!candidate || pending?.state !== 'claimed' || pending.claimId !== claim.claimId)
                throw new AtlasError('Inline publication claim changed during reconciliation.', 'CONFLICT');
            this.writeClaim(state, identity, finding.id, { ...pending,
                state: 'published', rootCommentId: root!.id });
        });
        return { status: 'published', dryRun: !apply, findingId: finding.id,
            rootCommentId: root!.id, alreadyPublished: claim.state === 'published',
            postedAgain: false };
    }

    async publish(repository: string, prNumber: number, findingId: string, apply: boolean,
        caller?: ApplicationCaller) {
        assertStructuredCaller(caller);
        repository = canonicalRepository(repository);
        if (!this.enabled.has(repository))
            throw new AtlasError('Initial inline root publication is disabled for this repository.', 'CAPABILITY_UNAVAILABLE');
        const identity: Identity = { ...(await this.storeIds()), repository, prNumber };
        const initial = await this.catalog.store.snapshot();
        const previous = this.related(initial, identity).findings.find(f => f.id === findingId);
        const savedClaim = previous && parseClaim(previous);
        if (savedClaim) return this.reconcileClaim(identity, previous!, savedClaim, caller!, apply);
        const fingerprint = this.fingerprint(initial, identity);
        const [preflight, remote] = await Promise.all([
            this.preflight.preview(repository, prNumber),
            this.inventory.preview(repository, prNumber),
        ]);
        const planned = this.plan(initial, identity, findingId, preflight, remote, caller!);
        const root = remote.findings.find(f => f.findingId === findingId);
        const prior = planned.prior;
        if (prior) {
            // A prior claimed write can only be reconciled, never retried.
            const matches = root?.state === 'owned_thread_found' &&
                root.bodySha256 === prior.bodySha256 &&
                root.originalCommitSha === prior.headSha &&
                root.path === prior.path && root.originalLine === prior.line &&
                positive(root.rootCommentId) &&
                (prior.rootCommentId === undefined || prior.rootCommentId === root.rootCommentId);
            if (!matches)
                return { status: prior.state === 'published' ? 'published_remote_drift' : 'uncertain',
                    findingId, dryRun: true, postedAgain: false };
            if (apply && prior.state === 'claimed') await this.catalog.store.transaction(state => {
                const found = this.related(state, identity).findings.find(f => f.id === planned.priorFinding?.id);
                if (!found || parseClaim(found)?.claimId !== prior.claimId ||
                    parseClaim(found)?.state !== 'claimed')
                    throw new AtlasError('Inline claim changed during remote reconciliation.', 'CONFLICT');
                this.writeClaim(state, identity, found.id, { ...prior, state: 'published',
                    rootCommentId: root.rootCommentId });
            });
            return { status: 'published', dryRun: !apply, findingId, alreadyPublished: true,
                rootCommentId: root!.rootCommentId, postedAgain: false };
        }
        if (root?.state !== 'no_owned_thread')
            throw new AtlasError('Unclaimed or ambiguous GitHub inline thread already exists.', 'CONFLICT');
        const result = { status: 'ready', dryRun: !apply, findingId, repository, prNumber,
            reviewedHeadSha: planned.run.data.headSha, path: planned.finding.data.filePath,
            line: planned.finding.data.line, previewBody: planned.body };
        if (!apply) return result;

        // Both checks are before any POST: a failed second GET can release its
        // exact claim, but a failed POST must remain claimed indefinitely.
        await this.github.checkHead(repository, prNumber, planned.run.data.headSha as string);
        const token = await this.github.prepareWrite(repository);
        const claim: Claim = {
            state: 'claimed', claimId: randomUUID(), findingId,
            marker: planned.marker, bodySha256: planned.bodySha256,
            headSha: planned.run.data.headSha as string,
            path: planned.finding.data.filePath as string,
            line: planned.finding.data.line as number,
            claimedAt: new Date().toISOString(),
        };
        await this.catalog.store.transaction(state => {
            if (this.fingerprint(state, identity) !== fingerprint)
                throw new AtlasError('Inline review or publication claim changed during preflight.', 'CONFLICT');
            const current = this.plan(state, identity, findingId, preflight, remote, caller!);
            if (current.prior || current.bodySha256 !== planned.bodySha256)
                throw new AtlasError('Inline root was already claimed.', 'CONFLICT');
            this.writeClaim(state, identity, findingId, claim);
        });
        try {
            await this.github.checkHead(repository, prNumber, claim.headSha);
        } catch (error) {
            // No remote write started: release ONLY this claim under the Store lock.
            try {
                await this.catalog.store.transaction(state => {
                    const current = this.related(state, identity).findings.find(f => f.id === findingId);
                    if (!current || parseClaim(current)?.claimId !== claim.claimId ||
                        parseClaim(current)?.state !== 'claimed')
                        throw new AtlasError('Pre-write inline claim changed before release.', 'CONFLICT');
                    this.writeClaim(state, identity, findingId);
                });
            } catch {
                return { status: 'prewrite_recovery_required', dryRun: false,
                    findingId, postedAgain: false };
            }
            throw error;
        }
        try {
            const postedId = await this.github.post(repository, prNumber, claim, planned.body, token);
            const verified = await this.inventory.preview(repository, prNumber);
            const found = verified.findings.find(f => f.findingId === findingId);
            if (found?.state !== 'owned_thread_found' ||
                found.rootCommentId !== postedId ||
                found.bodySha256 !== claim.bodySha256 ||
                found.originalCommitSha !== claim.headSha ||
                found.originalLine !== claim.line || found.path !== claim.path)
                throw new AtlasError('GitHub inline root was not independently verified.', 'CONFLICT');
            await this.catalog.store.transaction(state => {
                const current = this.related(state, identity).findings.find(f => f.id === findingId);
                if (!current || parseClaim(current)?.claimId !== claim.claimId ||
                    parseClaim(current)?.state !== 'claimed')
                    throw new AtlasError('Inline publication claim changed before receipt.', 'CONFLICT');
                this.writeClaim(state, identity, findingId,
                    { ...claim, state: 'published', rootCommentId: postedId });
            });
            return { ...result, status: 'published', dryRun: false, rootCommentId: postedId };
        } catch {
            return { ...result, status: 'uncertain', dryRun: false, postedAgain: false,
                message: 'Claim retained; never automatically POST this inline root again.' };
        }
    }
}
