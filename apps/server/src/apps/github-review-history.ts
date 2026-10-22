import { AtlasError } from '../shared/errors.js';
import type { GitHubBroker } from '../workspaces/github-broker.js';

const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const MAX_TEXT = 30_000;

export type GitHubReview = {
    id: number;
    body: string | null;
    commit_id: string | null;
    submitted_at: string | null;
    state: string;
    html_url: string;
    user: { login: string } | null;
};
export type GitHubInlineComment = {
    id: number;
    pull_request_review_id: number | null;
    body: string;
    html_url: string;
    path: string;
    line?: number | null;
    original_line?: number | null;
};

const safeInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const sourceDate = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
const textValue = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT;

function isReview(value: any): value is GitHubReview {
    return value && safeInt(value.id) && (value.body === null || textValue(value.body)) &&
        (value.commit_id === null || sha(value.commit_id)) &&
        (value.submitted_at === null || sourceDate(value.submitted_at)) && textValue(value.state) &&
        typeof value.html_url === 'string' && value.html_url.length < 500 &&
        (value.user === null || (typeof value.user?.login === 'string' && value.user.login.length < 150));
}
function isInline(value: any): value is GitHubInlineComment {
    return value && safeInt(value.id) && (value.pull_request_review_id == null || safeInt(value.pull_request_review_id)) &&
        textValue(value.body) && typeof value.html_url === 'string' && value.html_url.length < 500 &&
        typeof value.path === 'string' && value.path.length < 4096 &&
        (value.line == null || safeInt(value.line)) &&
        (value.original_line == null || safeInt(value.original_line));
}

export class GitHubReviewHistoryReader {
    constructor(
        private readonly broker: Pick<GitHubBroker, 'pullRequestReadToken'>,
        private readonly http: typeof fetch = fetch,
    ) {}

    private async list<T>(repository: string, number: number, resource: 'reviews' | 'comments',
        bearer: string, accept: (value: any) => value is T): Promise<T[]> {
        const [owner, name] = repository.split('/');
        const collected: T[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            let response: Response;
            try {
                response = await this.http(
                    `https://api.github.com/repos/${owner}/${name}/pulls/${number}/${resource}?per_page=${PAGE_SIZE}&page=${page}`,
                    { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
                        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.github+json',
                            'X-GitHub-Api-Version': '2022-11-28' } },
                );
            } catch {
                throw new AtlasError('GitHub review history is unavailable.', 'GITHUB_UNAVAILABLE');
            }
            if (!response.ok)
                throw new AtlasError(`GitHub review history request failed (HTTP ${response.status}).`, 'GITHUB_REQUEST_FAILED');
            const entries: unknown = await response.json().catch(() => null);
            if (!Array.isArray(entries) || entries.length > PAGE_SIZE || entries.some(item => !accept(item)))
                throw new AtlasError('GitHub review history contained unsupported data.', 'GITHUB_REQUEST_FAILED');
            collected.push(...entries);
            if (entries.length < PAGE_SIZE) return collected;
        }
        // Never import a partial timeline; extend pagination before accepting large PRs.
        throw new AtlasError('GitHub review history exceeds the supported 500-item limit.', 'CAPABILITY_UNAVAILABLE');
    }

    async read(repository: string, prNumber: number) {
        if (!repoName.test(repository) || !Number.isSafeInteger(prNumber) || prNumber < 1 || prNumber > 1_000_000)
            throw new AtlasError('Invalid GitHub pull request identity.', 'INVALID_REQUEST');
        const token = await this.broker.pullRequestReadToken(repository);
        const reviews = await this.list(repository, prNumber, 'reviews', token, isReview);
        const comments = await this.list(repository, prNumber, 'comments', token, isInline);
        return { reviews, comments };
    }
}
