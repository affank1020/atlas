import { createHash, randomUUID } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { AtlasData, AtlasRecord } from '../types.js';
import type { ApplicationCaller } from './registry.js';
import { assertStructuredCaller } from './review-submission.js';
import { canonicalRepository } from './managed-summary.js';
import { inlineThreadMarker, type GitHubInlineThreadReader } from './inline-thread-inventory.js';
import { GitHubInlineReplyRejectedError, type GitHubInlineRootWriter } from './inline-thread-writer.js';
import { CODE_REVIEWS_PROJECT_ID, REVIEW_RUNS_STORE, REVIEW_FINDINGS_STORE } from './review-import.js';
import { readPrTimeline } from './review-timeline.js';

type Catalogue = Pick<CoreService, 'store' | 'listStores' | 'queryRecords' | 'updateRecordInState'>;
type GitHub = Pick<GitHubInlineRootWriter, 'checkHead' | 'prepareWrite' | 'postReply'>;
type RootReader = Pick<GitHubInlineThreadReader, 'inspect'>;
type Identity = { runs: string; findings: string; repository: string; prNumber: number };
type Claim = {
    state: 'claimed' | 'published'; claimId: string; findingId: string;
    rootCommentId: number; rootMarker: string; rootBodySha256: string; marker: string;
    bodySha256: string; headSha: string; claimedAt: string; replyCommentId?: number;
};
const obj = (x: unknown): x is Record<string, unknown> =>
    typeof x === 'object' && x !== null && !Array.isArray(x);
const positive = (x: unknown): x is number =>
    typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const hash = (x: string) => createHash('sha256').update(x).digest('hex');
const markerPattern = /^<!-- atlas-code-reviews-(?:thread|reply):v1:[0-9a-f]{64} -->$/;
const escapeMarkdown = (x: string, max: number) => x.slice(0, max)
    .replace(/[\r\n\t\u2028\u2029]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~\-])/g, '\\$1');

/** Unique to one immutable observation on an existing root. Comment text,
 * moved lines and GitHub's thread-resolution UI do not determine identity.
 */
export function inlineReplyMarker(repository: string, prNumber: number,
    rootCommentId: number, findingId: string) {
    repository = canonicalRepository(repository);
    if (!positive(prNumber) || prNumber > 1_000_000 || !positive(rootCommentId) ||
        !/^[a-f0-9-]{36}$/i.test(findingId))
        throw new AtlasError('Invalid managed inline reply identity.', 'INVALID_REQUEST');
    const identity = JSON.stringify([repository, prNumber, rootCommentId, findingId]);
    return '<!-- atlas-code-reviews-reply:v1:' +
        hash('atlas-code-reviews-reply:v1:' + identity) + ' -->';
}

function parseReplyClaim(finding: AtlasRecord): Claim | undefined {
    const evidence = obj(finding.data.evidence) ? finding.data.evidence : {};
    const raw = evidence.githubInlineReply;
    if (raw === undefined) return undefined;
    if (!obj(raw) || !['claimed','published'].includes(String(raw.state)) ||
        typeof raw.claimId !== 'string' || !/^[a-f0-9-]{36}$/i.test(raw.claimId) ||
        raw.findingId !== finding.id || !positive(raw.rootCommentId) ||
        typeof raw.rootMarker !== 'string' || !/^<!-- atlas-code-reviews-thread:v1:[0-9a-f]{64} -->$/.test(raw.rootMarker) ||
        typeof raw.rootBodySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.rootBodySha256) ||
        typeof raw.marker !== 'string' || !/^<!-- atlas-code-reviews-reply:v1:[0-9a-f]{64} -->$/.test(raw.marker) ||
        typeof raw.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.bodySha256) ||
        typeof raw.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(raw.headSha) ||
        typeof raw.claimedAt !== 'string' ||
        (raw.replyCommentId !== undefined && !positive(raw.replyCommentId)) ||
        (raw.state === 'published' && !positive(raw.replyCommentId)))
        throw new AtlasError('Stored inline reply claim is malformed.', 'CONFLICT');
    return raw as Claim;
}

