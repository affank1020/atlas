import { AtlasError } from '../shared/errors.js';
import type { GitHubBroker } from '../workspaces/github-broker.js';
import { canonicalRepository } from './managed-summary.js';
import { inlineThreadMarker, type GitHubInlineThreadReader, type InlineThreadInventoryService } from './inline-thread-inventory.js';

type Broker = Pick<GitHubBroker, 'pullRequestReadToken'>;
type RootReader = Pick<GitHubInlineThreadReader, 'inspect'>;
type AtlasInventory = Pick<InlineThreadInventoryService, 'preview'>;
type Thread = { id: string; rootCommentId: number; path: string; originalLine: number | null;
    isResolved: boolean; isOutdated: boolean; viewerCanResolve: boolean };
const object = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object' && !Array.isArray(x);
const positive = (x: unknown): x is number =>
    typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const nodeId = (x: unknown): x is string =>
    typeof x === 'string' && /^[A-Za-z0-9_+/=-]{8,256}$/.test(x);
const rootId = (x: unknown): number | null => {
    if (positive(x)) return x;
    if (typeof x !== 'string' || !/^[1-9][0-9]{0,19}$/.test(x)) return null;
    const number = Number(x);
    return positive(number) && String(number) === x ? number : null;
};
const GRAPHQL = `query AtlasReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100,after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated viewerCanResolve path originalLine
          comments(first:1) { nodes { fullDatabaseId } }
        }
      }
    }
  }
}`;

/** Independently maps REST root review-comment IDs to actual GraphQL thread IDs.
 * This is read-only and never infers source-code fixes from isResolved.
 * All bounded pages must be loaded, including unrelated GitHub threads.
 */
export class GitHubReviewThreadStateReader {
    constructor(private readonly broker: Broker, private readonly http: typeof fetch = fetch) {}

    async inspect(repository: string, prNumber: number) {
        repository = canonicalRepository(repository);
        if (!positive(prNumber) || prNumber > 1_000_000)
            throw new AtlasError('Invalid review-thread PR number.', 'INVALID_REQUEST');
        const token = await this.broker.pullRequestReadToken(repository);
        const [owner, name] = repository.split('/');
        const threads: Thread[] = [];
        const ids = new Set<string>();
        const roots = new Set<number>();
        const cursors = new Set<string>();
        let after: string | null = null;
        for (let page = 1; page <= 5; page++) {
            let response: Response;
            try {
                response = await this.http('https://api.github.com/graphql', {
                    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
                    headers: { Authorization: 'Bearer ' + token,
                        Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
                    body: JSON.stringify({query: GRAPHQL,variables:{owner,name,number:prNumber,after}}),
                });
            } catch {
                throw new AtlasError('GitHub GraphQL thread inventory is unavailable.', 'GITHUB_UNAVAILABLE');
            }
            if (!response.ok)
                throw new AtlasError('GitHub GraphQL thread inventory rejected HTTP ' +
                    response.status + '.', 'GITHUB_REQUEST_FAILED');
            let data: unknown;
            try { data = await response.json(); } catch {
                throw new AtlasError('GitHub GraphQL returned invalid JSON.', 'GITHUB_REQUEST_FAILED');
            }
            // A successful HTTP response may still contain GraphQL errors.
            if (!object(data) || data.errors !== undefined ||
                !object(data.data) || !object(data.data.repository) ||
                !object(data.data.repository.pullRequest) ||
                !object(data.data.repository.pullRequest.reviewThreads))
                throw new AtlasError('GitHub GraphQL thread inventory is incomplete.', 'GITHUB_REQUEST_FAILED');
            const connection = data.data.repository.pullRequest.reviewThreads;
            if (!object(connection.pageInfo) || !Array.isArray(connection.nodes) ||
                connection.nodes.length > 100 || typeof connection.pageInfo.hasNextPage !== 'boolean')
                throw new AtlasError('GitHub GraphQL thread page is malformed.', 'GITHUB_REQUEST_FAILED');
            for (const thread of connection.nodes) {
                if (!object(thread) || !nodeId(thread.id) || ids.has(thread.id) ||
                    typeof thread.isResolved !== 'boolean' || typeof thread.isOutdated !== 'boolean' ||
                    typeof thread.viewerCanResolve !== 'boolean' ||
                    typeof thread.path !== 'string' || thread.path.length === 0 ||
                    thread.path.length > 1024 ||
                    (thread.originalLine !== null && !positive(thread.originalLine)) ||
                    !object(thread.comments) || !Array.isArray(thread.comments.nodes) ||
                    thread.comments.nodes.length !== 1 ||
                    !object(thread.comments.nodes[0]))
                    throw new AtlasError('GitHub GraphQL review-thread identity is malformed.', 'GITHUB_REQUEST_FAILED');
                // fullDatabaseId is GitHub's non-deprecated 64-bit ID. Reject
                // values that cannot be matched safely against REST comment IDs.
                const first = rootId(thread.comments.nodes[0].fullDatabaseId);
                if (!first || roots.has(first))
                    throw new AtlasError('GitHub GraphQL root comment mapping is ambiguous.', 'CONFLICT');
                ids.add(thread.id); roots.add(first);
                threads.push({id:thread.id,rootCommentId:first,path:thread.path,
                    originalLine:thread.originalLine,isResolved:thread.isResolved,
                    isOutdated:thread.isOutdated,viewerCanResolve:thread.viewerCanResolve});
            }
            if (connection.pageInfo.hasNextPage === false) {
                if (connection.pageInfo.endCursor !== null &&
                    typeof connection.pageInfo.endCursor !== 'string')
                    throw new AtlasError('GitHub GraphQL final cursor is malformed.', 'GITHUB_REQUEST_FAILED');
                return {repository,prNumber,threads,complete:true,readOnly:true,
                    resolutionSupported:false,checkedPages:page};
            }
            const cursor = connection.pageInfo.endCursor;
            if (typeof cursor !== 'string' || !cursor || cursor.length > 2048 ||
                cursors.has(cursor) || cursor === after || connection.nodes.length === 0)
                throw new AtlasError('GitHub GraphQL pagination is stalled.', 'GITHUB_REQUEST_FAILED');
            cursors.add(cursor); after = cursor;
        }
        throw new AtlasError('GitHub GraphQL review-thread inventory exceeds five complete pages.', 'CAPABILITY_UNAVAILABLE');
    }
}

/** Joins the independently verified REST App Bot roots to GraphQL IDs.
 * No graph thread can be adopted from a matching comment marker alone.
 * REST and GraphQL must agree on the original file path and line.
 */
export class ReviewThreadStateService {
    constructor(private readonly saved: AtlasInventory, private readonly rest: RootReader,
        private readonly graphql: Pick<GitHubReviewThreadStateReader, 'inspect'>) {}

