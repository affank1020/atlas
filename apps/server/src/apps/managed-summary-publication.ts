import { createHash, randomUUID } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';
import type { CoreService } from '../core/service.js';
import type { AtlasData, AtlasRecord } from '../types.js';
import type { ApplicationCaller } from './registry.js';
import { assertStructuredCaller } from './review-submission.js';
import { CODE_REVIEWS_PROJECT_ID, REVIEW_RUNS_STORE, REVIEW_FINDINGS_STORE } from './review-import.js';
import { canonicalRepository, type ManagedSummaryPreviewService } from './managed-summary.js';
import type { GitHubManagedSummaryWriter } from './managed-summary-github.js';

type Catalogue = Pick<CoreService, 'listStores' | 'store' | 'updateRecordInState'>;
type Preview = Awaited<ReturnType<ManagedSummaryPreviewService['preview']>>;
type Remote = { status: string; commentId?: number; commentUrl?: string; bodySha256?: string };
type Claim = {
    state: 'claimed' | 'published'; claimId: string; runId: string;
    bodySha256: string; mode: 'create' | 'update'; claimedAt: string;
    commentId?: number;
};
type Candidate = { run: AtlasRecord; status?: Claim };
type Identity = { runs: string; findings: string; repository: string; prNumber: number };
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const validId = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const obj = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

/** One durable claim per saved review round. All claims for this PR are
 * inspected in the serialized PostgreSQL state before any GitHub write.
 * An uncertain POST/PATCH is NEVER retried automatically.
 */
export class ManagedSummaryPublicationService {
    constructor(private readonly catalog: Catalogue,
        private readonly previews: Pick<ManagedSummaryPreviewService, 'preview'>,
        private readonly github: Pick<GitHubManagedSummaryWriter, 'checkHead' | 'prepareWrite' | 'post' | 'patch'>,
        private readonly enabled: ReadonlySet<string> = new Set()) {}

    private async stores() {
        const values = await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs = values.find(v => v.name === REVIEW_RUNS_STORE);
        const findings = values.find(v => v.name === REVIEW_FINDINGS_STORE);
        if (!runs || !findings) throw new AtlasError('Code Reviews Stores unavailable.', 'CAPABILITY_UNAVAILABLE');
        return { runs: runs.id, findings: findings.id };
    }