function renderReply(finding: AtlasRecord, evidence: string, headSha: string, marker: string) {
    if (typeof finding.data.title !== 'string' || !finding.data.title ||
        typeof finding.data.severity !== 'string' ||
        !['sev1','sev2','sev3','sev4'].includes(finding.data.severity))
        throw new AtlasError('Invalid persisted finding for inline reply.', 'CONFLICT');
    const body = '**Still present · ' + finding.data.severity.toUpperCase() + '** — ' +
        escapeMarkdown(finding.data.title, 200) + '\n\n' +
        escapeMarkdown(evidence, 4_000) + '\n\n_Reviewed commit ' +
        '`' + headSha + '` · Atlas finding ' + finding.id + '_\n\n' + marker;
    if (body.length > 8_000)
        throw new AtlasError('Managed inline reply is too large.', 'INVALID_REQUEST');
    return body;
}

/** Explicit one-shot replies to verified App-owned roots, not a GitHub thread
 * resolver. Re-review assertions are authenticated observations, not proof that
 * arbitrary code or GitHub's conversation state was independently verified.
 */
export class InlineReplyPublicationService {
    constructor(private readonly catalog: Catalogue, private readonly roots: RootReader,
        private readonly github: GitHub, private readonly enabled: ReadonlySet<string> = new Set()) {}

    private async storeIds(): Promise<{ runs: string; findings: string }> {
        const stores = await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs = stores.find(store => store.name === REVIEW_RUNS_STORE);
        const findings = stores.find(store => store.name === REVIEW_FINDINGS_STORE);
        if (!runs || !findings)
            throw new AtlasError('Code Reviews Stores unavailable.', 'CAPABILITY_UNAVAILABLE');
        return { runs: runs.id, findings: findings.id };
    }

    private related(state: AtlasData, id: Identity) {
        const runs = state.records.filter(r => r.projectId === CODE_REVIEWS_PROJECT_ID &&
            r.storeId === id.runs && typeof r.data.repository === 'string' &&
            r.data.repository.toLowerCase() === id.repository &&
            r.data.prNumber === id.prNumber && !r.archivedAt);
        const byRun = new Map(runs.map(run => [run.id, run]));
        const findings = state.records.filter(f => f.projectId === CODE_REVIEWS_PROJECT_ID &&
            f.storeId === id.findings && byRun.has(String(f.data.reviewRunId)) && !f.archivedAt);
        return { runs, findings, byRun };
    }

    private fingerprint(state: AtlasData, id: Identity) {
        const { runs, findings } = this.related(state, id);
        return digest({ runs: [...runs].sort((a,b) => a.id.localeCompare(b.id)),
            findings: [...findings].sort((a,b) => a.id.localeCompare(b.id)) });
    }

    private persist(state: AtlasData, id: Identity, finding: AtlasRecord, claim?: Claim) {
        const current = this.related(state, id).findings.find(f => f.id === finding.id);
        if (!current || !obj(current.data.evidence))
            throw new AtlasError('Inline reply observation disappeared.', 'CONFLICT');
        const { githubInlineReply: _previous, ...evidence } = current.data.evidence;
        this.catalog.updateRecordInState(state, {
            projectId: CODE_REVIEWS_PROJECT_ID, storeId: id.findings, recordId: current.id,
            client: 'atlas-inline-review-reply',
            data: { evidence: { ...evidence, ...(claim ? { githubInlineReply: claim } : {}) } },
        });
    }

