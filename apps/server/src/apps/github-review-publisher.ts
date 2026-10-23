import { AtlasError } from '../shared/errors.js';
import type { GitHubBroker } from '../workspaces/github-broker.js';

const sha = /^[0-9a-f]{40}$/i;
const repoPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const id = /^[0-9a-f-]{36}$/i;
type Access = Pick<GitHubBroker, 'pullRequestReadToken' | 'pullRequestPublishToken'>;

export type InlineFinding = { key: string; path: string; line: number; body: string };
export type PublishFinding = { key: string; severity: string; title: string; description: string; path?: string; line?: number };
export type PublishPayload = { runId: string; repository: string; prNumber: number; headSha: string; summary?: string; verdict: string; findings: PublishFinding[] };
type RemoteReview = { id: number; body: string; commit_id: string; html_url: string; state: string };

function safeJson(response: Response): Promise<unknown> {
    return response.json().catch(() => {
        throw new AtlasError('GitHub returned malformed JSON.', 'GITHUB_REQUEST_FAILED');
    });
}
function positive(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function safeText(value: unknown, max: number): value is string {
    return typeof value === 'string' && value.length <= max;
}
function escapeMarker(value: string) {
    return value.replaceAll('<!--', '&lt;!--');
}
function changedLines(patch: string): Set<number> {
    const lines = new Set<number>();
    let right = -1;
    for (const row of patch.split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
        if (hunk) { right = Number(hunk[1]); continue; }
        if (right < 0) continue;
        if (row.startsWith('+')) { lines.add(right); right++; }
        else if (row.startsWith(' ')) right++;
        else if (row.startsWith('-') || row.startsWith('\\')) { /* old-side only */ }
        else right = -1;
    }
    return lines;
}
export function renderReview(payload: PublishPayload) {
    if (!id.test(payload.runId) || !repoPattern.test(payload.repository) ||
        !positive(payload.prNumber) || !sha.test(payload.headSha) ||
        payload.findings.length > 30) throw new AtlasError('Invalid review publication identity.', 'INVALID_REQUEST');
    const marker = '<!-- atlas-code-review-run:' + payload.runId.toLowerCase() + ' -->';
    const entries = payload.findings.map(item =>
        '- **' + escapeMarker(item.severity.toUpperCase()) + ' · ' + escapeMarker(item.title) + '**' +
        (item.path ? ' — ' + escapeMarker(item.path) + (item.line ? ':' + item.line : '') : '') +
        '\n  ' + escapeMarker(item.description).slice(0, 900));
    const body = [
        '## Atlas Code Review · PR #' + payload.prNumber,
        '**Verdict:** ' + escapeMarker(payload.verdict),
        ...(payload.summary ? ['', escapeMarker(payload.summary)] : []),
        '', ...(entries.length ? ['### Findings', ...entries] : ['No structured findings.']),
        '', marker,
    ].join('\n');
    if (body.length > 30_000) throw new AtlasError('Review body exceeds safe publication limit.', 'INVALID_REQUEST');
    return { body, marker };
}

export class GitHubReviewPublisher {
    constructor(private readonly broker: Access, private readonly http: typeof fetch = fetch) {}

    private async request(repository: string, endpoint: string, token: string, options: { method?: string; data?: object } = {}) {
        if (!repoPattern.test(repository)) throw new AtlasError('Invalid GitHub repository.', 'INVALID_REQUEST');
        const method = options.method || 'GET';
        const url = 'https://api.github.com/repos/' + repository + endpoint;
        let response: Response;
        try {
            response = await this.http(url, {
                method, redirect: 'error', signal: AbortSignal.timeout(15_000),
                headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    ...(options.data ? { 'Content-Type': 'application/json' } : {}) },
                ...(options.data ? { body: JSON.stringify(options.data) } : {}),
            });
        } catch {
            throw new AtlasError('GitHub review publication request outcome is uncertain.', 'GITHUB_UNAVAILABLE');
        }
        if (!response.ok) throw new AtlasError('GitHub review API returned HTTP ' + response.status + '.', 'GITHUB_REQUEST_FAILED');
        return safeJson(response);
    }

    async checkHead(payload: PublishPayload) {
        const token = await this.broker.pullRequestReadToken(payload.repository);
        const data: any = await this.request(payload.repository, '/pulls/' + payload.prNumber, token);
        if (data?.number !== payload.prNumber || data?.base?.repo?.full_name?.toLowerCase() !== payload.repository.toLowerCase() ||
            typeof data?.head?.sha !== 'string' || !sha.test(data.head.sha))
            throw new AtlasError('GitHub pull request identity could not be verified.', 'GITHUB_REQUEST_FAILED');
        if (data.state !== 'open' || data.head.sha.toLowerCase() !== payload.headSha.toLowerCase())
            throw new AtlasError('GitHub PR closed or head changed; publication refused.', 'CONFLICT');
        return token;
    }

    /** Never infer a safe inline position from an old line or a raw file path.
     * Only added RIGHT-side lines visible in GitHub's current diff are eligible.
     */
    async inlineComments(payload: PublishPayload, token: string, includeInline: boolean) {
        if (!includeInline) return [] as { path: string; line: number; side: 'RIGHT'; body: string }[];
        if (!payload.findings.length || payload.findings.length > 20 ||
            payload.findings.some(f => !f.path || !positive(f.line)))
            throw new AtlasError('Inline publication needs 1–20 findings, each with a new-side path and line.', 'INVALID_REQUEST');
        const response: any = await this.request(payload.repository,
            '/pulls/' + payload.prNumber + '/files?per_page=100&page=1', token);
        if (!Array.isArray(response) || response.length >= 100 ||
            response.some(item => !safeText(item?.filename, 4096) || !['added','modified','renamed','copied','changed','removed'].includes(item.status)))
            throw new AtlasError('GitHub diff file list is incomplete or unsupported.', 'GITHUB_REQUEST_FAILED');
        const diff = new Map<string, Set<number>>();
        for (const file of response) {
            if (typeof file.patch === 'string' && file.patch.length < 200_000)
                diff.set(file.filename, changedLines(file.patch));
        }
        const used = new Set<string>();
        return payload.findings.map(item => {
            if (!diff.get(item.path!)?.has(item.line!))
                throw new AtlasError('Inline finding is not on an added RIGHT-side line of the current PR diff.', 'CONFLICT');
            const identity = item.path + ':' + item.line;
            if (used.has(identity)) throw new AtlasError('Duplicate inline file/line position.', 'INVALID_REQUEST');
            used.add(identity);
            return {
                path: item.path!, line: item.line!, side: 'RIGHT' as const,
                body: '**' + item.severity.toUpperCase() + ' · ' + escapeMarker(item.title) + '**\n\n' +
                    escapeMarker(item.description).slice(0, 6000),
            };
        });
    }

    async findPublished(payload: PublishPayload, marker: string, token?: string): Promise<RemoteReview | undefined> {
        const bearer = token ?? await this.broker.pullRequestReadToken(payload.repository);
        const matched: RemoteReview[] = [];
        for (let page = 1; page <= 5; page++) {
            const data: any = await this.request(payload.repository, '/pulls/' + payload.prNumber +
                '/reviews?per_page=100&page=' + page, bearer);
            if (!Array.isArray(data) || data.length > 100) throw new AtlasError('Incomplete GitHub review list.', 'GITHUB_REQUEST_FAILED');
            for (const item of data) {
                if (!(item?.body === null || safeText(item?.body, 35_000)) || !positive(item?.id) ||
                    !safeText(item?.commit_id, 40) || !safeText(item?.html_url, 500))
                    throw new AtlasError('Malformed GitHub review list.', 'GITHUB_REQUEST_FAILED');
                if (typeof item.body === 'string' && item.body.endsWith(marker) &&
                    item.commit_id.toLowerCase() === payload.headSha.toLowerCase()) {
                    if (item.state !== 'COMMENTED') throw new AtlasError('Unexpected GitHub review event.', 'CONFLICT');
                    matched.push(item);
                }
            }
            if (data.length < 100) {
                if (matched.length > 1) throw new AtlasError('Multiple GitHub reviews with this Atlas run ID.', 'CONFLICT');
                return matched[0];
            }
        }
        throw new AtlasError('GitHub review list pagination bound exceeded.', 'CAPABILITY_UNAVAILABLE');
    }

    async prepareWrite(repository: string) {
        return this.broker.pullRequestPublishToken(repository);
    }

    async publish(payload: PublishPayload, body: string,
        comments: { path: string; line: number; side: 'RIGHT'; body: string }[], preparedToken?: string) {
        const bearer = preparedToken ?? await this.prepareWrite(payload.repository);
        const data: any = await this.request(payload.repository, '/pulls/' + payload.prNumber + '/reviews', bearer, {
            method: 'POST', data: { commit_id: payload.headSha, event: 'COMMENT', body, comments },
        });
        if (!positive(data?.id) || !safeText(data?.html_url, 500) ||
            typeof data?.commit_id !== 'string' || data.commit_id.toLowerCase() !== payload.headSha.toLowerCase())
            throw new AtlasError('GitHub publication outcome cannot be verified.', 'GITHUB_REQUEST_FAILED');
        return { id: data.id as number, url: data.html_url as string };
    }
}
