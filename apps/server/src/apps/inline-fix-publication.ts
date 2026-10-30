import { createHash, randomUUID } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';
import type { AtlasData, AtlasRecord } from '../types.js';
import type { CoreService } from '../core/service.js';
import type { ApplicationCaller } from './registry.js';
import { assertStructuredCaller } from './review-submission.js';
import { canonicalRepository } from './managed-summary.js';
import { inlineThreadMarker, type GitHubInlineThreadReader } from './inline-thread-inventory.js';
import { GitHubInlineReplyRejectedError, type GitHubInlineRootWriter } from './inline-thread-writer.js';
import { CODE_REVIEWS_PROJECT_ID, REVIEW_RUNS_STORE, REVIEW_FINDINGS_STORE } from './review-import.js';
import { readPrTimeline } from './review-timeline.js';

type Catalogue = Pick<CoreService, 'store' | 'listStores' | 'queryRecords' | 'updateRecordInState'>;
type GitHub = Pick<GitHubInlineRootWriter, 'checkHead' | 'prepareWrite' | 'postReply'>;
type Roots = Pick<GitHubInlineThreadReader, 'inspect'>;
type Identity = { runs: string; findings: string; repository: string; prNumber: number };
type Claim = {
    state: 'claimed' | 'published'; claimId: string; runId: string; lineageKey: string;
    rootCommentId: number; rootMarker: string; rootBodySha256: string;
    marker: string; bodySha256: string; headSha: string; claimedAt: string;
    replyCommentId?: number;
};
const object = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const positive = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const fingerprint = (value: unknown) => sha256(JSON.stringify(value));
const shaPattern = /^[a-f0-9]{40}$/i;
const bodyHashPattern = /^[a-f0-9]{64}$/;
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const uuidPattern = /^[a-f0-9-]{36}$/i;
const markdown = (v: string, limit: number) => v.slice(0,limit)
    .replace(/[\r\n\t\u2028\u2029]/g,' ')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~\-])/g,'\\$1');

/** The domain tag deliberately differs from persisting-observation replies.
 * Resolving a GitHub conversation is a separate, never implicit operation.
 */
export function inlineFixMarker(repository: string, prNumber: number,
    rootCommentId: number, runId: string, lineageKey: string) {
    repository = canonicalRepository(repository);
    if (!positive(prNumber) || prNumber > 1_000_000 || !positive(rootCommentId) ||
        !uuidPattern.test(runId) || !keyPattern.test(lineageKey))
        throw new AtlasError('Invalid inline fix acknowledgement identity.', 'INVALID_REQUEST');
    const identity = JSON.stringify([repository,prNumber,rootCommentId,runId,lineageKey]);
    return '<!-- atlas-code-reviews-fix:v1:' +
        sha256('atlas-code-reviews-fix:v1:' + identity) + ' -->';
}

function parseClaim(run: AtlasRecord, lineageKey: string): Claim | undefined {
    const coverage = object(run.data.coverage) ? run.data.coverage : {};
    const entries = coverage.githubFixReplies;
    if (entries === undefined) return undefined;
    if (!object(entries) || Object.keys(entries).length > 30)
        throw new AtlasError('Stored fix reply claim collection is malformed.', 'CONFLICT');
    const raw = entries[lineageKey];
    if (raw === undefined) return undefined;
    if (!object(raw) || !['claimed','published'].includes(String(raw.state)) ||
        typeof raw.claimId !== 'string' || !uuidPattern.test(raw.claimId) ||
        raw.runId !== run.id || raw.lineageKey !== lineageKey ||
        !positive(raw.rootCommentId) ||
        typeof raw.rootMarker !== 'string' ||
        !/^<!-- atlas-code-reviews-thread:v1:[a-f0-9]{64} -->$/.test(raw.rootMarker) ||
        typeof raw.rootBodySha256 !== 'string' || !bodyHashPattern.test(raw.rootBodySha256) ||
        typeof raw.marker !== 'string' ||
        !/^<!-- atlas-code-reviews-fix:v1:[a-f0-9]{64} -->$/.test(raw.marker) ||
        typeof raw.bodySha256 !== 'string' || !bodyHashPattern.test(raw.bodySha256) ||
        typeof raw.headSha !== 'string' || !shaPattern.test(raw.headSha) ||
        raw.headSha !== run.data.headSha ||
        typeof raw.claimedAt !== 'string' ||
        (raw.replyCommentId !== undefined && !positive(raw.replyCommentId)) ||
        (raw.state === 'published' && !positive(raw.replyCommentId)))
        throw new AtlasError('Stored fix reply claim is malformed.', 'CONFLICT');
    return raw as Claim;
}

