import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Node release contains runtime/protocol but never credentials or Server/Web code', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'atlas-node-release-test-'));
    const extracted = path.join(directory, 'extracted');
    try {
        const commit = '1'.repeat(40);
        const output = JSON.parse(execFileSync(process.execPath,
            ['scripts/package-node-release.mjs', directory], {
                encoding: 'utf8',
                env: { ...process.env, GITHUB_SHA: commit, ATLAS_ALLOW_DIRTY_NODE_PACKAGE: '1' },
            }));
        const items = await readdir(directory);
        assert.ok(items.includes(path.basename(output.archive)));
        assert.ok(items.includes(path.basename(output.archive) + '.sha256'));
        execFileSync('mkdir', ['-p', extracted]);
        execFileSync('tar', ['-C', extracted, '-xzf', output.archive]);
        const release = JSON.parse(await readFile(path.join(extracted, 'atlas-node-release.json'), 'utf8'));
        assert.equal(release.commit, commit);
        assert.equal(release.protocol, 2);
        const manifest = JSON.parse(await readFile(path.join(extracted, 'package.json'), 'utf8'));
        const lock = JSON.parse(await readFile(path.join(extracted, 'package-lock.json'), 'utf8'));
        assert.deepEqual(manifest.workspaces, ['apps/node', 'packages/protocol']);
        for (const forbidden of ['apps/server', 'apps/web', 'packages/view-runtime',
            'node_modules/handlebars', 'node_modules/@atlas/server']) {
            assert.ok(!Object.hasOwn(lock.packages, forbidden), forbidden);
        }
        assert.match(release.install, /--ignore-scripts/);
        assert.ok((await readFile(path.join(extracted, 'apps/node/dist/platforms/desktop/main.js'))).length > 0);
        assert.ok((await readFile(path.join(extracted, 'packages/protocol/dist/node-protocol.js'))).length > 0);
        const listing = execFileSync('tar', ['-tzf', output.archive], { encoding: 'utf8' });
        for (const forbidden of ['.env', '.env.node', 'apps/server/dist/', 'apps/web/dist/', 'node_modules/', 'apps/server/data/']) {
            assert.ok(!listing.split('\n').some(line => line.includes(forbidden)), forbidden);
        }
        assert.match(await readFile(output.archive + '.sha256', 'utf8'), /^[a-f0-9]{64}  atlas-node-v/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
