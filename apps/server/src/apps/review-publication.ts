import { createHash, randomUUID } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';
import type { AtlasData, AtlasRecord, RecordData } from '../types.js';
import type { CoreService } from '../core/service.js';
import type { ApplicationCaller } from './registry.js';
import { assertStructuredCaller } from './review-submission.js';
import { CODE_REVIEWS_PROJECT_ID, REVIEW_RUNS_STORE, REVIEW_FINDINGS_STORE } from './review-import.js';
import { GitHubReviewPublisher, renderReview, type PublishPayload, type ExpectedInlineComment } from './github-review-publisher.js';

type Catalogue = Pick<CoreService, 'store' | 'listStores' | 'updateRecordInState'>;
type Stores = { runs: string; findings: string };
type Claim = { state: 'claimed' | 'published'; claimId: string; contentSha: string;
    includeInline: boolean; claimedAt: string; expectedInline: ExpectedInlineComment[];
    githubReviewId?: string; githubReviewUrl?: string };
type Proposal = { run: AtlasRecord; payload: PublishPayload; body: string; marker: string; contentSha: string; status?: Claim };

export class ReviewPublicationService {
    constructor(private readonly catalog: Catalogue,
        private readonly github: Pick<GitHubReviewPublisher, 'checkHead' | 'inlineComments' | 'findPublished' | 'prepareWrite' | 'publish'>,
        private readonly enabledRepositories: ReadonlySet<string> = new Set()) {}

    private async stores(): Promise<Stores> {
        const stores = await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs = stores.find(s => s.name === REVIEW_RUNS_STORE);
        const findings = stores.find(s => s.name === REVIEW_FINDINGS_STORE);
        if (!runs || !findings) throw new AtlasError('Code Reviews Stores are unavailable.', 'CAPABILITY_UNAVAILABLE');
        return { runs: runs.id, findings: findings.id };
    }

    private plan(state: AtlasData, stores: Stores, runId: string, caller: ApplicationCaller, includeInline: boolean): Proposal {
        const run = state.records.find(r => r.id === runId && r.storeId === stores.runs &&
            r.projectId === CODE_REVIEWS_PROJECT_ID);
        if (!run || run.archivedAt) throw new AtlasError('Active structured review run not found.', 'NOT_FOUND');
        const data = run.data;
        const coverage = data.coverage as RecordData | undefined;
        if (coverage?.source !== 'atlas_structured_submission' ||
            !coverage.submissionId || typeof coverage.payloadSha256 !== 'string')
            throw new AtlasError('Only native structured review runs can be published.', 'WORKSPACE_DENIED');
        const actor = coverage.authenticatedCaller as RecordData | undefined;
        if (!actor || actor.kind !== caller.kind || actor.subject !== caller.subject || actor.issuer !== caller.issuer)
            throw new AtlasError('Review belongs to another authenticated caller.', 'WORKSPACE_DENIED');
        if (typeof data.repository !== 'string' || !this.enabledRepositories.has(data.repository.toLowerCase()))
            throw new AtlasError('GitHub publication is not enabled for this repository.', 'CAPABILITY_UNAVAILABLE');
        if (typeof data.headSha !== 'string' || typeof data.prNumber !== 'number' ||
            typeof data.verdict !== 'string')
            throw new AtlasError('Invalid stored review identity.', 'CONFLICT');
        const records = state.records.filter(r => r.storeId === stores.findings &&
            r.projectId === CODE_REVIEWS_PROJECT_ID && r.data.reviewRunId === runId);
        if (records.some(r => r.archivedAt) || records.length !== coverage.findingCount ||
            records.length > 30)
            throw new AtlasError('Stored review findings are incomplete.', 'CONFLICT');
        const findings = records.map(r => {
            const f = r.data;
            if (typeof f.findingKey !== 'string' || !f.findingKey.startsWith('structured:' + coverage.submissionId + ':') ||
                typeof f.severity !== 'string' || !['sev1','sev2','sev3','sev4'].includes(f.severity) ||
                typeof f.title !== 'string' || typeof f.description !== 'string')
                throw new AtlasError('Stored review contains unsupported findings.', 'CONFLICT');
            return { key: f.findingKey as string, severity: f.severity as string, title: f.title as string,
                description: f.description as string,
                ...(typeof f.filePath === 'string' && { path: f.filePath }),
                ...(typeof f.line === 'number' && { line: f.line }) };
        }).sort((a,b)=>a.key.localeCompare(b.key));
        if (new Set(findings.map(f=>f.key)).size !== findings.length)
            throw new AtlasError('Duplicate stored finding key.', 'CONFLICT');
        const payload: PublishPayload = { runId: run.id, repository: data.repository.toLowerCase(),
            prNumber: data.prNumber, headSha: data.headSha.toLowerCase(),
            verdict: data.verdict, findings,
            ...(typeof coverage.summary === 'string' && {summary: coverage.summary}) };
        const rendered = renderReview(payload);
        const contentSha = createHash('sha256').update(JSON.stringify({ payload, includeInline })).digest('hex');
        const status = coverage.githubPublication as Claim | undefined;
        if (status && (status.state !== 'claimed' && status.state !== 'published' ||
            status.contentSha !== contentSha || status.includeInline !== includeInline))
            throw new AtlasError('Existing publication claim differs from this content or mode.', 'CONFLICT');
        return { run, payload, body: rendered.body, marker: rendered.marker, contentSha, status };
    }

