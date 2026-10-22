import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubBroker } from '../apps/server/src/workspaces/github-broker.js';
import { workspaceSchemas } from '../apps/server/src/workspaces/contracts.js';
import { workspaceOperationSchemas } from '../packages/protocol/src/workspace-operations.js';

const repo = 'affank1020/portfolio-site';
const workspaceId = 'b0642889-d2b4-41de-bf22-c3ef2ef334bb';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const env = { ATLAS_GITHUB_APP_ID: '123456', ATLAS_GITHUB_APP_PRIVATE_KEY_PEM: privateKey };
const tokenBody = { token: 'ghs_fakeTokenUsedOnlyInTests', repositories: [{ full_name: repo }] };
const installations = [{ id: 456789, account: { login: 'affank1020', type: 'User' } }];
const head = 'a'.repeat(40);
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('GitHub App installation controls access; no per-workspace repository env mapping', async () => {
    await assert.rejects(new GitHubBroker({}).installationToken(repo), /not configured/);
    const broker = new GitHubBroker(env, (async (url) => {
        if (String(url).includes('/app/installations?')) return response(200, installations);
        throw new Error('No installation token should be issued for another owner');
    }) as typeof fetch);
    await assert.rejects(broker.installationToken('someone-else/project'), /not installed on this repository owner/);
    await assert.rejects(broker.installationToken('owner/name/extra'), /Invalid GitHub repository/);
});

test('broker dynamically locates installation and issues token scoped to one repository', async () => {
    let calls = 0;
    const broker = new GitHubBroker(env, (async (url, init) => {
        calls++;
        if (String(url).includes('/app/installations?')) {
            assert.match(String((init?.headers as Record<string,string>).Authorization), /^Bearer ey/);
            return response(200, installations);
        }
        assert.equal(String(url), 'https://api.github.com/app/installations/456789/access_tokens');
        assert.deepEqual(JSON.parse(String(init?.body)), {
            repositories: ['portfolio-site'], permissions: { contents: 'write', pull_requests: 'write' },
        });
        return response(201, tokenBody);
    }) as typeof fetch);
    assert.equal(await broker.installationToken(repo), tokenBody.token);
    assert.equal(calls, 2);
});

test('Git pushes use a separate repository-scoped token with workflow-write, without PR permissions', async () => {
    const broker = new GitHubBroker(env, (async (url, init) => {
        if (String(url).includes('/app/installations?')) return response(200, installations);
        assert.equal(String(url), 'https://api.github.com/app/installations/456789/access_tokens');
        assert.deepEqual(JSON.parse(String(init?.body)), {
            repositories: ['portfolio-site'], permissions: { contents: 'write', workflows: 'write' },
        });
        return response(201, { ...tokenBody, permissions: { contents: 'write', workflows: 'write' } });
    }) as typeof fetch);
    assert.equal(await broker.gitPublishToken(repo), tokenBody.token);
});

test('ambiguous token endpoint failures retain redacted, generic GitHub request errors', async () => {
    for (const status of [403, 422]) {
        const broker = new GitHubBroker(env, (async url =>
            String(url).includes('/app/installations?') ? response(200, installations) :
                response(status, { message: 'secret upsteam detail ghs_shall-not-leak' })) as typeof fetch);
        await assert.rejects(broker.gitPublishToken(repo), (error: any) => {
            assert.equal(error.code, 'GITHUB_REQUEST_FAILED');
            assert.match(error.message, new RegExp(`HTTP ${status}`));
            assert.doesNotMatch(error.message, /ghs_shall-not-leak|secret upsteam|workflow-write token/);
            return true;
        });
    }
    // A returned token with a missing scope *is* positive evidence of
    // unapproved permissions; unlike the ambiguous HTTP statuses above.
    const missing = new GitHubBroker(env, (async url =>
        String(url).includes('/app/installations?') ? response(200, installations) :
            response(201, { ...tokenBody, permissions: { contents: 'write' } })) as typeof fetch);
    await assert.rejects(missing.gitPublishToken(repo), (error: any) =>
        error.code === 'GITHUB_WORKFLOWS_PERMISSION_REQUIRED');
    const wrongRepository = new GitHubBroker(env, (async url =>
        String(url).includes('/app/installations?') ? response(200, installations) :
            response(201, { ...tokenBody, repositories: [{ full_name: 'affank1020/other' }],
                permissions: { workflows: 'write' } })) as typeof fetch);
    await assert.rejects(wrongRepository.gitPublishToken(repo), (error: any) => error.code === 'WORKSPACE_DENIED');
});

test('repository discovery enumerates installed account repositories and returns safe metadata', async () => {
    const broker = new GitHubBroker(env, (async (url, init) => {
        if (String(url).includes('/app/installations?')) return response(200, installations);
        if (String(url).endsWith('/access_tokens')) {
            assert.deepEqual(JSON.parse(String(init?.body)), { permissions: { contents: 'read' } });
            return response(201, { token: tokenBody.token });
        }
        assert.match(String(url), /installation\/repositories\?per_page=100&page=1$/);
        return response(200, { repositories: [
            { full_name: 'affank1020/portfolio-site', private: true, default_branch: 'main' },
            { full_name: 'affank1020/atlas', private: false, default_branch: 'main' },
        ] });
    }) as typeof fetch);
    const result = await broker.listRepositories();
    assert.deepEqual(result.repositories.map(x => x.repository), ['affank1020/atlas', 'affank1020/portfolio-site']);
    assert.equal(result.repositories[1]?.private, true);
    assert.equal(result.installations[0]?.owner, 'affank1020');
});

