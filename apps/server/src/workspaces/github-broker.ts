import { createSign } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';

const repositoryPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const branchPattern = /^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/;

type Transport = typeof fetch;
type TokenResponse = { token?: string; repositories?: { full_name: string }[] };
type RefResponse = { object?: { sha?: string } };
type PrResponse = { number?: number; html_url?: string; draft?: boolean };

export class GitHubBroker {
    constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly http: Transport = fetch) {}

    approve(workspaceId: string, repository: string) {
        if (!repositoryPattern.test(repository)) throw new AtlasError('Invalid GitHub repository.', 'INVALID_REQUEST');
        let allowlist: Record<string, string>;
        try { allowlist = JSON.parse(this.env.ATLAS_GITHUB_WORKSPACE_REPOSITORIES || '{}'); }
        catch { throw new AtlasError('GitHub Workspace allowlist is malformed.', 'CAPABILITY_UNAVAILABLE'); }
        if (!allowlist || Array.isArray(allowlist) || typeof allowlist !== 'object' ||
            !Object.hasOwn(allowlist, workspaceId) || allowlist[workspaceId] !== repository)
            throw new AtlasError('This Workspace and repository are not approved for GitHub publishing.', 'WORKSPACE_DENIED');
        if (!this.env.ATLAS_GITHUB_APP_ID || !this.env.ATLAS_GITHUB_INSTALLATION_ID || !this.env.ATLAS_GITHUB_APP_PRIVATE_KEY_PEM)
            throw new AtlasError('GitHub App broker is not configured.', 'CAPABILITY_UNAVAILABLE');
    }

    private jwt() {
        const id = this.env.ATLAS_GITHUB_APP_ID!;
        if (!/^\d+$/.test(id)) throw new AtlasError('GitHub App configuration is invalid.', 'CAPABILITY_UNAVAILABLE');
        const now = Math.floor(Date.now() / 1000);
        const payload = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const unsigned = `${payload({ alg: 'RS256', typ: 'JWT' })}.${payload({ iat: now - 60, exp: now + 540, iss: id })}`;
        try {
            const signer = createSign('RSA-SHA256');
            signer.update(unsigned);
            signer.end();
            return `${unsigned}.${signer.sign(this.env.ATLAS_GITHUB_APP_PRIVATE_KEY_PEM!.replace(/\\n/g, '\n'), 'base64url')}`;
        } catch {
            throw new AtlasError('GitHub App signing key is invalid.', 'CAPABILITY_UNAVAILABLE');
        }
    }

    private async request(path: string, method: string, bearer: string, body?: object) {
        let response: Response;
        try {
            response = await this.http(`https://api.github.com${path}`, {
                method, redirect: 'error', signal: AbortSignal.timeout(15000),
                headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                    Authorization: `Bearer ${bearer}`, ...(body && { 'Content-Type': 'application/json' }) },
                ...(body && { body: JSON.stringify(body) }),
            });
        } catch {
            throw new AtlasError('GitHub request could not be completed.', 'GITHUB_UNAVAILABLE');
        }
        // Never echo GitHub's response body (which may include sensitive operational data).
        if (!response.ok) throw new AtlasError(`GitHub rejected the request (HTTP ${response.status}).`, 'GITHUB_REQUEST_FAILED');
        return response.json() as Promise<unknown>;
    }

    async installationToken(repository: string) {
        const installation = this.env.ATLAS_GITHUB_INSTALLATION_ID!;
        if (!/^\d+$/.test(installation)) throw new AtlasError('GitHub App configuration is invalid.', 'CAPABILITY_UNAVAILABLE');
        const name = repository.split('/')[1]!;
        const result = await this.request(`/app/installations/${installation}/access_tokens`, 'POST', this.jwt(),
            { repositories: [name], permissions: { contents: 'write', pull_requests: 'write' } }) as TokenResponse;
        if (!result.token || !result.repositories?.some(item => item.full_name === repository))
            throw new AtlasError('GitHub App token is not scoped to the approved repository.', 'WORKSPACE_DENIED');
        return result.token;
    }

    async createDraftPullRequest(repository: string, branch: string, expectedHead: string, title: string, body = '') {
        if (!branchPattern.test(branch) || branch.includes('//') || branch.endsWith('/') || !/^[a-f0-9]{40}$/.test(expectedHead))
            throw new AtlasError('Invalid GitHub PR branch or commit.', 'INVALID_REQUEST');
        const token = await this.installationToken(repository);
        const [owner, repo] = repository.split('/');
        const segments = branch.split('/').map(encodeURIComponent).join('/');
        const ref = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${segments}`, 'GET', token) as RefResponse;
        if (ref.object?.sha !== expectedHead) throw new AtlasError('Remote branch head has changed.', 'CONFLICT');
        const pr = await this.request(`/repos/${owner}/${repo}/pulls`, 'POST', token,
            { head: branch, base: 'main', title, body, draft: true, maintainer_can_modify: false }) as PrResponse;
        if (!pr.number || !pr.html_url || pr.draft !== true)
            throw new AtlasError('GitHub returned an invalid draft PR.', 'GITHUB_REQUEST_FAILED');
        return { repository, branch, number: pr.number, url: pr.html_url, draft: true };
    }
}