    private plan(state: AtlasData, id: Identity, findingId: string,
        caller: ApplicationCaller, timelineRunId: string) {
        const related = this.related(state, id);
        const ordered = [...related.runs].sort((a,b) =>
            String(b.data.reviewedAt).localeCompare(String(a.data.reviewedAt)) ||
            a.id.localeCompare(b.id));
        const latest = ordered[0];
        const finding = related.findings.find(f => f.id === findingId);
        if (!latest || !finding || finding.data.reviewRunId !== latest.id ||
            latest.id !== timelineRunId)
            throw new AtlasError('Inline reply requires the latest complete re-review.', 'CONFLICT');
        const coverage = latest.data.coverage;
        const actor = obj(coverage) && obj(coverage.authenticatedCaller)
            ? coverage.authenticatedCaller : null;
        if (!obj(coverage) || coverage.source !== 'atlas_structured_submission' ||
            typeof coverage.submissionId !== 'string' ||
            typeof coverage.payloadSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(coverage.payloadSha256) || !actor ||
            actor.kind !== caller.kind || actor.subject !== caller.subject ||
            actor.issuer !== caller.issuer || coverage.githubPublication !== undefined)
            throw new AtlasError('Inline reply requires the submitting authenticated reviewer and native saved round.', 'WORKSPACE_DENIED');
        const ev = finding.data.evidence;
        if (!obj(ev) || ev.source !== 'atlas_structured_submission' ||
            typeof ev.localKey !== 'string' || typeof ev.lineageKey !== 'string' ||
            finding.data.findingKey !== 'structured:' + coverage.submissionId + ':' + ev.localKey ||
            finding.data.state !== 'persisting' || !obj(ev.lifecycleAssessment) ||
            ev.lifecycleAssessment.state !== 'persisting' ||
            ev.lifecycleAssessment.assessmentSource !== 'authenticated_structured_submission' ||
            ev.lifecycleAssessment.assessedHeadSha !== latest.data.headSha ||
            ev.lifecycleAssessment.assertedAt !== latest.data.reviewedAt ||
            typeof ev.lifecycleAssessment.evidence !== 'string' ||
            ev.lifecycleAssessment.evidence.trim().length < 20)
            throw new AtlasError('Only an evidence-backed persisting observation can reply.', 'CONFLICT');

        const predecessors = related.findings.filter(f => f.id !== finding.id &&
            obj(f.data.evidence) && f.data.evidence.lineageKey === ev.lineageKey &&
            f.data.reviewRunId !== latest.id);
        const roots = predecessors.filter(f => obj(f.data.evidence) &&
            obj(f.data.evidence.githubInlineThread));
        if (roots.length !== 1)
            throw new AtlasError('Exactly one earlier Atlas-published root is required.', 'CONFLICT');
        const predecessor = roots[0]!;
        const priorRun = related.byRun.get(String(predecessor.data.reviewRunId));
        const root = (predecessor.data.evidence as Record<string, unknown>).githubInlineThread;
        if (!priorRun || !obj(root) || root.state !== 'published' ||
            !positive(root.rootCommentId) || root.findingId !== predecessor.id ||
            typeof root.claimId !== 'string' || !/^[0-9a-f-]{36}$/i.test(root.claimId) ||
            typeof root.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(root.headSha) ||
            priorRun.data.headSha !== root.headSha ||
            root.headSha === latest.data.headSha ||
            typeof root.marker !== 'string' ||
            root.marker !== inlineThreadMarker(id.repository,id.prNumber,ev.lineageKey) ||
            typeof root.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(root.bodySha256) ||
            typeof root.path !== 'string' || !positive(root.line))
            throw new AtlasError('Previous root receipt is incomplete or review head was not advanced.', 'CONFLICT');
        if (typeof latest.data.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(latest.data.headSha))
            throw new AtlasError('Invalid reviewed SHA for inline reply.', 'CONFLICT');
        const marker = inlineReplyMarker(id.repository, id.prNumber, root.rootCommentId, finding.id);
        const body = renderReply(finding, ev.lifecycleAssessment.evidence,
            latest.data.headSha, marker);
        return { latest, finding, root, marker, body, bodySha256: hash(body) };
    }

    private attestRemote(remote: Awaited<ReturnType<RootReader['inspect']>>,
        claim: Claim) {
        const root = remote.roots.find(r => r.id === claim.rootCommentId &&
            r.marker === claim.rootMarker && r.bodySha256 === claim.rootBodySha256);
        const reply = remote.managedReplies.find(r => r.marker === claim.marker &&
            r.parentId === claim.rootCommentId);
        if (!root || remote.copiedReplyMarkers.includes(claim.marker))
            throw new AtlasError('Managed inline reply root or publisher is unverified.', 'CONFLICT');
        return reply && reply.bodySha256 === claim.bodySha256 &&
            (!claim.replyCommentId || reply.id === claim.replyCommentId) ? reply : null;
    }