function body(run: AtlasRecord, lineageKey: string, evidence: string, marker: string) {
    const rendered = '**Code Reviews · reviewer assessment: addressed**\n\n' +
        'Root cause: `' + markdown(lineageKey,128) + '`\n\n' +
        'Review evidence: ' + markdown(evidence,4_000) + '\n\n' +
        '_Assessed on commit `' + run.data.headSha +
        '` · This comment does not resolve the GitHub discussion automatically._\n\n' + marker;
    if (rendered.length > 8_000)
        throw new AtlasError('Fix acknowledgement exceeds safe GitHub body size.', 'INVALID_REQUEST');
    return rendered;
}

/** One reply for an explicit resolution assertion in a current structured
 * review. Claims live in the immutable review RUN, since a resolved lineage
 * intentionally has no finding row in that run.
 */
export class InlineFixPublicationService {
    constructor(private readonly catalog: Catalogue, private readonly roots: Roots,
        private readonly github: GitHub, private readonly enabled: ReadonlySet<string> = new Set()) {}

    private async ids(): Promise<{ runs: string; findings: string }> {
        const stores = await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs = stores.find(x => x.name === REVIEW_RUNS_STORE);
        const findings = stores.find(x => x.name === REVIEW_FINDINGS_STORE);
        if (!runs || !findings)
            throw new AtlasError('Code Reviews Stores unavailable.', 'CAPABILITY_UNAVAILABLE');
        return { runs: runs.id, findings: findings.id };
    }

    private related(state: AtlasData, id: Identity) {
        const runs = state.records.filter(r => r.projectId === CODE_REVIEWS_PROJECT_ID &&
            r.storeId === id.runs && typeof r.data.repository === 'string' &&
            r.data.repository.toLowerCase() === id.repository && r.data.prNumber === id.prNumber);
        const ids = new Set(runs.map(x => x.id));
        const findings = state.records.filter(f => f.projectId === CODE_REVIEWS_PROJECT_ID &&
            f.storeId === id.findings && ids.has(String(f.data.reviewRunId)));
        return { runs, findings };
    }

    private stateFingerprint(state: AtlasData, id: Identity) {
        const { runs, findings } = this.related(state,id);
        return fingerprint({ runs:[...runs].sort((a,b)=>a.id.localeCompare(b.id)),
            findings:[...findings].sort((a,b)=>a.id.localeCompare(b.id)) });
    }

    private persist(state: AtlasData, id: Identity, runId: string, lineageKey: string,
        claim?: Claim) {
        const run = this.related(state,id).runs.find(x => x.id === runId && !x.archivedAt);
        if (!run || !object(run.data.coverage))
            throw new AtlasError('Fix acknowledgement run has changed.', 'CONFLICT');
        const coverage = run.data.coverage;
        const previous = coverage.githubFixReplies;
        if (previous !== undefined && !object(previous))
            throw new AtlasError('Fix acknowledgement Store metadata is malformed.', 'CONFLICT');
        const entries = { ...(object(previous) ? previous : {}) };
        if (claim) entries[lineageKey] = claim;
        else delete entries[lineageKey];
        this.catalog.updateRecordInState(state, {
            projectId: CODE_REVIEWS_PROJECT_ID, storeId: id.runs, recordId: run.id,
            client: 'atlas-inline-review-fix',
            data: { coverage: { ...coverage, githubFixReplies: entries } },
        });
    }

