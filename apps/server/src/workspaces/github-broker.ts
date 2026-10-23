import { createSign } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';

const repositoryPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const branchPattern = /^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/;
const MAX_INSTALLATIONS = 100;
const MAX_REPO_PAGES = 10;

type Transport = typeof fetch;
type TokenResponse = { token?: string; repositories?: { full_name: string }[]; permissions?: { workflows?: string; pull_requests?: string } };
type Installation = { id: number; account?: { login?: string; type?: string } };
type InstalledRepository = { full_name?: string; private?: boolean; default_branch?: string; archived?: boolean };
type RepositoryPage = { repositories?: InstalledRepository[]; total_count?: number };
type RefResponse = { object?: { sha?: string } };
type PrResponse = { number?: number; html_url?: string; draft?: boolean };

export class GitHubBroker {
    constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly http: Transport = fetch) {}

    private jwt() {
        const id = this.env.ATLAS_GITHUB_APP_ID;
        if (!id || !/^\d+$/.test(id) || !this.env.ATLAS_GITHUB_APP_PRIVATE_KEY_PEM)
            throw new AtlasError('GitHub App broker is not configured.', 'CAPABILITY_UNAVAILABLE');
        const now = Math.floor(Date.now() / 1000);
        const payload = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const unsigned = `${payload({ alg: 'RS256', typ: 'JWT' })}.${payload({ iat: now - 60, exp: now + 540, iss: id })}`;
        try {
            const signer = createSign('RSA-SHA256');
            signer.update(unsigned);
            signer.end();
            return `${unsigned}.${signer.sign(this.env.ATLAS_GITHUB_APP_PRIVATE_KEY_PEM.replace(/\\n/g, '\n'), 'base64url')}`;
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
        // Never echo upstream bodies: even errors may contain operational details.
        if (!response.ok) throw new AtlasError(`GitHub rejected the request (HTTP ${response.status}).`, 'GITHUB_REQUEST_FAILED');
        return response.json() as Promise<unknown>;
    }

    private async installations(): Promise<Installation[]> {
        const jwt = this.jwt();
        const result = await this.request('/app/installations?per_page=100', 'GET', jwt);
        if (!Array.isArray(result) || result.length > MAX_INSTALLATIONS ||
            result.some(item => !Number.isSafeInteger(item?.id) || item.id < 1 ||
                typeof item?.account?.login !== 'string'))
            throw new AtlasError('GitHub App installations could not be verified.', 'GITHUB_REQUEST_FAILED');
        // If the App has 100+ installations, require pagination support before using it.
        if (result.length === MAX_INSTALLATIONS)
            throw new AtlasError('GitHub App installation list exceeds the supported limit.', 'CAPABILITY_UNAVAILABLE');
        return result as Installation[];
    }

    private async tokenForInstallation(installationId: number, repository?: string, purpose: 'read' | 'reviews' | 'publication' | 'pr' | 'push' = 'read') {
        const permissions = purpose === 'push' ? { contents: 'write', workflows: 'write' }
            : purpose === 'pr' ? { contents: 'write', pull_requests: 'write' } : purpose === 'publication' ? { pull_requests: 'write' } : purpose === 'reviews' ? { pull_requests: 'read' } : { contents: 'read' };
        const body = repository ? { repositories: [repository.split('/')[1]], permissions } : { permissions: { contents: 'read' } };
        // HTTP 403 and 422 also cover throttling and validation failures. Do
        // not infer missing permission from status alone or echo GitHub bodies.
        // A successful token response must explicitly confirm workflow-write.
        const result = await this.request(`/app/installations/${installationId}/access_tokens`, 'POST', this.jwt(), body) as TokenResponse;
        if (!result.token) throw new AtlasError('GitHub App did not issue a token.', 'GITHUB_REQUEST_FAILED');
        if (repository && !result.repositories?.some(item => item.full_name.toLowerCase() === repository.toLowerCase()))
            throw new AtlasError('GitHub App is not installed on the requested repository.', 'WORKSPACE_DENIED');
        // Never publish with a token unless GitHub explicitly confirms the requested scope.
        if (purpose === 'publication' && result.permissions?.pull_requests !== 'write')
            throw new AtlasError('GitHub installation token lacks pull-request write permission.', 'GITHUB_REQUEST_FAILED');
        if (purpose === 'reviews' && !['read', 'write'].includes(result.permissions?.pull_requests ?? ''))
            throw new AtlasError('GitHub installation token lacks pull-request read permission.', 'GITHUB_REQUEST_FAILED');
        if (purpose === 'push' && result.permissions?.workflows !== 'write')
            throw new AtlasError('GitHub installation token lacks workflow-write permission. Approve the GitHub App permission update.', 'GITHUB_WORKFLOWS_PERMISSION_REQUIRED');
        return result.token;
    }

    async installationToken(repository: string) { return this.scopedToken(repository, 'pr'); }
    async gitPublishToken(repository: string) { return this.scopedToken(repository, 'push'); }
    async repositoryReadToken(repository: string) { return this.scopedToken(repository, 'read'); }
    async pullRequestReadToken(repository: string) { return this.scopedToken(repository, 'reviews'); }
    async pullRequestPublishToken(repository: string) { return this.scopedToken(repository, 'publication'); }
    /** Resolve the immutable GitHub Bot user ID from the authenticated App itself,
     * never from a caller-controlled login or a review marker.
     */
    async reviewPublisherBot() {
        const app = await this.request('/app', 'GET', this.jwt()) as { id?: unknown; slug?: unknown };
        if (app.id !== Number(this.env.ATLAS_GITHUB_APP_ID) ||
            typeof app.slug !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(app.slug))
            throw new AtlasError('GitHub App identity could not be verified.', 'GITHUB_REQUEST_FAILED');
        const login = `${app.slug}[bot]`;
        const user = await this.request('/users/' + encodeURIComponent(login), 'GET', this.jwt()) as {
            id?: unknown; login?: unknown; type?: unknown;
        };
        if (!Number.isSafeInteger(user.id) || (user.id as number) < 1 ||
            user.type !== 'Bot' || typeof user.login !== 'string' ||
            user.login.toLowerCase() !== login.toLowerCase())
            throw new AtlasError('GitHub App bot identity could not be verified.', 'GITHUB_REQUEST_FAILED');
        return { id: user.id as number, login: user.login };
    }

    private async scopedToken(repository: string, purpose: 'read' | 'reviews' | 'publication' | 'pr' | 'push') {
        if (!repositoryPattern.test(repository)) throw new AtlasError('Invalid GitHub repository.', 'INVALID_REQUEST');
        const owner = repository.split('/')[0]!.toLowerCase();
        const installations = await this.installations();
        const installation = installations.find(item => item.account!.login!.toLowerCase() === owner);
        if (!installation) throw new AtlasError('GitHub App is not installed on this repository owner.', 'WORKSPACE_DENIED');
        return this.tokenForInstallation(installation.id, repository, purpose);
    }

    async listRepositories() {
        const installations = await this.installations();
        const repositories: { repository: string; private: boolean; defaultBranch: string; archived: boolean; installationId: number; owner: string }[] = [];
        for (const installation of installations) {
            const token = await this.tokenForInstallation(installation.id);
            for (let page = 1; page <= MAX_REPO_PAGES; page++) {
                const body = await this.request(`/installation/repositories?per_page=100&page=${page}`, 'GET', token) as RepositoryPage;
                if (!Array.isArray(body.repositories)) throw new AtlasError('Invalid GitHub repository discovery response.', 'GITHUB_REQUEST_FAILED');
                for (const repo of body.repositories) {
                    if (typeof repo.full_name !== 'string' || !repositoryPattern.test(repo.full_name) ||
                        repo.full_name.split('/')[0]!.toLowerCase() !== installation.account!.login!.toLowerCase())
                        throw new AtlasError('Unexpected repository in GitHub installation.', 'GITHUB_REQUEST_FAILED');
                    repositories.push({
                        repository: repo.full_name, private: repo.private === true,
                        defaultBranch: repo.default_branch || 'main', archived: repo.archived === true,
                        installationId: installation.id, owner: installation.account!.login!,
                    });
                }
                if (body.repositories.length < 100) break;
                if (page === MAX_REPO_PAGES)
                    throw new AtlasError('GitHub repository catalog exceeds the supported limit.', 'CAPABILITY_UNAVAILABLE');
            }
        }
        return { repositories: repositories.sort((a, b) => a.repository.localeCompare(b.repository)), installations: installations.map(item =>
            ({ id: item.id, owner: item.account!.login!, type: item.account!.type || 'User' })) };
    }

    /** Refuse managed-worktree retirement unless the exact branch tip has a
     * merged PR into this repository's default branch. Squash merges are valid:
     * ancestry is not used as a substitute for GitHub's merged_at evidence. */
    async verifyMergedPullRequest(repository: string, branch: string, expectedHead: string) {
        if (!repositoryPattern.test(repository) || !branchPattern.test(branch) ||
            branch.includes('//') || branch.endsWith('/') || !/^[a-f0-9]{40}$/.test(expectedHead))
            throw new AtlasError('Invalid worktree retirement identity.', 'INVALID_REQUEST');
        const token = await this.installationToken(repository);
        const [owner, repo] = repository.split('/');
        const details = await this.request(`/repos/${owner}/${repo}`, 'GET', token) as { default_branch?: string };
        const base = details.default_branch;
        if (!base || !/^[A-Za-z0-9._/-]{1,200}$/.test(base) || base.includes('..') ||
            base.includes('//') || base.startsWith('/') || base.endsWith('/'))
            throw new AtlasError('GitHub default branch could not be verified.', 'GITHUB_REQUEST_FAILED');
        const query = new URLSearchParams({ state: 'closed', head: `${owner}:${branch}`, per_page: '100' });
        const pulls = await this.request(`/repos/${owner}/${repo}/pulls?${query}`, 'GET', token) as Array<{
            number?: number; html_url?: string; merged_at?: string | null;
            head?: { sha?: string }; base?: { ref?: string };
        }>;
        if (!Array.isArray(pulls) || pulls.length >= 100)
            throw new AtlasError('Merged PR verification is incomplete; retirement blocked.', 'GITHUB_REQUEST_FAILED');
        const merged = pulls.find(pr => Number.isSafeInteger(pr.number) && pr.number! > 0 &&
            pr.head?.sha === expectedHead && pr.base?.ref === base &&
            typeof pr.merged_at === 'string' && !Number.isNaN(Date.parse(pr.merged_at)) &&
            pr.html_url === `https://github.com/${repository}/pull/${pr.number}`);
        if (!merged)
            throw new AtlasError('No merged PR matches this exact branch HEAD on the default branch. Local files were preserved.', 'CONFLICT');
        return { number: merged.number!, url: merged.html_url! };
    }

    async createDraftPullRequest(repository: string, branch: string, expectedHead: string, title: string, body = '') {
        if (!repositoryPattern.test(repository) || !branchPattern.test(branch) || branch.includes('//') ||
            branch.endsWith('/') || !/^[a-f0-9]{40}$/.test(expectedHead))
            throw new AtlasError('Invalid GitHub PR branch or commit.', 'INVALID_REQUEST');
        const token = await this.installationToken(repository);
        const [owner, repo] = repository.split('/');
        const details = await this.request(`/repos/${owner}/${repo}`, 'GET', token) as { default_branch?: string };
        const base = details.default_branch;
        if (!base || !/^[A-Za-z0-9._/-]{1,200}$/.test(base) || base.startsWith('/') ||
            base.endsWith('/') || base.includes('..') || base.includes('//'))
            throw new AtlasError('GitHub repository default branch is invalid.', 'GITHUB_REQUEST_FAILED');
        const segments = branch.split('/').map(encodeURIComponent).join('/');
        const ref = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${segments}`, 'GET', token) as RefResponse;
        if (ref.object?.sha !== expectedHead) throw new AtlasError('Remote branch head has changed.', 'CONFLICT');
        const pr = await this.request(`/repos/${owner}/${repo}/pulls`, 'POST', token,
            { head: branch, base, title, body, draft: true, maintainer_can_modify: false }) as PrResponse;
        if (!pr.number || !pr.html_url || pr.draft !== true)
            throw new AtlasError('GitHub returned an invalid draft PR.', 'GITHUB_REQUEST_FAILED');
        return { repository, branch, number: pr.number, url: pr.html_url, draft: true };
    }
}
