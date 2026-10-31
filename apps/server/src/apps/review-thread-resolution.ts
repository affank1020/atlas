import { createHash, randomUUID } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';
import type { AtlasData, AtlasRecord } from '../types.js';
import type { CoreService } from '../core/service.js';
import type { ApplicationCaller } from './registry.js';
import type { GitHubBroker } from '../workspaces/github-broker.js';
import type { GitHubInlineThreadReader } from './inline-thread-inventory.js';
import type { GitHubInlineRootWriter } from './inline-thread-writer.js';
import { GitHubReviewThreadStateReader } from './review-thread-state.js';
import { inlineThreadMarker } from './inline-thread-inventory.js';
import { inlineFixMarker } from './inline-fix-publication.js';
import { assertStructuredCaller } from './review-submission.js';
import { canonicalRepository } from './managed-summary.js';
import { CODE_REVIEWS_PROJECT_ID, REVIEW_RUNS_STORE, REVIEW_FINDINGS_STORE } from './review-import.js';
import { readPrTimeline } from './review-timeline.js';

type Catalogue = Pick<CoreService,'store'|'listStores'|'queryRecords'|'updateRecordInState'>;
type Rest = Pick<GitHubInlineThreadReader,'inspect'>;
type Head = Pick<GitHubInlineRootWriter,'checkHead'>;
type Graph = Awaited<ReturnType<GitHubReviewThreadStateReader['inspect']>>;
type Thread = Graph['threads'][number];
type Identity = { runs:string; findings:string; repository:string; prNumber:number };
type Claim = { state:'claimed'|'published'; claimId:string; runId:string; lineageKey:string;
    rootCommentId:number; threadId:string; headSha:string; fixReplyCommentId:number;
    fixMarker:string; fixBodySha256:string; claimedAt:string };
type Plan = { run:AtlasRecord; claim:Claim|undefined; threadRoot:{
    id:number;marker:string;bodySha256:string;originalCommitSha:string;
    path:string;line:number }; fix:{
    rootCommentId:number;replyCommentId:number;marker:string;bodySha256:string } };
const object=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const positive=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const sha=/^[a-f0-9]{40}$/i;
const hex=/^[a-f0-9]{64}$/;
const node=/^[A-Za-z0-9_+/=-]{8,256}$/;
const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

function parsedClaim(run:AtlasRecord,lineage:string):Claim|undefined {
    const coverage=run.data.coverage;
    if(!object(coverage))throw new AtlasError('Resolution run coverage is missing.','CONFLICT');
    const claims=coverage.githubThreadResolutions;
    if(claims===undefined)return undefined;
    if(!object(claims)||Object.keys(claims).length>30)
        throw new AtlasError('Resolution claim collection is malformed.','CONFLICT');
    if(!Object.hasOwn(claims,lineage))return undefined;
    const c=claims[lineage];
    if(!object(c)||!['claimed','published'].includes(String(c.state))||
        typeof c.claimId!=='string'||!uuid.test(c.claimId)||
        c.runId!==run.id||c.lineageKey!==lineage||
        !positive(c.rootCommentId)||typeof c.threadId!=='string'||!node.test(c.threadId)||
        c.headSha!==run.data.headSha||typeof c.headSha!=='string'||!sha.test(c.headSha)||
        !positive(c.fixReplyCommentId)||typeof c.fixMarker!=='string'||
        !/^<!-- atlas-code-reviews-fix:v1:[a-f0-9]{64} -->$/.test(c.fixMarker)||
        typeof c.fixBodySha256!=='string'||!hex.test(c.fixBodySha256)||
        typeof c.claimedAt!=='string'||!Number.isFinite(Date.parse(c.claimedAt)))
        throw new AtlasError('Resolution claim entry is malformed.','CONFLICT');
    return c as Claim;
}

/** A write-scoped GraphQL gateway. The initial query and all rechecks must
 * use a token issued with pull_requests:write, not the read-token's viewer.
 */
