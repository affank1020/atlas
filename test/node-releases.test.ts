import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { listNodeReleases, parseNodeReleases, resetNodeReleaseCacheForTests } from '../apps/server/src/nodes/releases.js';

const sha = 'a'.repeat(64), commit = 'abc123abc123';
const tag = 'node-v2.0.0-' + commit;
const url = 'https://github.com/affank1020/atlas/releases/download/' + tag + '/atlas-node-v2.0.0-' + commit + '.tar.gz';
const good = {
    tag_name: tag, target_commitish: commit + '0'.repeat(28), published_at: '2026-10-21T19:00:00Z', draft: false, prerelease: false, immutable: true,
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
    // A correctly named, immutable release is NOT proof of signed build provenance.
    // No attestation endpoint is queried, so even an unsigned manual publication
    // must never be labelled attested in the public catalogue.
    assert.equal(entries[0]!.provenance, 'unverified');
    assert.equal(Object.hasOwn(entries[0]!, 'signature'), false);
    const manualRelease = parseNodeReleases([{ ...good, body: 'Manually published; no attestation exists.' }]);
    assert.equal(manualRelease[0]!.provenance, 'unverified');
    // Even when GitHub mislabels a release candidate as stable, its SemVer
    // suffix prevents admission into the default stable catalogue.
    const rcTag = 'node-v2.1.0-rc.1-' + commit;
    const rc = {
        ...good, tag_name: rcTag,
        html_url: 'https://github.com/affank1020/atlas/releases/tag/' + rcTag,
        assets: good.assets.map(asset => ({
            ...asset,
            name: asset.name.replace('v2.0.0-', 'v2.1.0-rc.1-'),
            browser_download_url: asset.browser_download_url.replace('node-v2.0.0-', 'node-v2.1.0-rc.1-').replace('atlas-node-v2.0.0-', 'atlas-node-v2.1.0-rc.1-'),
        })),
    };
    assert.deepEqual(parseNodeReleases([rc]), []);
    for (const patch of [
        { draft: true }, { prerelease: true }, { immutable: false }, { tag_name: 'android-v0.1.0' },
        { target_commitish: 'main' }, { target_commitish: 'b'.repeat(40) },
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

function fixtureForCommit(fullCommit: string, publishedAt: string) {
    const short = fullCommit.slice(0, 12);
    const fullTag = 'node-v2.0.0-' + short;
    const download = 'https://github.com/affank1020/atlas/releases/download/' + fullTag + '/atlas-node-v2.0.0-' + short + '.tar.gz';
    return {
        ...good,
        tag_name: fullTag,
        target_commitish: fullCommit,
        published_at: publishedAt,
        html_url: 'https://github.com/affank1020/atlas/releases/tag/' + fullTag,
        assets: [
            { name: 'atlas-node-v2.0.0-' + short + '.tar.gz', browser_download_url: download, state: 'uploaded', digest: 'sha256:' + sha },
            { name: 'atlas-node-v2.0.0-' + short + '.tar.gz.sha256', browser_download_url: download + '.sha256', state: 'uploaded' },
        ],
    };
}

test('source ancestry, not publication time, chooses latest when old A finishes after new B', async () => {
    const older = 'a'.repeat(40), newer = 'b'.repeat(40);
    // A is published *after* B despite being the older source commit.
    const A = fixtureForCommit(older, '2026-10-21T20:30:00Z');
    const B = fixtureForCommit(newer, '2026-10-21T20:10:00Z');
    resetNodeReleaseCacheForTests();
    const urls: string[] = [];
    const fetcher = (async (input: string) => {
        urls.push(input);
        if (input.includes('/compare/')) {
            assert.equal(input.endsWith(older + '...' + newer), true);
            return { ok: true, json: async () => ({ status: 'ahead' }) };
        }
        return { ok: true, json: async () => [A, B] };
    }) as unknown as typeof fetch;
    const result = await listNodeReleases(false, fetcher);
    assert.equal(result.state, 'ready');
    assert.deepEqual(result.releases.slice(0, 2).map(x => x.commit), [newer.slice(0, 12), newer.slice(0, 12)]);
    assert.deepEqual(result.releases.slice(0, 2).map(x => x.platform), ['linux', 'darwin']);
    assert.equal(urls.filter(url => url.includes('/compare/')).length, 1);

    // An unavailable or divergent Git ancestry check must not invent a latest build.
    resetNodeReleaseCacheForTests();
    const ambiguous = (async (input: string) => input.includes('/compare/')
        ? { ok: true, json: async () => ({ status: 'diverged' }) }
        : { ok: true, json: async () => [A, B] }) as unknown as typeof fetch;
    const failed = await listNodeReleases(false, ambiguous);
    assert.equal(failed.state, 'unavailable');
    assert.deepEqual(failed.releases, []);
});

test('publisher only promotes stable builds at current main and serializes overlapping jobs', () => {
    const workflow = readFileSync('.github/workflows/node-package.yml', 'utf8');
    assert.match(workflow, /group: atlas-node-release-publication/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /if \\[\\[ "\\$version" == \\*-\\* \\]\\]/);
    assert.match(workflow, /main_head=.*gh api/);
    assert.match(workflow, /"\\$main_head" != "\\$GITHUB_SHA"/);
});