    private rows(state: AtlasData, id: Identity): Candidate[] {
        return state.records.filter(r => r.projectId === CODE_REVIEWS_PROJECT_ID &&
            r.storeId === id.runs && r.data.prNumber === id.prNumber &&
            typeof r.data.repository === 'string' &&
            r.data.repository.toLowerCase() === id.repository)
            .sort((a, b) => String(b.data.reviewedAt).localeCompare(String(a.data.reviewedAt)) ||
                a.id.localeCompare(b.id))
            .map(run => {
                const coverage = run.data.coverage;
                const raw = obj(coverage) ? coverage.githubManagedSummary : undefined;
                let status: Claim | undefined;
                if (raw !== undefined) {
                    if (!obj(raw) || !['claimed', 'published'].includes(String(raw.state)) ||
                        !['create', 'update'].includes(String(raw.mode)) ||
                        typeof raw.claimId !== 'string' || typeof raw.runId !== 'string' ||
                        raw.runId !== run.id ||
                        typeof raw.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.bodySha256) ||
                        typeof raw.claimedAt !== 'string' ||
                        (raw.commentId !== undefined && !validId(raw.commentId)) ||
                        (raw.mode === 'update' && !validId(raw.commentId)) ||
                        (raw.state === 'published' && !validId(raw.commentId)))
                        throw new AtlasError('Invalid stored managed-summary claim.', 'CONFLICT');
                    status = raw as Claim;
                }
                return { run, status };
            });
    }

    private fingerprint(state: AtlasData, id: Identity) {
        const all = this.rows(state, id);
        const runIds = new Set(all.map(x => x.run.id));
        const related = state.records.filter(r => r.projectId === CODE_REVIEWS_PROJECT_ID &&
            r.storeId === id.findings && runIds.has(String(r.data.reviewRunId)));
        return digest({ runs: all.map(x => x.run).sort((a, b) => a.id.localeCompare(b.id)),
            findings: related.sort((a, b) => a.id.localeCompare(b.id)) });
    }

    private latest(state: AtlasData, id: Identity, preview: Preview, caller: ApplicationCaller) {
        const all = this.rows(state, id);
        const active = all.filter(x => !x.run.archivedAt);
        const first = active[0];
        if (!first || !('runId' in preview) || first.run.id !== preview.runId ||
            active.length !== preview.recordedRounds)
            throw new AtlasError('Saved PR review changed during managed publication.', 'CONFLICT');
        const coverage = first.run.data.coverage;
        const actor = obj(coverage) && obj(coverage.authenticatedCaller)
            ? coverage.authenticatedCaller : null;
        if (!obj(coverage) || coverage.source !== 'atlas_structured_submission' ||
            !actor || actor.kind !== caller.kind || actor.issuer !== caller.issuer ||
            actor.subject !== caller.subject ||
            !('fullEvidence' in preview) || preview.fullEvidence !== true)
            throw new AtlasError('Only complete native reviews owned by this authenticated caller can publish a summary.', 'WORKSPACE_DENIED');
        // An archived or damaged claim cannot be silently ignored.
        if (all.some(x => x.run.archivedAt && x.status))
            throw new AtlasError('Archived managed-summary publication metadata requires investigation.', 'CONFLICT');
        const claims = all.filter(x => x.status);
        if (claims.filter(x => x.status?.state === 'claimed').length > 1)
            throw new AtlasError('Multiple managed-summary publication claims exist.', 'CONFLICT');
        const published = claims.filter(x => x.status?.state === 'published');
        if (published.length && published.some(x => x.status!.commentId !== published[0]!.status!.commentId))
            throw new AtlasError('Managed-summary history references different GitHub comments.', 'CONFLICT');
        return { first, all, claimed: claims.find(x => x.status?.state === 'claimed'),
            lastPublished: published[0] };
    }

    private persist(state: AtlasData, id: Identity, run: AtlasRecord, claim: Claim) {
        const found = state.records.find(r => r.id === run.id && r.storeId === id.runs &&
            r.projectId === CODE_REVIEWS_PROJECT_ID && !r.archivedAt);
        if (!found || !obj(found.data.coverage))
            throw new AtlasError('Managed-summary receipt target was removed.', 'CONFLICT');
        this.catalog.updateRecordInState(state, {
            projectId: CODE_REVIEWS_PROJECT_ID, storeId: id.runs, recordId: found.id,
            data: { coverage: { ...found.data.coverage, githubManagedSummary: claim } },
            client: 'atlas-managed-review-summary',
        });
    }

    async publish(repository: string, prNumber: number, apply: boolean, caller?: ApplicationCaller) {
        assertStructuredCaller(caller);
        repository = canonicalRepository(repository);
        if (!this.enabled.has(repository))
            throw new AtlasError('Managed GitHub summary publication is disabled for this repository.', 'CAPABILITY_UNAVAILABLE');
        const stores = await this.stores();
        const id: Identity = { ...stores, repository, prNumber };
        // Snapshot BEFORE external reads: concurrent new rounds, changed findings,
        // or another publication claim invalidate the whole write preflight.
        const initial = await this.catalog.store.snapshot();
        const originalFingerprint = this.fingerprint(initial, id);
        const preview = await this.previews.preview(repository, prNumber);
        if (!('runId' in preview) || !('previewBody' in preview) ||
            !('remote' in preview) || !('reviewedHeadSha' in preview))
            throw new AtlasError('No complete saved review exists for managed publication.', 'CONFLICT');
        const proposed = preview as Extract<Preview, { runId: string }>;
        const body = proposed.previewBody;
        const bodySha256 = createHash('sha256').update(body).digest('hex');
        const remote = proposed.remote as Remote;
        const identity = this.latest(initial, id, preview, caller!);
        const current = identity.first;
        const previousClaim = identity.claimed;
        if (previousClaim && previousClaim.run.id !== current.run.id) {
            // An older interrupted publication must be reconciled first.
            const status = previousClaim.status!;
            const matched = remote.bodySha256 === status.bodySha256 &&
                (status.mode === 'create' || remote.commentId === status.commentId) &&
                validId(remote.commentId);
            if (!matched) return { status: 'uncertain_previous_round', dryRun: true,
                runId: previousClaim.run.id, postedAgain: false };
            if (apply) await this.catalog.store.transaction(state => {
                const rows = this.rows(state, id);
                const claim = rows.find(x => x.run.id === previousClaim.run.id)?.status;
                if (claim?.state !== 'claimed' || claim.claimId !== status.claimId)
                    throw new AtlasError('Previous managed publication claim changed.', 'CONFLICT');
                this.persist(state, id, previousClaim.run, { ...claim, state: 'published', commentId: remote.commentId });
            });
            return { status: apply ? 'reconciled_previous_round' : 'found_previous_round',
                runId: previousClaim.run.id, dryRun: !apply,
                commentId: remote.commentId, postedAgain: false };
        }
        if (current.status) {
            if (current.status.bodySha256 !== bodySha256)
                throw new AtlasError('Stored managed summary claim differs from this review.', 'CONFLICT');
            if (current.status.state === 'published')
                return { status: remote.bodySha256 === bodySha256 &&
                    remote.commentId === current.status.commentId ? 'published' : 'published_remote_drift',
                    dryRun: true, runId: current.run.id, commentId: current.status.commentId,
                    alreadyPublished: true };
            const verified = remote.bodySha256 === bodySha256 &&
                (current.status.mode === 'create' || remote.commentId === current.status.commentId) &&
                validId(remote.commentId);
            if (!verified) return { status: 'uncertain', runId: current.run.id,
                dryRun: true, postedAgain: false };
            if (apply) await this.catalog.store.transaction(state => {
                const latest = this.rows(state, id).find(x => x.run.id === current.run.id);
                if (latest?.status?.state !== 'claimed' ||
                    latest.status.claimId !== current.status?.claimId)
                    throw new AtlasError('Managed summary claim changed during reconciliation.', 'CONFLICT');
                this.persist(state, id, latest.run, { ...latest.status, state: 'published',
                    commentId: remote.commentId });
            });
            return { status: apply ? 'published' : 'found_on_github', runId: current.run.id,
                dryRun: !apply, commentId: remote.commentId, postedAgain: false };
        }
        const prior = identity.lastPublished?.status;
        let mode: Claim['mode'];
        if (!prior) {
            if (remote.status !== 'no_owned_comment')
                throw new AtlasError('Unclaimed bot-owned summary exists; manual ownership reconciliation required.', 'CONFLICT');
            mode = 'create';
        } else {
            if (!validId(prior.commentId) || remote.commentId !== prior.commentId ||
                remote.bodySha256 !== prior.bodySha256 || remote.status !== 'needs_update')
                throw new AtlasError('Existing managed summary changed or cannot be attested.', 'CONFLICT');
            mode = 'update';
        }
        const result = { repository, prNumber, runId: current.run.id, mode,
            status: 'ready', dryRun: !apply, previewBody: body,
            ...(prior && { commentId: prior.commentId }) };
        if (!apply) return result;
        await this.github.checkHead(repository, prNumber, proposed.reviewedHeadSha);
        // Acquire a write-scoped token BEFORE claiming the operation, so a
        // missing GitHub App permission cannot lock an otherwise valid run.
        const token = await this.github.prepareWrite(repository);
        const claim: Claim = { state: 'claimed', claimId: randomUUID(),
            runId: current.run.id, bodySha256, mode, claimedAt: new Date().toISOString(),
            ...(prior && { commentId: prior.commentId }) };
        await this.catalog.store.transaction(state => {
            if (this.fingerprint(state, id) !== originalFingerprint)
                throw new AtlasError('PR review or managed-summary history changed during preflight.', 'CONFLICT');
            const inState = this.latest(state, id, preview, caller!);
            if (inState.claimed || inState.first.status ||
                inState.lastPublished?.status?.claimId !== identity.lastPublished?.status?.claimId)
                throw new AtlasError('Another managed summary publication claimed this PR.', 'CONFLICT');
            this.persist(state, id, inState.first.run, claim);
        });
        // A claim can NEVER be automatically retransmitted, even if the process
        // dies, GitHub times out or responds with malformed JSON.
        try {
            await this.github.checkHead(repository, prNumber, proposed.reviewedHeadSha);
            const sentId = mode === 'create'
                ? await this.github.post(repository, prNumber, body, token)
                : await this.github.patch(repository, prior!.commentId!, body, token);
            const verified = await this.previews.preview(repository, prNumber);
            const confirmed = 'remote' in verified ? verified.remote as Remote : undefined;
            if (!confirmed || confirmed.bodySha256 !== bodySha256 ||
                confirmed.commentId !== sentId ||
                (mode === 'update' && confirmed.commentId !== prior?.commentId))
                throw new AtlasError('Managed summary comment was not independently verified.', 'CONFLICT');
            await this.catalog.store.transaction(state => {
                const row = this.rows(state, id).find(x => x.run.id === current.run.id);
                if (row?.status?.claimId !== claim.claimId || row.status.state !== 'claimed')
                    throw new AtlasError('Managed summary claim changed before confirmation.', 'CONFLICT');
                this.persist(state, id, row.run, { ...claim, state: 'published', commentId: sentId });
            });
            return { ...result, status: 'published', dryRun: false, commentId: sentId };
        } catch {
            return { ...result, status: 'uncertain', dryRun: false, postedAgain: false,
                message: 'Durable claim remains; only read-only reconciliation is allowed on retry.' };
        }
    }
}
