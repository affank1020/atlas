import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listNodeReleases, parseNodeReleases, resetNodeReleaseCacheForTests } from '../apps/server/src/nodes/releases.js';

const sha = 'a'.repeat(64), commit = 'abc123abc123';
const tag = 'node-v2.0.0-' + commit;
const url = 'https://github.com/affank1020/atlas/releases/download/' + tag + '/atlas-node-v2.0.0-' + commit + '.tar.gz';
const good = {
    tag_name: tag, published_at: '2026-10-21T19:00:00Z', draft: false, prerelease: false, immutable: true,
    html_url: 'https://github.com/affank1020/atlas/releases/tag/' + tag, body: 'Release notes',
    assets: [
        { name: 'atlas-node-v2.0.0-' + commit + '.tar.gz', browser_download_url: url, state: 'uploaded', digest: 'sha256:' + sha },
        { name: 'atlas-node-v2.0.0-' + commit + '.tar.gz.sha256', browser_download_url: url + '.sha256', state: 'uploaded' },
    ],
};
test('only published, checksum-addressed desktop artifacts enter the catalogue', () => {
    const entries = parseNodeReleases([good]);
    assert.deepEqual(entries.map(x => x.platform), ['linux', 'darwin']);
    assert.equal(entries[0]!.sha256, sha);
    assert.equal(entries[0]!.protocol, 2);
    for (const patch of [
        { draft: true }, { prerelease: true }, { immutable: false }, { tag_name: 'android-v0.1.0' },
        { assets: good.assets.slice(0, 1) },
        { assets: [{ ...good.assets[0], digest: undefined }, good.assets[1]] },
        { assets: [{ ...good.assets[0], browser_download_url: 'https://evil.invalid/a' }, good.assets[1]] },
        { html_url: 'https://evil.invalid/release' },
    ]) assert.equal(parseNodeReleases([{ ...good, ...patch }]).length, 0);
    assert.throws(() => parseNodeReleases({}), /Invalid/);
});
test('catalogue reports network failure without inventing downloads', async () => {
    resetNodeReleaseCacheForTests();
    const offlineFetcher = (async () => { throw new Error('offline'); }) as typeof fetch;
    const failed = await listNodeReleases(false, offlineFetcher);
    assert.equal(failed.state, 'unavailable');
    assert.deepEqual(failed.releases, []);
    resetNodeReleaseCacheForTests();
    const readyFetcher = (async () => ({ ok: true, json: async () => [good] })) as unknown as typeof fetch;
    const ready = await listNodeReleases(false, readyFetcher);
    assert.equal(ready.state, 'ready');
    assert.equal(ready.releases.length, 2);
    const again = await listNodeReleases(false, offlineFetcher);
    assert.equal(again.state, 'ready');
});