export class GitHubThreadResolutionGateway {
    constructor(private readonly broker: Pick<GitHubBroker,'pullRequestPublishToken'>,
        private readonly http:typeof fetch=fetch) {}
    async token(repository:string){return this.broker.pullRequestPublishToken(repository)}
    async inspect(repository:string,prNumber:number,token:string){
        const reader=new GitHubReviewThreadStateReader({
            pullRequestReadToken:async()=>token,
        },this.http);
        return reader.inspect(repository,prNumber);
    }
    async resolve(threadId:string,token:string){
        if(!node.test(threadId)||!token)
            throw new AtlasError('Invalid GraphQL thread mutation identity.','INVALID_REQUEST');
        let response:Response;
        try {
            response=await this.http('https://api.github.com/graphql',{
                method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
                headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
                    'Content-Type':'application/json'},
                body:JSON.stringify({query:`mutation AtlasResolveReviewThread($threadId:ID!) {
                    resolveReviewThread(input:{threadId:$threadId}) { thread { id isResolved } }
                }`,variables:{threadId}}),
            });
        } catch {
            throw new AtlasError('GraphQL resolution request outcome is uncertain.','GITHUB_UNAVAILABLE');
        }
        if(!response.ok)
            throw new AtlasError('GraphQL resolution HTTP '+response.status+
                ' has uncertain mutation outcome.','GITHUB_REQUEST_FAILED');
        let data:unknown;
        try {data=await response.json()}catch{
            throw new AtlasError('GraphQL resolution response is malformed; outcome uncertain.','GITHUB_REQUEST_FAILED');
        }
        if(!object(data)||data.errors!==undefined||!object(data.data)||
            !object(data.data.resolveReviewThread)||
            !object(data.data.resolveReviewThread.thread)||
            data.data.resolveReviewThread.thread.id!==threadId||
            data.data.resolveReviewThread.thread.isResolved!==true)
            throw new AtlasError('GraphQL resolution mutation is unverified; outcome uncertain.','GITHUB_REQUEST_FAILED');
    }
}

/** Explicit, one-shot operation. Does not interpret reviewer assertions as
 * proof of repair: only a saved, independently verified published fix reply
 * can authorize a separate attempt to close its own GitHub conversation.
 */
export class ReviewThreadResolutionService {
    constructor(private readonly catalog:Catalogue,private readonly rest:Rest,
        private readonly read:Pick<GitHubReviewThreadStateReader,'inspect'>,
        private readonly gateway:Pick<GitHubThreadResolutionGateway,'token'|'inspect'|'resolve'>,
        private readonly head:Head,
        private readonly enabled:ReadonlySet<string>=new Set()) {}