    async preview(repository: string, prNumber: number) {
        repository = canonicalRepository(repository);
        const [atlas, rest, graph] = await Promise.all([
            this.saved.preview(repository,prNumber),this.rest.inspect(repository,prNumber),
            this.graphql.inspect(repository,prNumber),
        ]);
        if (!graph.complete || graph.repository !== repository || graph.prNumber !== prNumber)
            throw new AtlasError('GitHub review-thread mapping is incomplete.', 'CONFLICT');
        const byRoot = new Map(graph.threads.map(thread=>[thread.rootCommentId,thread]));
        const joined = rest.roots.map(root=>{
            const found = byRoot.get(root.id);
            if (!found) return {rootCommentId:root.id,marker:root.marker,
                mappingState:'unmapped' as const,resolutionState:'unknown' as const};
            if (found.path !== root.path || found.originalLine !== root.originalLine)
                throw new AtlasError('GitHub REST and GraphQL root locations disagree.', 'CONFLICT');
            return {rootCommentId:root.id,marker:root.marker,
                mappingState:'verified' as const,threadId:found.id,
                resolutionState:found.isResolved ? 'resolved_on_github' as const
                    : 'open_on_github' as const,
                isOutdated:found.isOutdated,
                viewerCanResolveWithReadToken:found.viewerCanResolve};
        });
        const mapped = new Map(joined.map(root=>[root.marker,root]));
        const asResolution = (item: {lineageKey:string; rootCommentId?:number})=>{
            const marker = inlineThreadMarker(repository,prNumber,item.lineageKey);
            const root = mapped.get(marker);
            return {lineageKey:item.lineageKey,
                ...(root ? {thread:root} : {thread:{mappingState:'unmapped' as const,
                    resolutionState:'unknown' as const}})};
        };
        return {
            repository,prNumber,readOnly:true,resolutionSupported:false,
            status:atlas.status,latestReviewRunId:'runId' in atlas ? atlas.runId : undefined,
            latestReviewHead:'reviewedHeadSha' in atlas ? atlas.reviewedHeadSha : undefined,
            totalGitHubThreads:graph.threads.length,ownedRootCount:joined.length,
            mappedOwnedRoots:joined.filter(root=>root.mappingState==='verified').length,
            mappingComplete:joined.every(root=>root.mappingState==='verified'),
            ownedThreads:joined,
            resolutions:'resolutions' in atlas ? atlas.resolutions.map(asResolution) : [],
            // Remote GitHub resolution and reviewer source-code lifecycle remain independent.
            reviewerStateDoesNotFollowGitHubResolution:true,
        };
    }
}