    private async reconcile(id: Identity, finding: AtlasRecord,
        claim: Claim, caller: ApplicationCaller, apply: boolean) {
        const snapshot = await this.catalog.store.snapshot();
        const related = this.related(snapshot,id);
        const current = related.findings.find(f => f.id === finding.id);
        const run = current && related.byRun.get(String(current.data.reviewRunId));
        const actor = run && obj(run.data.coverage) && obj(run.data.coverage.authenticatedCaller)
            ? run.data.coverage.authenticatedCaller : null;
        if (!current || !actor || actor.kind !== caller.kind ||
            actor.subject !== caller.subject || actor.issuer !== caller.issuer ||
            parseReplyClaim(current)?.claimId !== claim.claimId)
            throw new AtlasError('Saved inline reply claim belongs to another reviewer or changed.', 'CONFLICT');
        const remote = await this.roots.inspect(id.repository,id.prNumber);
        const verified = this.attestRemote(remote,claim);
        if (!verified) return { status: claim.state === 'published' ?
            'published_remote_drift' : 'uncertain', findingId: finding.id,
            dryRun: true, postedAgain: false };
        if (apply && claim.state === 'claimed') await this.catalog.store.transaction(state => {
            const matching = this.related(state,id).findings.find(f => f.id === finding.id);
            const pending = matching && parseReplyClaim(matching);
            if (!matching || !pending || pending.state !== 'claimed' ||
                pending.claimId !== claim.claimId)
                throw new AtlasError('Inline reply claim changed before receipt.', 'CONFLICT');
            this.persist(state,id,matching,{ ...pending,state:'published',replyCommentId:verified.id });
        });
        return { status: 'published', dryRun: !apply, findingId: finding.id,
            rootCommentId: claim.rootCommentId, replyCommentId: verified.id,
            postedAgain: false, alreadyPublished: claim.state === 'published' };
    }

