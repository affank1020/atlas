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
