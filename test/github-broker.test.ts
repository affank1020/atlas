import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubBroker } from '../apps/server/src/workspaces/github-broker.js';
import { workspaceSchemas } from '../apps/server/src/workspaces/contracts.js';
import { workspaceOperationSchemas } from '../packages/protocol/src/workspace-operations.js';

const repo = 'affank1020/portfolio-site';
const workspaceId = 'b0642889-d2b4-41de-bf22-c3ef2ef334bb';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const env = {
    ATLAS_GITHUB_APP_ID: '123456',
    ATLAS_GITHUB_INSTALLATION_ID: '456789',
    ATLAS_GITHUB_APP_PRIVATE_KEY_PEM: privateKey,
    ATLAS_GITHUB_WORKSPACE_REPOSITORIES: JSON.stringify({ [workspaceId]: repo }),
};
const tokenBody = { token: 'ghs_thisIsAFakeInstallationTokenForTests', repositories: [{ full_name: repo }] };
const head = 'a'.repeat(40);
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('broker is denied by default and only exact Workspace/repository binding is allowed', () => {
    assert.throws(() => new GitHubBroker({}).approve(workspaceId, repo), /not approved/);
    assert.throws(() => new GitHubBroker(env).approve('00000000-0000-0000-0000-000000000000', repo), /not approved/);
    assert.throws(() => new GitHubBroker(env).approve(workspaceId, 'affank1020/atlas'), /not approved/);
    assert.doesNotThrow(() => new GitHubBroker(env).approve(workspaceId, repo));
});

test('broker issues a repository-scoped installation token using a signed JWT', async () => {
    let calls = 0;
    const broker = new GitHubBroker(env, (async (url, init) => {
        calls++;
        assert.equal(String(url), 'https://api.github.com/app/installations/456789/access_tokens');
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.repositories, ['portfolio-site']);
        assert.deepEqual(body.permissions, { contents: 'write', pull_requests: 'write' });
        const bearer = String((init?.headers as Record<string, string>).Authorization);
        assert.match(bearer, /^Bearer ey/);
        assert.equal(bearer.split('.')[0], 'Bearer ' + bearer.split(' ')[1]!.split('.')[0]);
        return response(201, tokenBody);
    }) as typeof fetch);
    assert.equal(await broker.installationToken(repo), tokenBody.token);
    assert.equal(calls, 1);
});

test('draft PR requires exact remote HEAD and always targets main without merging', async () => {
    const calls: string[] = [];
    const broker = new GitHubBroker(env, (async (url, init) => {
        const u = String(url);
        calls.push(u);
        if (u.endsWith('/access_tokens')) return response(201, tokenBody);
        if (u.includes('/git/ref/heads/')) return response(200, { object: { sha: head } });
        assert.equal(u, 'https://api.github.com/repos/affank1020/portfolio-site/pulls');
        assert.deepEqual(JSON.parse(String(init?.body)), {
            head: 'atlas/git-smoke', base: 'main', title: 'Smoke test',
            body: 'An isolated verification', draft: true, maintainer_can_modify: false,
        });
        return response(201, { number: 42, html_url: 'https://github.com/affank1020/portfolio-site/pull/42', draft: true });
    }) as typeof fetch);
    assert.deepEqual(await broker.createDraftPullRequest(repo, 'atlas/git-smoke', head, 'Smoke test', 'An isolated verification'), {
        repository: repo, branch: 'atlas/git-smoke', number: 42,
        url: 'https://github.com/affank1020/portfolio-site/pull/42', draft: true,
    });
    assert.equal(calls.length, 3);
    assert.match(calls[1]!, /\/git\/ref\/heads\/atlas\/git-smoke$/);
});

test('reject changed remote heads before PR creation, never surfaces response bodies', async () => {
    let calls = 0;
    const broker = new GitHubBroker(env, (async (url) => {
        calls++;
        if (String(url).endsWith('/access_tokens')) return response(201, tokenBody);
        return response(200, { object: { sha: 'b'.repeat(40) } });
    }) as typeof fetch);
    await assert.rejects(broker.createDraftPullRequest(repo, 'atlas/git-smoke', head, 'Title test'), /head has changed/);
    assert.equal(calls, 2);

    const denied = new GitHubBroker(env, (async () => response(403, { message: 'LEAK_THIS_PRIVATE_INFORMATION' })) as typeof fetch);
    await assert.rejects(denied.installationToken(repo), error => {
        assert.doesNotMatch(String(error), /LEAK_THIS_PRIVATE_INFORMATION/);
        return true;
    });
});

test('public push schema rejects injected GitHub secrets and Node schema requires brokered token', () => {
    const input = { projectId: workspaceId, workspaceId, branch: 'atlas/test', expectedHead: head, repository: repo };
    assert.equal(workspaceSchemas.workspace_git_push_branch.safeParse(input).success, true);
    assert.equal(workspaceSchemas.workspace_git_push_branch.safeParse({ ...input, githubToken: 'attacker-controlled-token' }).success, false);
    assert.equal(workspaceOperationSchemas.workspace_git_push_branch.safeParse(input).success, false);
    assert.equal(workspaceOperationSchemas.workspace_git_push_branch.safeParse({ ...input, githubToken: 'ghs_testOnlyInstallationToken123456' }).success, true);
    assert.equal(workspaceSchemas.workspace_git_open_pull_request.safeParse({ ...input, title: 'Test PR' }).success, true);
    assert.equal(workspaceSchemas.workspace_git_open_pull_request.safeParse({ ...input, title: 'Test PR', githubToken: 'injected' }).success, false);
    assert.equal(workspaceSchemas.workspace_git_open_pull_request.safeParse({ ...input, branch: 'main', title: 'Test PR' }).success, false);
});