    private plan(state: AtlasData, id: Identity, runId: string, lineageKey: string,
        caller: ApplicationCaller) {
        const { runs, findings } = this.related(state,id);
        if (runs.some(run => run.archivedAt) || findings.some(f => f.archivedAt))
            throw new AtlasError('Archived Code Reviews evidence cannot authorize a fix acknowledgement.', 'CONFLICT');
        const ordered = [...runs].sort((a,b) =>
            String(b.data.reviewedAt).localeCompare(String(a.data.reviewedAt)) ||
            a.id.localeCompare(b.id));
        const latest = ordered[0];
        if (!latest || latest.id !== runId)
            throw new AtlasError('Only the latest saved review may publish a new fix acknowledgement.', 'CONFLICT');
        const coverage = latest.data.coverage;
        const actor = object(coverage) && object(coverage.authenticatedCaller)
            ? coverage.authenticatedCaller : null;
        if (!object(coverage) || coverage.source !== 'atlas_structured_submission' ||
            typeof coverage.submissionId !== 'string' ||
            typeof coverage.payloadSha256 !== 'string' || !bodyHashPattern.test(coverage.payloadSha256) ||
            coverage.githubPublication !== undefined ||
            !actor || actor.kind !== caller.kind || actor.subject !== caller.subject ||
            actor.issuer !== caller.issuer)
            throw new AtlasError('Only the submitting authenticated reviewer can publish fix evidence.', 'WORKSPACE_DENIED');

        const resolutions = coverage.lifecycleResolutions;
        if (!Array.isArray(resolutions) || resolutions.length > 30)
            throw new AtlasError('This structured review has no supported resolution evidence.', 'CONFLICT');
        const matches = resolutions.filter(item => object(item) && item.lineageKey === lineageKey);
        if (matches.length !== 1 || !keyPattern.test(lineageKey))
            throw new AtlasError('Exactly one explicit resolved lineage is required.', 'CONFLICT');
        const assertion = matches[0] as Record<string, unknown>;
        if (assertion.state !== 'resolved' ||
            assertion.assessmentSource !== 'authenticated_structured_submission' ||
            assertion.assessedHeadSha !== latest.data.headSha ||
            assertion.assertedAt !== latest.data.reviewedAt ||
            typeof assertion.evidence !== 'string' || assertion.evidence.trim().length < 20 ||
            assertion.evidence.length > 4_000)
            throw new AtlasError('Fix evidence is not bound to this reviewed SHA.', 'CONFLICT');
        if (typeof latest.data.headSha !== 'string' || !shaPattern.test(latest.data.headSha))
            throw new AtlasError('Invalid reviewed commit SHA for fix.', 'CONFLICT');
        const rootRows = findings.filter(f => object(f.data.evidence) &&
            f.data.evidence.lineageKey === lineageKey &&
            object(f.data.evidence.githubInlineThread));
        if (rootRows.length !== 1)
            throw new AtlasError('Fix reply requires exactly one prior published Atlas root.', 'CONFLICT');
        const rootRecord = rootRows[0]!;
        const root = (rootRecord.data.evidence as Record<string,unknown>).githubInlineThread;
        const sourceRun = runs.find(run => run.id === rootRecord.data.reviewRunId);
        if (!object(root) || root.state !== 'published' ||
            root.findingId !== rootRecord.id || !positive(root.rootCommentId) ||
            typeof root.marker !== 'string' ||
            root.marker !== inlineThreadMarker(id.repository,id.prNumber,lineageKey) ||
            typeof root.bodySha256 !== 'string' || !bodyHashPattern.test(root.bodySha256) ||
            typeof root.headSha !== 'string' || !shaPattern.test(root.headSha) ||
            !sourceRun || sourceRun.data.headSha !== root.headSha ||
            typeof sourceRun.data.reviewedAt !== 'string' ||
            sourceRun.data.reviewedAt >= latest.data.reviewedAt ||
            root.headSha === latest.data.headSha ||
            typeof root.path !== 'string' || !positive(root.line))
            throw new AtlasError('Original published root receipt is not verified.', 'CONFLICT');

        // The same repository/PR/root/commit cannot publish multiple "fixed"
        // notices merely from new submission IDs at the same reviewed SHA.
        for (const other of runs) {
            if (other.id === latest.id || other.data.headSha !== latest.data.headSha) continue;
            if (parseClaim(other,lineageKey))
                throw new AtlasError('This lineage already has a fix reply claim for this commit.', 'CONFLICT');
        }
        const marker = inlineFixMarker(id.repository,id.prNumber,root.rootCommentId,runId,lineageKey);
        const message = body(latest,lineageKey,assertion.evidence,marker);
        return { latest, root, marker, body:message, bodySha256:sha256(message) };
    }

    private verifiedReply(remote: Awaited<ReturnType<Roots['inspect']>>, claim: Claim) {
        const root = remote.roots.find(x => x.id === claim.rootCommentId &&
            x.marker === claim.rootMarker && x.bodySha256 === claim.rootBodySha256);
        if (!root || remote.copiedFixMarkers.includes(claim.marker))
            throw new AtlasError('Fix reply root or ownership cannot be verified.', 'CONFLICT');
        const matches = remote.managedFixReplies.filter(x => x.marker === claim.marker);
        if (matches.length > 1)
            throw new AtlasError('Duplicate managed fix replies violate idempotency.', 'CONFLICT');
        const reply = matches[0];
        return reply && reply.parentId === claim.rootCommentId &&
            reply.bodySha256 === claim.bodySha256 &&
            (!claim.replyCommentId || claim.replyCommentId === reply.id) ? reply : null;
    }