    private async ids(){
        const stores=await this.catalog.listStores(CODE_REVIEWS_PROJECT_ID);
        const runs=stores.find(x=>x.name===REVIEW_RUNS_STORE);
        const findings=stores.find(x=>x.name===REVIEW_FINDINGS_STORE);
        if(!runs||!findings)throw new AtlasError('Code Reviews Stores are unavailable.','CAPABILITY_UNAVAILABLE');
        return {runs:runs.id,findings:findings.id};
    }
    private related(state:AtlasData,id:Identity){
        const runs=state.records.filter(x=>x.projectId===CODE_REVIEWS_PROJECT_ID&&
            x.storeId===id.runs&&typeof x.data.repository==='string'&&
            x.data.repository.toLowerCase()===id.repository&&x.data.prNumber===id.prNumber);
        const ids=new Set(runs.map(x=>x.id));
        const findings=state.records.filter(x=>x.projectId===CODE_REVIEWS_PROJECT_ID&&
            x.storeId===id.findings&&ids.has(String(x.data.reviewRunId)));
        return {runs,findings};
    }
    private fingerprint(state:AtlasData,id:Identity){
        const related=this.related(state,id);
        return digest({runs:[...related.runs].sort((a,b)=>a.id.localeCompare(b.id)),
            findings:[...related.findings].sort((a,b)=>a.id.localeCompare(b.id))});
    }
    private setClaim(state:AtlasData,id:Identity,runId:string,lineage:string,claim:Claim){
        const run=this.related(state,id).runs.find(x=>x.id===runId&&!x.archivedAt);
        if(!run||!object(run.data.coverage))
            throw new AtlasError('Review run changed before resolution claim.','CONFLICT');
        const coverage=run.data.coverage;
        const previous=coverage.githubThreadResolutions;
        if(previous!==undefined&&(!object(previous)||Object.keys(previous).length>=30))
            throw new AtlasError('Resolution claim storage is unavailable.','CONFLICT');
        const entries:Record<string,unknown>=Object.assign(Object.create(null) as Record<string,unknown>,
            object(previous)?previous:{});
        if(Object.hasOwn(entries,lineage))
            throw new AtlasError('Resolution already attempted for this lineage.','CONFLICT');
        entries[lineage]=claim;
        this.catalog.updateRecordInState(state,{projectId:CODE_REVIEWS_PROJECT_ID,
            storeId:id.runs,recordId:runId,client:'atlas-review-thread-resolution',
            data:{coverage:{...coverage,githubThreadResolutions:entries}}});
    }
    private markPublished(state:AtlasData,id:Identity,runId:string,lineage:string,claim:Claim){
        const run=this.related(state,id).runs.find(x=>x.id===runId&&!x.archivedAt);
        const saved=run&&parsedClaim(run,lineage);
        if(!saved||saved.claimId!==claim.claimId||saved.state!=='claimed')
            throw new AtlasError('Resolution claim changed after GitHub mutation.','CONFLICT');
        const coverage=run!.data.coverage as Record<string,unknown>;
        const entries=Object.assign(Object.create(null) as Record<string,unknown>,
            coverage.githubThreadResolutions as Record<string,unknown>);
        entries[lineage]={...saved,state:'published'};
        this.catalog.updateRecordInState(state,{projectId:CODE_REVIEWS_PROJECT_ID,
            storeId:id.runs,recordId:runId,client:'atlas-review-thread-resolution',
            data:{coverage:{...coverage,githubThreadResolutions:entries}}});
    }
    private plan(state:AtlasData,id:Identity,runId:string,lineage:string,caller:ApplicationCaller):Plan{
        const {runs,findings}=this.related(state,id);
        if(runs.some(x=>x.archivedAt)||findings.some(x=>x.archivedAt))
            throw new AtlasError('Archived review history cannot authorize GitHub resolution.','CONFLICT');
        const ordered=[...runs].sort((a,b)=>
            String(b.data.reviewedAt).localeCompare(String(a.data.reviewedAt))||
            a.id.localeCompare(b.id));
        const run=runs.find(x=>x.id===runId&&!x.archivedAt);
        if(!run)
            throw new AtlasError('Review run is not available for this PR.','CONFLICT');
        // Existing one-shot claims remain reconcilable after a newer review.
        // A *new* mutation must still originate from the latest round.
        const existing=parsedClaim(run,lineage);
        if(!existing&&ordered[0]?.id!==runId)
            throw new AtlasError('Only the latest review run may initiate thread resolution.','CONFLICT');
        const coverage=run.data.coverage;
        const actor=object(coverage)&&object(coverage.authenticatedCaller)
            ?coverage.authenticatedCaller:null;
        if(!object(coverage)||coverage.source!=='atlas_structured_submission'||
            !actor||actor.kind!==caller.kind||actor.subject!==caller.subject||
            actor.issuer!==caller.issuer)
            throw new AtlasError('Only the authenticated submitting reviewer may resolve.','WORKSPACE_DENIED');
        if(typeof run.data.headSha!=='string'||!sha.test(run.data.headSha))
            throw new AtlasError('Reviewed SHA is invalid.','CONFLICT');
        const resolutions=coverage.lifecycleResolutions;
        if(!Array.isArray(resolutions)||resolutions.length>30||
            resolutions.filter(x=>object(x)&&x.lineageKey===lineage&&
                x.state==='resolved'&&x.assessmentSource==='authenticated_structured_submission'&&
                x.assessedHeadSha===run.data.headSha&&x.assertedAt===run.data.reviewedAt&&
                typeof x.evidence==='string'&&x.evidence.trim().length>=20).length!==1)
            throw new AtlasError('A complete explicit fix assessment is required.','CONFLICT');
        const fixEntries=coverage.githubFixReplies;
        const fix=object(fixEntries)&&Object.hasOwn(fixEntries,lineage)?fixEntries[lineage]:undefined;
        if(!object(fix)||fix.state!=='published'||fix.runId!==run.id||
            fix.lineageKey!==lineage||!positive(fix.rootCommentId)||
            !positive(fix.replyCommentId)||fix.headSha!==run.data.headSha||
            typeof fix.marker!=='string'||typeof fix.bodySha256!=='string'||
            !hex.test(fix.bodySha256)||
            fix.marker!==inlineFixMarker(id.repository,id.prNumber,fix.rootCommentId,runId,lineage)||
            typeof fix.rootMarker!=='string'||typeof fix.rootBodySha256!=='string'||
            !hex.test(fix.rootBodySha256))
            throw new AtlasError('Verified published fix reply receipt is required.','CONFLICT');
        const roots=findings.filter(x=>object(x.data.evidence)&&
            x.data.evidence.lineageKey===lineage&&object(x.data.evidence.githubInlineThread));
        if(roots.length!==1)
            throw new AtlasError('Exactly one original Atlas-managed root is required.','CONFLICT');
        const root=roots[0]!.data.evidence as Record<string,unknown>;
        const origin=root.githubInlineThread;
        const prior=runs.find(x=>x.id===roots[0]!.data.reviewRunId);
        if(!object(origin)||origin.state!=='published'||origin.findingId!==roots[0]!.id||
            origin.rootCommentId!==fix.rootCommentId||
            origin.marker!==fix.rootMarker||origin.bodySha256!==fix.rootBodySha256||
            origin.marker!==inlineThreadMarker(id.repository,id.prNumber,lineage)||
            typeof origin.bodySha256!=='string'||!hex.test(origin.bodySha256)||
            typeof origin.headSha!=='string'||!sha.test(origin.headSha)||
            !prior||prior.data.headSha!==origin.headSha||origin.headSha===run.data.headSha||
            typeof prior.data.reviewedAt!=='string'||typeof run.data.reviewedAt!=='string'||
            prior.data.reviewedAt>=run.data.reviewedAt||
            typeof origin.path!=='string'||!positive(origin.line))
            throw new AtlasError('Original published root identity is unverified.','CONFLICT');
        // No future review may auto-close an author-reopened root: once a
        // claim exists, even in a different run, no new attempt is allowed.
        for(const other of runs){
            if(other.id!==run.id&&parsedClaim(other,lineage))
                throw new AtlasError('This root already has a past resolution attempt.','CONFLICT');
        }
        return {run,claim:existing,
            threadRoot:{id:fix.rootCommentId as number,marker:origin.marker as string,
                bodySha256:origin.bodySha256 as string,
                originalCommitSha:origin.headSha as string,path:origin.path as string,
                line:origin.line as number},
            fix:{rootCommentId:fix.rootCommentId as number,
                replyCommentId:fix.replyCommentId as number,
                marker:fix.marker,bodySha256:fix.bodySha256}};
    }
    private verifyRemote(plan:Plan,rest:Awaited<ReturnType<Rest['inspect']>>,graph:Graph,
        repository:string,prNumber:number,expectedThreadId?:string){
        if(!graph.complete||graph.repository!==repository||graph.prNumber!==prNumber)
            throw new AtlasError('Complete GraphQL thread inventory is required.','CONFLICT');
        const root=rest.roots.filter(x=>x.id===plan.threadRoot.id&&
            x.marker===plan.threadRoot.marker&&x.bodySha256===plan.threadRoot.bodySha256&&
            x.originalCommitSha===plan.threadRoot.originalCommitSha&&
            x.path===plan.threadRoot.path&&x.originalLine===plan.threadRoot.line);
        const replies=rest.managedFixReplies.filter(x=>x.marker===plan.fix.marker&&
            x.id===plan.fix.replyCommentId&&x.parentId===plan.threadRoot.id&&
            x.bodySha256===plan.fix.bodySha256);
        if(root.length!==1||replies.length!==1||
            rest.managedFixReplies.filter(x=>x.marker===plan.fix.marker).length!==1||
            rest.copiedFixMarkers.includes(plan.fix.marker))
            throw new AtlasError('Bot root or published fix reply is not independently verified.','CONFLICT');
        const threads=graph.threads.filter(x=>x.rootCommentId===plan.threadRoot.id);
        if(threads.length!==1||threads[0]!.path!==plan.threadRoot.path||
            threads[0]!.originalLine!==plan.threadRoot.line||
            (expectedThreadId!==undefined&&threads[0]!.id!==expectedThreadId))
            throw new AtlasError('GitHub GraphQL thread identity or root location changed.','CONFLICT');
        return threads[0]!;
    }
    private async reconcile(id:Identity,runId:string,lineage:string,caller:ApplicationCaller,apply:boolean){
        const snapshot=await this.catalog.store.snapshot();
        const plan=this.plan(snapshot,id,runId,lineage,caller);
        const claim=plan.claim!;
        const [rest,graph]=await Promise.all([
            this.rest.inspect(id.repository,id.prNumber),this.read.inspect(id.repository,id.prNumber),
        ]);
        const thread=this.verifyRemote(plan,rest,graph,id.repository,id.prNumber,claim.threadId);
        // Never resend a claimed mutation, even when a remote read says open.
        // A resolved state after lost response could have been set by a human.
        const status=thread.isResolved
            ?claim.state==='published'?'resolved':'resolved_on_github_attribution_unknown'
            :claim.state==='published'?'reopened_after_publication':'mutation_outcome_uncertain';
        return {status,runId,lineageKey:lineage,threadId:thread.id,
            dryRun:!apply,mutatedAgain:false,remoteResolved:thread.isResolved};
    }
    async publish(repository:string,prNumber:number,runId:string,lineage:string,
        apply:boolean,caller?:ApplicationCaller){
        assertStructuredCaller(caller);
        repository=canonicalRepository(repository);
        if(!this.enabled.has(repository))
            throw new AtlasError('GitHub conversation resolution is disabled for this repository.','CAPABILITY_UNAVAILABLE');
        if(!positive(prNumber)||prNumber>1_000_000||!uuid.test(runId)||!key.test(lineage))
            throw new AtlasError('Invalid thread resolution input.','INVALID_REQUEST');
        const id:Identity={...(await this.ids()),repository,prNumber};
        const snapshot=await this.catalog.store.snapshot();
        const plan=this.plan(snapshot,id,runId,lineage,caller!);
        if(plan.claim)return this.reconcile(id,runId,lineage,caller!,apply);
        const timeline=await readPrTimeline(this.catalog,id,repository,prNumber,1,0,true);
        const latest=timeline.rounds[0];
        if(!latest||latest.runId!==runId||latest.source!=='structured'||
            latest.findingsTruncated||!latest.resolutions.some(x=>x.lineageKey===lineage))
            throw new AtlasError('A complete current structured resolution round is required.','CONFLICT');
        const fingerprint=this.fingerprint(snapshot,id);
        const [rest,graph]=await Promise.all([
            this.rest.inspect(repository,prNumber),this.read.inspect(repository,prNumber),
        ]);
        const thread=this.verifyRemote(plan,rest,graph,repository,prNumber);
        if(thread.isResolved)return {status:'already_resolved_on_github',dryRun:true,
            runId,lineageKey:lineage,threadId:thread.id,mutated:false};
        if(thread.isOutdated)
            throw new AtlasError('Outdated GitHub review threads require manual resolution.','CONFLICT');
        const ready={status:'ready',dryRun:!apply,runId,lineageKey:lineage,
            rootCommentId:plan.threadRoot.id,threadId:thread.id,
            reviewedHeadSha:plan.run.data.headSha,writePermissionVerified:false};
        if(!apply)return ready;
        await this.head.checkHead(repository,prNumber,plan.run.data.headSha as string);
        const token=await this.gateway.token(repository);
        const [writeGraph,writeRest]=await Promise.all([
            this.gateway.inspect(repository,prNumber,token),this.rest.inspect(repository,prNumber),
        ]);
        const writable=this.verifyRemote(plan,writeRest,writeGraph,repository,prNumber,thread.id);
        if(writable.isResolved||writable.isOutdated||!writable.viewerCanResolve)
            throw new AtlasError('Thread is resolved/outdated or write-token permission is missing.','CONFLICT');
        const claim:Claim={state:'claimed',claimId:randomUUID(),runId,lineageKey:lineage,
            rootCommentId:plan.threadRoot.id,threadId:thread.id,
            headSha:plan.run.data.headSha as string,fixReplyCommentId:plan.fix.replyCommentId,
            fixMarker:plan.fix.marker,fixBodySha256:plan.fix.bodySha256,
            claimedAt:new Date().toISOString()};
        await this.catalog.store.transaction(state=>{
            if(this.fingerprint(state,id)!==fingerprint)
                throw new AtlasError('Review history changed before resolution claim.','CONFLICT');
            const current=this.plan(state,id,runId,lineage,caller!);
            if(current.claim||current.fix.replyCommentId!==claim.fixReplyCommentId)
                throw new AtlasError('Resolution evidence changed during claim.','CONFLICT');
            this.setClaim(state,id,runId,lineage,claim);
        });
        // Once claimed, NO automatic claim removal. If any prewrite check
        // fails, leave a conservative claimed receipt requiring review.
        try {
            await this.head.checkHead(repository,prNumber,claim.headSha);
            const [freshGraph,freshRest]=await Promise.all([
                this.gateway.inspect(repository,prNumber,token),this.rest.inspect(repository,prNumber),
            ]);
            const fresh=this.verifyRemote(plan,freshRest,freshGraph,repository,prNumber,claim.threadId);
            if(fresh.isOutdated||fresh.isResolved||!fresh.viewerCanResolve)
                throw new AtlasError('GitHub thread state changed before mutation.','CONFLICT');
        }catch{
            return {status:'prewrite_recovery_required',dryRun:false,
                runId,lineageKey:lineage,threadId:claim.threadId,mutated:false};
        }
        try {await this.gateway.resolve(claim.threadId,token)}
        catch {return {status:'mutation_outcome_uncertain',dryRun:false,
            runId,lineageKey:lineage,threadId:claim.threadId,mutatedAgain:false}}
        try {
            const [afterGraph,afterRest]=await Promise.all([
                this.gateway.inspect(repository,prNumber,token),this.rest.inspect(repository,prNumber),
            ]);
            const after=this.verifyRemote(plan,afterRest,afterGraph,repository,prNumber,claim.threadId);
            if(!after.isResolved)throw new AtlasError('GitHub thread read-back is open.','CONFLICT');
            await this.catalog.store.transaction(state=>
                this.markPublished(state,id,runId,lineage,claim));
            return {status:'resolved',dryRun:false,runId,lineageKey:lineage,
                threadId:claim.threadId,mutated:true};
        }catch {
            return {status:'mutation_outcome_uncertain',dryRun:false,
                runId,lineageKey:lineage,threadId:claim.threadId,mutatedAgain:false};
        }
    }
}
