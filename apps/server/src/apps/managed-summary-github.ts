import { AtlasError } from '../shared/errors.js';
import type { GitHubBroker } from '../workspaces/github-broker.js';
import { canonicalRepository } from './managed-summary.js';

type Access = Pick<GitHubBroker, 'pullRequestReadToken' | 'pullRequestPublishToken'>;
const sha = /^[a-f0-9]{40}$/i;
const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Strict GitHub issue-comment writer. All writes are called only *after*
 * a durable, transactionally exclusive claim has been persisted by Atlas.
 * The HTTP response is not a receipt: a separate Bot-owned read must verify it.
 */
export class GitHubManagedSummaryWriter {
    constructor(private readonly broker: Access, private readonly http: typeof fetch = fetch) {}

    private async request(repository: string, path: string, token: string,
        method: 'GET' | 'POST' | 'PATCH', data?: object) {
        repository = canonicalRepository(repository);
        let response: Response;
        try {
            response = await this.http('https://api.github.com/repos/' + repository + path, {
                method, redirect: 'error', signal: AbortSignal.timeout(15_000),
                headers: {
                    Authorization: 'Bearer ' + token,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    ...(data ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(data ? { body: JSON.stringify(data) } : {}),
            });
        } catch {
            throw new AtlasError('GitHub managed summary request outcome is uncertain.', 'GITHUB_UNAVAILABLE');
        }
        if (!response.ok)
            throw new AtlasError('GitHub managed summary API returned HTTP ' + response.status + '.', 'GITHUB_REQUEST_FAILED');
        let result: unknown;
        try { result = await response.json(); }
        catch { throw new AtlasError('GitHub managed summary API returned invalid JSON.', 'GITHUB_REQUEST_FAILED'); }
        if (!object(result))
            throw new AtlasError('GitHub managed summary API returned an invalid response.', 'GITHUB_REQUEST_FAILED');
        return result;
    }

    async checkHead(repository: string, prNumber: number, reviewedSha: string) {
        repository = canonicalRepository(repository);
        if (!positive(prNumber) || !sha.test(reviewedSha))
            throw new AtlasError('Invalid managed summary publication identity.', 'INVALID_REQUEST');
        const token = await this.broker.pullRequestReadToken(repository);
        const response = await this.request(repository, '/pulls/' + prNumber, token, 'GET');
        const head = object(response.head) ? response.head : {};
        const base = object(response.base) ? response.base : {};
        const baseRepo = object(base.repo) ? base.repo : {};
        if (response.number !== prNumber ||
            typeof baseRepo.full_name !== 'string' ||
            baseRepo.full_name.toLowerCase() !== repository ||
            typeof head.sha !== 'string' || !sha.test(head.sha))
            throw new AtlasError('GitHub PR identity could not be verified.', 'GITHUB_REQUEST_FAILED');
        if (response.state !== 'open' || head.sha.toLowerCase() !== reviewedSha.toLowerCase())
            throw new AtlasError('PR is closed or its head advanced; a new review is required.', 'CONFLICT');
    }

    async prepareWrite(repository: string) {
        return this.broker.pullRequestPublishToken(canonicalRepository(repository));
    }

    async post(repository: string, prNumber: number, body: string, token: string) {
        if (!positive(prNumber))
            throw new AtlasError('Invalid GitHub PR number.', 'INVALID_REQUEST');
        const response = await this.request(repository,
            '/issues/' + prNumber + '/comments', token, 'POST', { body });
        if (!positive(response.id))
            throw new AtlasError('GitHub create outcome could not be verified.', 'GITHUB_REQUEST_FAILED');
        return response.id;
    }

    async patch(repository: string, commentId: number, body: string, token: string) {
        if (!positive(commentId))
            throw new AtlasError('Invalid GitHub comment ID.', 'INVALID_REQUEST');
        const response = await this.request(repository,
            '/issues/comments/' + commentId, token, 'PATCH', { body });
        if (response.id !== commentId)
            throw new AtlasError('GitHub update outcome could not be verified.', 'GITHUB_REQUEST_FAILED');
        return commentId;
    }
}