    private async reconcile(id: Identity, runId: string, lineageKey: string, claim: Claim,
        caller: ApplicationCaller, apply: boolean) {
        const snapshot = await this.catalog.store.snapshot();
        const run = this.related(snapshot,id).runs.find(x=>x.id===runId);
        const coverage = run && object(run.data.coverage) ? run.data.coverage : null;
        const actor = coverage && object(coverage.authenticatedCaller) ? coverage.authenticatedCaller : null;
        if (!run || !actor || actor.kind !== caller.kind || actor.subject !== caller.subject ||
            actor.issuer !== caller.issuer || parseClaim(run,lineageKey)?.claimId !== claim.claimId)
            throw new AtlasError('Stored fix reply is not owned by this reviewer.', 'WORKSPACE_DENIED');
        const remote = await this.roots.inspect(id.repository,id.prNumber);
        const found = this.verifiedReply(remote,claim);
        if (!found) return { status:claim.state==='published'?'published_remote_drift':'uncertain',
            dryRun:true,runId,lineageKey,postedAgain:false };
        if (apply && claim.state==='claimed') await this.catalog.store.transaction(state => {
            const current = this.related(state,id).runs.find(x=>x.id===runId);
            const pending = current && parseClaim(current,lineageKey);
            if (!pending || pending.claimId!==claim.claimId || pending.state!=='claimed')
                throw new AtlasError('Fix reply claim changed during reconciliation.', 'CONFLICT');
            this.persist(state,id,runId,lineageKey,{...pending,state:'published',replyCommentId:found.id});
        });
        return { status:apply || claim.state==='published'?'published':'found_on_github',
            dryRun:!apply,runId,lineageKey,rootCommentId:claim.rootCommentId,
            replyCommentId:found.id,postedAgain:false };
    }

