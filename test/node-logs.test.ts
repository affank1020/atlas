import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAtlasNodeLog, redactNodeLog } from '../apps/node/src/capabilities/node-logs.js';

test('log tail only reads fixed Atlas-owned files, bounds line count and redacts sensitive values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atlas-log-test-'));
    try {
        const folder = join(home, 'Library', 'Logs', 'Atlas');
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'node-error.log'), [
            'before',
            'Authorization: Bearer super-secret-long-token',
            'ATLAS_NODE_CREDENTIAL=verysecretcredential',
            'DATABASE_URL=postgresql://user:pass@localhost/db',
            'last line',
        ].join('\n') + '\n');
        const result = await readAtlasNodeLog('stderr', 4, 'darwin', home);
        assert.equal(result.available, true);
        assert.equal(result.lines.length, 4);
        assert.equal(result.truncated, true);
        assert.ok(result.lines.at(-1)?.includes('last line'));
        const content = result.lines.join('\n');
        assert.doesNotMatch(content, /super-secret-long-token|verysecretcredential|user:pass/);
        assert.match(content, /REDACTED/);
        const absent = await readAtlasNodeLog('stdout', 1, 'darwin', home);
        assert.equal(absent.available, false);
    } finally { await rm(home, { recursive: true, force: true }); }
});

test('node log reader rejects non-Mac platforms, excessive lines and symlink redirects', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atlas-log-safety-'));
    try {
        const folder = join(home, 'Library', 'Logs', 'Atlas');
        await mkdir(folder, { recursive: true });
        await writeFile(join(home, 'secret.txt'), 'private key');
        await symlink(join(home, 'secret.txt'), join(folder, 'node.log'));
        await assert.rejects(readAtlasNodeLog('stdout', 10, 'darwin', home), /not accessible/);
        await assert.rejects(readAtlasNodeLog('stdout', 201, 'darwin', home), /Invalid Atlas Node log/);
        await assert.rejects(readAtlasNodeLog('stderr', 10, 'linux', home), /not configured/);
    } finally { await rm(home, { recursive: true, force: true }); }
});

test('credential redaction handles Authorization, key values, JWTs and password-bearing URIs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTAwMDAwMDB9.signature00000000000';
    const sanitized = redactNodeLog(
        'Authorization: Bearer abcdef12345 ACCESS_TOKEN=topsecret password: "my pass" ' +
        'postgres://affan:pass@example.com/db ' + jwt,
    );
    assert.doesNotMatch(sanitized, /abcdef12345|topsecret|my pass|affan:pass|eyJhbGci/);
});
