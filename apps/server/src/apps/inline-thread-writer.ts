import { AtlasError } from '../shared/errors.js';
import type { GitHubBroker } from '../workspaces/github-broker.js';
import { canonicalRepository } from './managed-summary.js';

type Access = Pick<GitHubBroker, 'pullRequestReadToken' | 'pullRequestPublishToken'>;
const sha = /^[a-f0-9]{40}$/i;
const positive = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
export type InlineRootTarget = {
    headSha: string; path: string; line: number;
};

/** An explicit GitHub client rejection of an initial POST, not a timeout or
 * server error. Even this is insufficient to clear a durable claim until a
 * separate, complete Bot-owned thread inventory confirms no matching root.
 */
export class GitHubInlineRootRejectedError extends AtlasError {
    constructor(readonly httpStatus: 403 | 422) {
        super('GitHub explicitly rejected initial inline root POST (HTTP ' +
            httpStatus + ').', 'GITHUB_REQUEST_FAILED');
    }
}

/** A scoped GitHub REST writer. Its response is NEVER a durable receipt:
 * the caller independently re-reads the verified Bot-owned root inventory.
 */
export class GitHubInlineRootWriter {
    constructor(private readonly broker: Access, private readonly http: typeof fetch = fetch) {}

    private async request(repository: string, path: string, token: string,
        method: 'GET' | 'POST', body?: Record<string, unknown>) {
        repository = canonicalRepository(repository);
        let response: Response;
        try {
            response = await this.http('https://api.github.com/repos/' + repository + path, {
                method, redirect: 'error', signal: AbortSignal.timeout(15_000),
                headers: {
                    Authorization: 'Bearer ' + token,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
        } catch {
            throw new AtlasError('GitHub inline write request outcome is uncertain.', 'GITHUB_UNAVAILABLE');
        }
        if (!response.ok) {
            // Strict status allowlist: do not assume a 5xx response, network
            // timeout, malformed response or unexpected status means no write.
            // Only the initial POST can produce this typed rejection.
            if (method === 'POST' && (response.status === 403 || response.status === 422))
                throw new GitHubInlineRootRejectedError(response.status);
            throw new AtlasError('GitHub inline endpoint returned HTTP ' +
                response.status + '.', 'GITHUB_REQUEST_FAILED');
        }
        let data: unknown;
        try { data = await response.json(); }
        catch { throw new AtlasError('GitHub inline endpoint returned malformed JSON.', 'GITHUB_REQUEST_FAILED'); }
        if (!object(data))
            throw new AtlasError('GitHub inline endpoint returned malformed object.', 'GITHUB_REQUEST_FAILED');
        return data;
    }

    async checkHead(repository: string, prNumber: number, reviewedHead: string) {
        repository = canonicalRepository(repository);
        if (!positive(prNumber) || prNumber > 1_000_000 || !sha.test(reviewedHead))
            throw new AtlasError('Invalid inline publication PR identity.', 'INVALID_REQUEST');
        const token = await this.broker.pullRequestReadToken(repository);
        const data = await this.request(repository, '/pulls/' + prNumber, token, 'GET');
        const head = object(data.head) ? data.head : {};
        const base = object(data.base) ? data.base : {};
        const repo = object(base.repo) ? base.repo : {};
        if (data.number !== prNumber || typeof repo.full_name !== 'string' ||
            repo.full_name.toLowerCase() !== repository ||
            typeof head.sha !== 'string' || !sha.test(head.sha))
            throw new AtlasError('GitHub inline publication PR cannot be verified.', 'GITHUB_REQUEST_FAILED');
        if (data.state !== 'open' || head.sha.toLowerCase() !== reviewedHead.toLowerCase())
            throw new AtlasError('PR head changed or closed before inline publication.', 'CONFLICT');
    }

    async prepareWrite(repository: string) {
        return this.broker.pullRequestPublishToken(canonicalRepository(repository));
    }

    async post(repository: string, prNumber: number, target: InlineRootTarget,
        body: string, token: string) {
        if (!positive(prNumber) || prNumber > 1_000_000 || !sha.test(target.headSha) ||
            typeof target.path !== 'string' || !target.path || target.path.length > 1024 ||
            !positive(target.line) || target.line > 10_000_000 ||
            typeof body !== 'string' || body.length < 1 || body.length > 8_000)
            throw new AtlasError('Invalid inline comment payload.', 'INVALID_REQUEST');
        const data = await this.request(repository, '/pulls/' + prNumber + '/comments',
            token, 'POST', { body, commit_id: target.headSha,
                path: target.path, line: target.line, side: 'RIGHT' });
        if (!positive(data.id))
            throw new AtlasError('GitHub inline root response lacks valid ID.', 'GITHUB_REQUEST_FAILED');
        return data.id;
    }
}
