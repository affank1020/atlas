import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Phase 4.3 server Docker Compose passes only broker settings to Server', () => {
    const config = readFileSync('infra/docker-compose.production.yml', 'utf8');
    const beforeServer = config.split('  server:\n')[0];
    const server = config.split('  server:\n')[1]?.split('  ingress:\n')[0];
    const afterServer = config.split('  ingress:\n')[1] ?? '';
    assert.ok(server, 'Server service must exist');
    for (const variable of [
        'ATLAS_GITHUB_APP_ID',
        'ATLAS_GITHUB_INSTALLATION_ID',
        'ATLAS_GITHUB_APP_PRIVATE_KEY_PEM',
        'ATLAS_GITHUB_WORKSPACE_REPOSITORIES',
    ]) {
        assert.match(server!, new RegExp(`^      ${variable}: \\$\\{${variable}:-\\}$`, 'm'), variable);
        assert.doesNotMatch(beforeServer + afterServer, new RegExp('^      ' + variable + ':', 'm'), 'GitHub App broker must only run on Server');
    }
    const example = readFileSync('infra/production.env.example', 'utf8');
    assert.match(example, /ATLAS_GITHUB_APP_ID=\n/);
    assert.match(example, /ATLAS_GITHUB_APP_PRIVATE_KEY_PEM=\n/);
    assert.match(example, /ATLAS_GITHUB_WORKSPACE_REPOSITORIES=\n/);
});

test('Code Reviews trusted publisher configuration is forwarded only to the production Server', () => {
    const compose = readFileSync('infra/docker-compose.production.yml', 'utf8');
    const server = compose.split('  server:\n')[1]?.split('  ingress:\n')[0];
    assert.ok(server, 'Server service must exist');
    assert.match(server!, /^      ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON: \$\{ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON:-\}$/m);
    const outside = compose.split('  server:\n')[0] + (compose.split('  ingress:\n')[1] ?? '');
    assert.doesNotMatch(outside, /^      ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON:/m,
        'Trust configuration must be forwarded only to the server, not Postgres, ingress or Nodes');
    const envExample = readFileSync('infra/production.env.example', 'utf8');
    assert.match(envExample, /^ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON=$/m,
        'Production env template should document an explicit empty default');
});

test('Code Reviews GitHub publication opt-in reaches only the Server and defaults off', () => {
    const compose = readFileSync('infra/docker-compose.production.yml', 'utf8');
    const server = compose.split('  server:\n')[1]?.split('  ingress:\n')[0];
    assert.ok(server);
    assert.match(server!, /^      ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES: \$\{ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES:-\}$/m);
    const others = compose.split('  server:\n')[0] + (compose.split('  ingress:\n')[1] ?? '');
    assert.doesNotMatch(others, /^      ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES:/m);
    assert.match(readFileSync('infra/production.env.example','utf8'),
        /^ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES=$/m);
});


test('all native Code Reviews allowlists stay default-off and Server-only in production', () => {
    const compose = readFileSync('infra/docker-compose.production.yml', 'utf8');
    const server = compose.split('  server:\n')[1]?.split('  ingress:\n')[0];
    const outside = compose.split('  server:\n')[0] + (compose.split('  ingress:\n')[1] ?? '');
    assert.ok(server);
    const example = readFileSync('infra/production.env.example', 'utf8');
    const native = [
        'ATLAS_CODE_REVIEW_MANAGED_SUMMARY_REPOSITORIES',
        'ATLAS_CODE_REVIEW_INLINE_ROOT_REPOSITORIES',
        'ATLAS_CODE_REVIEW_INLINE_REPLY_REPOSITORIES',
        'ATLAS_CODE_REVIEW_INLINE_FIX_REPOSITORIES',
        'ATLAS_CODE_REVIEW_RESOLVE_THREAD_REPOSITORIES',
    ];
    for (const flag of native) {
        const declared = new RegExp('^      ' + flag + ': \\$\\{' + flag + ':-\\}$', 'gm');
        assert.equal((server!.match(declared) ?? []).length, 1,
            'native publish flag must have one Server-only empty-default Compose mapping: ' + flag);
        assert.doesNotMatch(outside, new RegExp('^      ' + flag + ':', 'm'),
            'native publish flag must not leak to Postgres, Web, or Node: ' + flag);
        assert.equal((example.match(new RegExp('^' + flag + '=$', 'gm')) ?? []).length, 1,
            'production env template must explicitly default publisher off: ' + flag);
    }
    // The legacy publisher is a separate authority, never automatically enabled
    // by switching on native managed publishing.
    assert.match(server!, /^      ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES: \$\{ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES:-\}$/m);
    assert.match(example, /^ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES=$/m);
});


test('global native publishing is explicit, disabled by default and Server-only', () => {
    const compose = readFileSync('infra/docker-compose.production.yml', 'utf8');
    const server = compose.split('  server:\n')[1]?.split('  ingress:\n')[0];
    const outside = compose.split('  server:\n')[0] + (compose.split('  ingress:\n')[1] ?? '');
    assert.ok(server);
    assert.match(server!, /^      ATLAS_CODE_REVIEW_PUBLISH_ALL_REPOSITORIES: \$\{ATLAS_CODE_REVIEW_PUBLISH_ALL_REPOSITORIES:-false\}$/m);
    assert.doesNotMatch(outside, /^      ATLAS_CODE_REVIEW_PUBLISH_ALL_REPOSITORIES:/m);
    assert.match(readFileSync('infra/production.env.example', 'utf8'),
        /^ATLAS_CODE_REVIEW_PUBLISH_ALL_REPOSITORIES=false$/m);
});
