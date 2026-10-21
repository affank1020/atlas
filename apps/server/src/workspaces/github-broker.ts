import { createSign } from 'node:crypto';
import { AtlasError } from '../shared/errors.js';

const repositoryPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const branchPattern = /^atlas\/[a-z0-9][a-z0-9/_-]{0,72}$/;
const MAX_INSTALLATIONS = 100;
const MAX_REPO_PAGES = 10;

type Transport = typeof fetch;
type TokenResponse = { token?: string; repositories?: { full_name: string }[] };
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

    private async tokenForInstallation(installationId: number, repository?: string, readonly = false) {
        const body = repository
            ? { repositories: [repository.split('/')[1]], permissions: readonly ? { contents: 'read' } : { contents: 'write', pull_requests: 'write' } }
            : { permissions: { contents: 'read' } };
        const result = await this.request(`/app/installations/${installationId}/access_tokens`, 'POST', this.jwt(), body) as TokenResponse;
        if (!result.token) throw new AtlasError('GitHub App did not issue a token.', 'GITHUB_REQUEST_FAILED');
        if (repository && !result.repositories?.some(item => item.full_name.toLowerCase() === repository.toLowerCase()))
            throw new AtlasError('GitHub App is not installed on the requested repository.', 'WORKSPACE_DENIED');
        return result.token;
    }

    async installationToken(repository: string) { return this.scopedToken(repository, false); }
    async repositoryReadToken(repository: string) { return this.scopedToken(repository, true); }
    private async scopedToken(repository: string, readonly: boolean) {
        if (!repositoryPattern.test(repository)) throw new AtlasError('Invalid GitHub repository.', 'INVALID_REQUEST');
        const owner = repository.split('/')[0]!.toLowerCase();
        const installations = await this.installations();
        const installation = installations.find(item => item.account!.login!.toLowerCase() === owner);
        if (!installation) throw new AtlasError('GitHub App is not installed on this repository owner.', 'WORKSPACE_DENIED');
        return this.tokenForInstallation(installation.id, repository, readonly);
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