    async publish(repository: string, prNumber: number, runId: string, lineageKey: string,
        apply: boolean, caller?: ApplicationCaller) {
        assertStructuredCaller(caller);
        repository = canonicalRepository(repository);
        if (!this.enabled.has(repository))
            throw new AtlasError('Fix acknowledgements are disabled for this repository.', 'CAPABILITY_UNAVAILABLE');
        if (!uuidPattern.test(runId) || !keyPattern.test(lineageKey))
            throw new AtlasError('Invalid fix reply run or lineage identity.', 'INVALID_REQUEST');
        const id: Identity = { ...(await this.ids()),repository,prNumber };
        const initial = await this.catalog.store.snapshot();
        const priorRun = this.related(initial,id).runs.find(run=>run.id===runId);
        const prior = priorRun && parseClaim(priorRun,lineageKey);
        if (prior) return this.reconcile(id,runId,lineageKey,prior,caller!,apply);
        const baseFingerprint = this.stateFingerprint(initial,id);

        const timeline = await readPrTimeline(this.catalog,id,repository,prNumber,1,0,true);
        const latest = timeline.rounds[0];
        if (!latest || latest.runId!==runId || latest.source!=='structured' ||
            latest.findingsTruncated || !latest.resolutions.some(r=>r.lineageKey===lineageKey))
            throw new AtlasError('No current complete structured fix assessment for this lineage.', 'CONFLICT');
        const proposal = this.plan(initial,id,runId,lineageKey,caller!);
        const remote = await this.roots.inspect(repository,prNumber);
        const root = remote.roots.find(x=>x.id===proposal.root.rootCommentId &&
            x.marker===proposal.root.marker && x.bodySha256===proposal.root.bodySha256 &&
            x.originalCommitSha===proposal.root.headSha &&
            x.path===proposal.root.path && x.originalLine===proposal.root.line);
        if (!root || remote.managedFixReplies.some(reply=>reply.marker===proposal.marker) ||
            remote.copiedFixMarkers.includes(proposal.marker))
            throw new AtlasError('Prior root or fix reply uniqueness is unverified.', 'CONFLICT');
        const ready = {status:'ready',dryRun:!apply,repository,prNumber,runId,lineageKey,
            rootCommentId:root.id,reviewedHeadSha:latest.headSha,previewBody:proposal.body};
        if (!apply) return ready;
        await this.github.checkHead(repository,prNumber,latest.headSha);
        const token = await this.github.prepareWrite(repository);
        const claim: Claim = {
            state:'claimed',claimId:randomUUID(),runId,lineageKey,
            rootCommentId:root.id,rootMarker:root.marker,rootBodySha256:root.bodySha256,
            marker:proposal.marker,bodySha256:proposal.bodySha256,
            headSha:latest.headSha,claimedAt:new Date().toISOString(),
        };
        await this.catalog.store.transaction(state => {
            if (this.stateFingerprint(state,id)!==baseFingerprint)
                throw new AtlasError('PR review history changed before fix publication.', 'CONFLICT');
            const current = this.plan(state,id,runId,lineageKey,caller!);
            if (parseClaim(current.latest,lineageKey) || current.bodySha256!==claim.bodySha256)
                throw new AtlasError('Fix reply is already claimed or changed.', 'CONFLICT');
            this.persist(state,id,runId,lineageKey,claim);
        });
        try {
            await this.github.checkHead(repository,prNumber,latest.headSha);
            const fresh = await this.roots.inspect(repository,prNumber);
            const valid = fresh.roots.some(x=>x.id===claim.rootCommentId &&
                x.marker===claim.rootMarker && x.bodySha256===claim.rootBodySha256 &&
                x.originalCommitSha===proposal.root.headSha &&
                x.path===proposal.root.path && x.originalLine===proposal.root.line);
            if (!valid || fresh.managedFixReplies.some(x=>x.marker===claim.marker) ||
                fresh.copiedFixMarkers.includes(claim.marker))
                throw new AtlasError('Fix reply target changed before POST.', 'CONFLICT');
        } catch (error) {
            try {
                await this.catalog.store.transaction(state=>{
                    const current=this.related(state,id).runs.find(x=>x.id===runId);
                    const saved=current && parseClaim(current,lineageKey);
                    if (!saved || saved.claimId!==claim.claimId || saved.state!=='claimed')
                        throw new AtlasError('Unsent fix claim changed.', 'CONFLICT');
                    this.persist(state,id,runId,lineageKey);
                });
            } catch {
                return {status:'prewrite_recovery_required',dryRun:false,runId,lineageKey,postedAgain:false};
            }
            throw error;
        }
        let replyId:number;
        try {
            replyId=await this.github.postReply(repository,prNumber,root.id,proposal.body,token);
        } catch (error) {
            if (error instanceof GitHubInlineReplyRejectedError) {
                try {
                    const observed=await this.roots.inspect(repository,prNumber);
                    const valid=observed.roots.some(x=>x.id===claim.rootCommentId &&
                        x.marker===claim.rootMarker && x.bodySha256===claim.rootBodySha256);
                    if (valid && !observed.managedFixReplies.some(x=>x.marker===claim.marker) &&
                        !observed.copiedFixMarkers.includes(claim.marker)) {
                        await this.catalog.store.transaction(state=>{
                            const current=this.related(state,id).runs.find(x=>x.id===runId);
                            const saved=current && parseClaim(current,lineageKey);
                            if (!saved || saved.state!=='claimed' || saved.claimId!==claim.claimId ||
                                saved.marker!==claim.marker)
                                throw new AtlasError('Rejected fix claim changed.', 'CONFLICT');
                            this.persist(state,id,runId,lineageKey);
                        });
                        return {status:'rejected_not_published',dryRun:false,
                            runId,lineageKey,httpStatus:error.httpStatus,claimReleased:true,postedAgain:false};
                    }
                } catch { /* uncertain: retain durable claim */ }
            }
            return {status:'uncertain',dryRun:false,runId,lineageKey,postedAgain:false};
        }
        try {
            const observed=await this.roots.inspect(repository,prNumber);
            const found=this.verifiedReply(observed,{...claim,replyCommentId:replyId});
            if (!found) throw new AtlasError('Posted fix reply is not independently verified.', 'CONFLICT');
            await this.catalog.store.transaction(state=>{
                const current=this.related(state,id).runs.find(x=>x.id===runId);
                const saved=current && parseClaim(current,lineageKey);
                if (!saved || saved.state!=='claimed' || saved.claimId!==claim.claimId)
                    throw new AtlasError('Fix claim changed before receipt.', 'CONFLICT');
                this.persist(state,id,runId,lineageKey,
                    {...claim,state:'published',replyCommentId:replyId});
            });
            return {...ready,status:'published',dryRun:false,replyCommentId:replyId};
        } catch {
            return {...ready,status:'uncertain',dryRun:false,postedAgain:false};
        }
    }
}