test('discovery refuses cross-account repository injection and uninstalled repositories', async () => {
    const broker = new GitHubBroker(env, (async (url) => {
        if (String(url).includes('/app/installations?')) return response(200, installations);
        if (String(url).endsWith('/access_tokens')) return response(201, { token: tokenBody.token });
        return response(200, { repositories: [{ full_name: 'another-owner/private' }] });
    }) as typeof fetch);
    await assert.rejects(broker.listRepositories(), /Unexpected repository/);
    const denied = new GitHubBroker(env, (async (url) => {
        if (String(url).includes('/app/installations?')) return response(200, installations);
        return response(201, { token: tokenBody.token, repositories: [{ full_name: 'affank1020/different' }] });
    }) as typeof fetch);
    await assert.rejects(denied.installationToken(repo), /not installed/);
});

test('draft PR requires exact remote HEAD and targets main without merging', async () => {
    const calls: string[] = [];
    const broker = new GitHubBroker(env, (async (url, init) => {
        const u = String(url); calls.push(u);
        if (u.includes('/app/installations?')) return response(200, installations);
        if (u.endsWith('/access_tokens')) return response(201, tokenBody);
        if (u === 'https://api.github.com/repos/affank1020/portfolio-site') return response(200, { default_branch: 'development' });
        if (u.includes('/git/ref/heads/')) return response(200, { object: { sha: head } });
        assert.equal(u, 'https://api.github.com/repos/affank1020/portfolio-site/pulls');
        assert.deepEqual(JSON.parse(String(init?.body)), {
            head: 'atlas/git-smoke', base: 'development', title: 'Smoke test',
            body: 'Isolated verification', draft: true, maintainer_can_modify: false,
        });
        return response(201, { number: 42, html_url: 'https://github.com/affank1020/portfolio-site/pull/42', draft: true });
    }) as typeof fetch);
    const result = await broker.createDraftPullRequest(repo, 'atlas/git-smoke', head, 'Smoke test', 'Isolated verification');
    assert.equal(result.number, 42);
    assert.equal(result.draft, true);
    assert.equal(calls.length, 5);
});

test('reject changed remote heads and never surface GitHub response bodies', async () => {
    const broker = new GitHubBroker(env, (async (url) => {
        if (String(url).includes('/app/installations?')) return response(200, installations);
        if (String(url).endsWith('/access_tokens')) return response(201, tokenBody);
        if (String(url) === 'https://api.github.com/repos/affank1020/portfolio-site') return response(200, { default_branch: 'main' });
        return response(200, { object: { sha: 'b'.repeat(40) } });
    }) as typeof fetch);
    await assert.rejects(broker.createDraftPullRequest(repo, 'atlas/git-smoke', head, 'Title test'), /head has changed/);
    const denied = new GitHubBroker(env, (async () => response(403, { message: 'LEAK_PRIVATE_DATA' })) as typeof fetch);
    await assert.rejects(denied.installationToken(repo), error => {
        assert.doesNotMatch(String(error), /LEAK_PRIVATE_DATA/); return true;
    });
});

test('public push schema rejects injected GitHub secrets and Node requires brokered token', () => {
    const input = { projectId: workspaceId, workspaceId, branch: 'atlas/test', expectedHead: head, repository: repo };
    assert.equal(workspaceSchemas.workspace_git_push_branch.safeParse(input).success, true);
    assert.equal(workspaceSchemas.workspace_git_push_branch.safeParse({ ...input, githubToken: 'attacker-controlled-token' }).success, false);
    assert.equal(workspaceOperationSchemas.workspace_git_push_branch.safeParse(input).success, false);
    assert.equal(workspaceOperationSchemas.workspace_git_push_branch.safeParse({ ...input, githubToken: 'ghs_testOnlyInstallationToken123456' }).success, true);
    assert.equal(workspaceSchemas.workspace_git_open_pull_request.safeParse({ ...input, title: 'Test PR' }).success, true);
    assert.equal(workspaceSchemas.workspace_git_open_pull_request.safeParse({ ...input, title: 'Test PR', githubToken: 'injected' }).success, false);
    assert.equal(workspaceSchemas.workspace_git_open_pull_request.safeParse({ ...input, branch: 'main', title: 'Test PR' }).success, false);
    assert.equal(workspaceSchemas.list_github_repositories.safeParse({}).success, true);
});

test('repository cloning uses read-only GitHub App tokens and never accepts client credentials', async () => {
    const broker = new GitHubBroker(env, (async (url, init) => {
        if (String(url).includes('/app/installations?')) return response(200, installations);
        assert.equal(String(url), 'https://api.github.com/app/installations/456789/access_tokens');
        assert.deepEqual(JSON.parse(String(init?.body)), {
            repositories: ['portfolio-site'], permissions: { contents: 'read' },
        });
        return response(201, tokenBody);
    }) as typeof fetch);
    assert.equal(await broker.repositoryReadToken(repo), tokenBody.token);
    const clone = { workspaceId, repository: repo, directoryName: 'portfolio-clone' };
    assert.equal(workspaceSchemas.workspace_git_clone_repository.safeParse(clone).success, true);
    assert.equal(workspaceSchemas.workspace_git_clone_repository.safeParse({
        ...clone, githubToken: tokenBody.token,
    }).success, false);
});