    async publish(repository: string, prNumber: number, findingId: string, apply: boolean,
        caller?: ApplicationCaller) {
        assertStructuredCaller(caller);
        repository = canonicalRepository(repository);
        if (!this.enabled.has(repository))
            throw new AtlasError('Inline replies are disabled for this repository.', 'CAPABILITY_UNAVAILABLE');
        const id: Identity = { ...(await this.storeIds()),repository,prNumber };
        const initial = await this.catalog.store.snapshot();
        const existing = this.related(initial,id).findings.find(f => f.id === findingId);
        const prior = existing && parseReplyClaim(existing);
        if (prior) return this.reconcile(id, existing!, prior, caller!, apply);
        const fingerprint = this.fingerprint(initial,id);
        const timeline = await readPrTimeline(this.catalog, id, repository,prNumber,1,0,true);
        if (!timeline.storedWindowComplete && timeline.rounds[0]?.findingsTruncated)
            throw new AtlasError('Latest review findings are incomplete.', 'CONFLICT');
        const latest = timeline.rounds[0];
        if (!latest || latest.source !== 'structured' ||
            latest.runId !== existing?.data.reviewRunId ||
            !latest.findings.some(f => f.id === findingId &&
                f.state === 'persisting' && f.lineageKey))
            throw new AtlasError('No complete latest structured persisting finding.', 'CONFLICT');
        const proposal = this.plan(initial,id,findingId,caller!,latest.runId);
        const remote = await this.roots.inspect(repository,prNumber);
        const ownedRoot = remote.roots.find(r =>
            r.id === proposal.root.rootCommentId &&
            r.marker === proposal.root.marker &&
            r.bodySha256 === proposal.root.bodySha256 &&
            r.originalCommitSha === proposal.root.headSha &&
            r.path === proposal.root.path && r.originalLine === proposal.root.line);
        if (!ownedRoot || remote.managedReplies.some(r=>r.marker===proposal.marker) ||
            remote.copiedReplyMarkers.includes(proposal.marker))
            throw new AtlasError('Original Bot-owned root or reply uniqueness cannot be verified.', 'CONFLICT');
        const ready = {
            status:'ready',dryRun:!apply,repository,prNumber,findingId,
            rootCommentId:ownedRoot.id,reviewedHeadSha:latest.headSha,
            previewBody:proposal.body,
        };
        if (!apply) return ready;

        await this.github.checkHead(repository,prNumber,latest.headSha);
        const token = await this.github.prepareWrite(repository);
        const claim: Claim = {
            state:'claimed',claimId:randomUUID(),findingId,
            rootCommentId:ownedRoot.id,rootMarker:ownedRoot.marker,
            rootBodySha256:ownedRoot.bodySha256,marker:proposal.marker,bodySha256:proposal.bodySha256,
            headSha:latest.headSha,claimedAt:new Date().toISOString(),
        };
        await this.catalog.store.transaction(state => {
            if (this.fingerprint(state,id)!==fingerprint)
                throw new AtlasError('Review changed during inline reply preflight.', 'CONFLICT');
            const current = this.plan(state,id,findingId,caller!,latest.runId);
            if (parseReplyClaim(current.finding) || current.bodySha256!==claim.bodySha256)
                throw new AtlasError('Inline reply already claimed or changed.', 'CONFLICT');
            this.persist(state,id,current.finding,claim);
        });
        try {
            await this.github.checkHead(repository,prNumber,latest.headSha);
            const fresh = await this.roots.inspect(repository,prNumber);
            const stillOwned = fresh.roots.some(root => root.id === claim.rootCommentId &&
                root.marker === claim.rootMarker &&
                root.bodySha256 === claim.rootBodySha256);
            if (!stillOwned || fresh.managedReplies.some(reply => reply.marker === claim.marker) ||
                fresh.copiedReplyMarkers.includes(claim.marker))
                throw new AtlasError('Existing inline root changed before reply POST.', 'CONFLICT');
        } catch (error) {
            try {
                await this.catalog.store.transaction(state => {
                    const row = this.related(state,id).findings.find(f=>f.id===findingId);
                    const pending = row && parseReplyClaim(row);
                    if (!row || !pending || pending.state!=='claimed' ||
                        pending.claimId!==claim.claimId)
                        throw new AtlasError('Unsent reply claim changed.', 'CONFLICT');
                    this.persist(state,id,row);
                });
            } catch {
                return { status:'prewrite_recovery_required',dryRun:false,findingId,postedAgain:false };
            }
            throw error;
        }
        let postedId: number;
        try {
            postedId=await this.github.postReply(repository,prNumber,ownedRoot.id,proposal.body,token);
        } catch (error) {
            if (error instanceof GitHubInlineReplyRejectedError) {
                try {
                    const observed=await this.roots.inspect(repository,prNumber);
                    const original=observed.roots.find(r => r.id === claim.rootCommentId &&
                        r.marker === claim.rootMarker && r.bodySha256 === ownedRoot.bodySha256);
                    if (original && !observed.managedReplies.some(r=>r.marker===claim.marker) &&
                        !observed.copiedReplyMarkers.includes(claim.marker)) {
                        await this.catalog.store.transaction(state => {
                            const row=this.related(state,id).findings.find(f=>f.id===findingId);
                            const pending=row && parseReplyClaim(row);
                            if (!row || !pending || pending.state!=='claimed' ||
                                pending.claimId!==claim.claimId || pending.marker!==claim.marker)
                                throw new AtlasError('Rejected reply claim changed.', 'CONFLICT');
                            this.persist(state,id,row);
                        });
                        return { status:'rejected_not_published',dryRun:false,findingId,
                            httpStatus:error.httpStatus,claimReleased:true,postedAgain:false };
                    }
                } catch {
                    // No verified absence or transactional release: remain claimed.
                }
            }
            return { status:'uncertain',dryRun:false,findingId,postedAgain:false };
        }
        try {
            const observed=await this.roots.inspect(repository,prNumber);
            const matched=this.attestRemote(observed,{ ...claim,replyCommentId:postedId });
            if (!matched)
                throw new AtlasError('Posted reply was not independently verified.', 'CONFLICT');
            await this.catalog.store.transaction(state => {
                const row=this.related(state,id).findings.find(f=>f.id===findingId);
                const pending=row && parseReplyClaim(row);
                if (!row || !pending || pending.state!=='claimed' ||
                    pending.claimId!==claim.claimId)
                    throw new AtlasError('Inline reply claim changed before receipt.', 'CONFLICT');
                this.persist(state,id,row,{ ...claim,state:'published',replyCommentId:postedId });
            });
            return { ...ready,status:'published',dryRun:false,replyCommentId:postedId };
        } catch {
            return { ...ready,status:'uncertain',dryRun:false,postedAgain:false };
        }
    }
}
