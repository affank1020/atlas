import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGitPushFailure } from '../apps/node/src/capabilities/workspace-files/git-write.js';

test('Git push failures have stable, actionable codes on Linux and macOS', () => {
    const failures = [
        { stderr: 'remote: refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without workflows permission', code: 'GITHUB_WORKFLOWS_PERMISSION_REQUIRED' },
        { stdout: '! [rejected] HEAD -> atlas/feature (fetch first)', code: 'GIT_PUSH_NON_FAST_FORWARD' },
        { stderr: 'error: failed to push some refs (non-fast-forward)', code: 'GIT_PUSH_NON_FAST_FORWARD' },
        { stderr: 'remote: GH013: Repository rule violations found', code: 'GIT_PUSH_PROTECTED' },
        { stderr: 'remote: GH013: Repository rule violations found for .github/workflows/ci.yml', code: 'GIT_PUSH_PROTECTED' },
        { stderr: 'remote: GH006: protected branch update rejected for .github/workflows/ci.yml', code: 'GIT_PUSH_PROTECTED' },
        { stderr: 'remote: workflow .github/workflows/ci.yml rejected without a permission signature', code: 'GIT_PUSH_FAILED' },
        { stderr: 'fatal: Authentication failed for https://github.com/...', code: 'GIT_PUSH_AUTH_FAILED' },
        { stderr: 'remote: Write access to repository not granted.', code: 'GIT_PUSH_AUTH_FAILED' },
        { stderr: 'fatal: unable to access: Could not resolve host: github.com', code: 'GIT_PUSH_NETWORK_FAILED' },
        { stderr: 'The requested URL returned error: 503', code: 'GIT_PUSH_NETWORK_FAILED' },
        { killed: true, stderr: 'operation timed out', code: 'GIT_PUSH_TIMEOUT' },
        { code: 'ENOENT', codeExpected: 'GIT_PUSH_NODE_UNAVAILABLE' },
        { stderr: 'Unexpected arbitrary remote diagnostics', code: 'GIT_PUSH_FAILED' },
    ];
    for (const failure of failures) {
        const actual = classifyGitPushFailure(failure);
        assert.equal(actual.code, failure.codeExpected ?? failure.code, JSON.stringify(failure));
        assert.match(actual.message, /Git|GitHub/);
    }
});

test('Git push error classification never exposes arbitrary output or supplied credentials', () => {
    const secret = 'ghs_doNotPublishCredential';
    const cases = [
        { stderr: `remote: workflow permission denied. Authorization: Basic ${secret}`, stdout: secret },
        { stdout: `! [rejected] HEAD -> atlas/test (fetch first) ${secret}` },
        { stderr: `fatal: Authentication failed. password: ${secret}` },
        { stderr: `fatal: Could not resolve host github.com. ${secret}` },
        { stderr: `fatal: ${secret}`, message: `git -c http.extraheader=${secret} push` },
    ];
    for (const failure of cases) {
        const classified = classifyGitPushFailure(failure);
        assert.doesNotMatch(classified.message, /ghs_|Authorization:|Basic\s|http\.extraheader|password:/i);
        assert.ok(classified.code.startsWith('GIT_') || classified.code.startsWith('GITHUB_'));
    }
});