    private persist(state: AtlasData, stores: Stores, planned: Proposal, update: Claim) {
        const current = this.plan(state, stores, planned.run.id,
            (planned.run.data.coverage as RecordData).authenticatedCaller as ApplicationCaller,
            update.includeInline);
        if (current.contentSha !== planned.contentSha)
            throw new AtlasError('Review changed while preparing GitHub publication.', 'CONFLICT');
        const nextCoverage = { ...(current.run.data.coverage as RecordData), githubPublication: update };
        this.catalog.updateRecordInState(state, {
            projectId: CODE_REVIEWS_PROJECT_ID, storeId: stores.runs, recordId: current.run.id,
            data: { coverage: nextCoverage }, client: 'atlas-code-review-publication',
        });
    }

    async publishRun(runId: string, includeInline: boolean, apply: boolean, caller?: ApplicationCaller) {
        assertStructuredCaller(caller);
        const stores = await this.stores();
        const proposal = this.plan(await this.catalog.store.snapshot(), stores, runId, caller, includeInline);
        if (proposal.status?.state === 'published') return {
            runId, status: 'published', githubReviewId: proposal.status.githubReviewId,
            githubReviewUrl: proposal.status.githubReviewUrl, alreadyPublished: true };
        // A durable claim prevents duplicate POSTs after crashes or timeouts.
        // Reconciliation is read-only and safe even when GitHub head advances.
        if (proposal.status?.state === 'claimed') {
            if (!Array.isArray(proposal.status.expectedInline))
                throw new AtlasError('Publication claim lacks verified inline content.', 'CONFLICT');
            const found = await this.github.findPublished(proposal.payload, proposal.body,
                proposal.status.expectedInline);
            if (!found) return { runId, status: 'uncertain', postedAgain: false,
                message: 'Claim exists without a confirmed GitHub review. Manual investigation required; no retry POST.' };
            if (apply) await this.catalog.store.transaction(state => {
                const current = this.plan(state, stores, runId, caller, includeInline);
                if (current.status?.claimId !== proposal.status?.claimId || current.status?.state !== 'claimed')
                    throw new AtlasError('Publication state changed during reconciliation.', 'CONFLICT');
                this.persist(state, stores, current, { ...current.status, state: 'published',
                    githubReviewId: String(found.id), githubReviewUrl: found.html_url });
            });
            return { runId, status: apply ? 'published' : 'found_on_github', githubReviewUrl: found.html_url, postedAgain: false };
        }
        const token = await this.github.checkHead(proposal.payload);
        const comments = await this.github.inlineComments(proposal.payload, token, includeInline);
        const seen = await this.github.findPublished(proposal.payload, proposal.body, comments, token);
        if (seen) throw new AtlasError('Review marker already exists on GitHub without a recorded claim.', 'CONFLICT');
        const preview = { runId, repository: proposal.payload.repository, prNumber: proposal.payload.prNumber,
            headSha: proposal.payload.headSha, verdict: proposal.payload.verdict,
            findingCount: proposal.payload.findings.length, inlineCount: comments.length,
            previewBody: proposal.body, status: 'ready', dryRun: !apply, event: 'COMMENT' };
        if (!apply) return preview;
        // Check GitHub installation write permission before creating a durable claim.
        // If scope is missing, fail without locking an unpublished review.
        const writeToken = await this.github.prepareWrite(proposal.payload.repository);
        const claim: Claim = { state: 'claimed', claimId: randomUUID(), contentSha: proposal.contentSha,
            includeInline, claimedAt: new Date().toISOString(), expectedInline: comments };
        await this.catalog.store.transaction(state => {
            const current = this.plan(state, stores, runId, caller, includeInline);
            if (current.status) throw new AtlasError('Review publication already claimed.', 'CONFLICT');
            if (current.contentSha !== proposal.contentSha)
                throw new AtlasError('Review changed during publication preflight.', 'CONFLICT');
            this.persist(state, stores, current, claim);
        });
        // Once the durable claim exists we NEVER automatically send another POST.
        // Any failed/ambiguous HTTP outcome remains claimed until remote reconciliation.
        await this.github.checkHead(proposal.payload);
        const posted = await this.github.publish(proposal.payload, proposal.body, comments, writeToken);
        // GitHub's POST response alone does not attest author or inline content.
        // A failed verification leaves the durable claim uncertain, never re-posted.
        const verified = await this.github.findPublished(proposal.payload, proposal.body, comments);
        if (!verified || verified.id !== posted.id)
            throw new AtlasError('GitHub publication could not be independently reconciled.', 'CONFLICT');
        await this.catalog.store.transaction(state => {
            const current = this.plan(state, stores, runId, caller, includeInline);
            if (current.status?.state !== 'claimed' || current.status.claimId !== claim.claimId)
                throw new AtlasError('Publication claim changed before receipt confirmation.', 'CONFLICT');
            this.persist(state, stores, current, { ...claim, state: 'published',
                githubReviewId: String(verified.id), githubReviewUrl: verified.html_url });
        });
        return { ...preview, status: 'published', dryRun: false,
            githubReviewId: String(posted.id), githubReviewUrl: posted.url };
    }
}
