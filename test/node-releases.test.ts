import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listNodeReleases, parseNodeReleases, resetNodeReleaseCacheForTests } from '../apps/server/src/nodes/releases.js';

const sha = 'a'.repeat(64), commit = 'abc123abc123';
const tag = 'node-v2.0.0-' + commit;
const url = 'https://github.com/affank1020/atlas/releases/download/' + tag + '/atlas-node-v2.0.0-' + commit + '.tar.gz';
const good = {
    tag_name: tag, target_commitish: commit + '0'.repeat(28), published_at: '2026-10-21T19:00:00Z', draft: false, prerelease: false, immutable: true,
    html_url: 'https://github.com/affank1020/atlas/releases/tag/' + tag,
    body: 'Atlas-Node-Release-Sequence: 110\n\nRelease notes',
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
    const manualRelease = parseNodeReleases([{ ...good, body: 'Atlas-Node-Release-Sequence: 110\n\nManually published; no attestation exists.' }]);
    assert.equal(manualRelease[0]!.provenance, 'unverified');
    // A release without the publication sequence is not sortable, so cannot
    // be offered as the latest merely because it was published more recently.
    assert.deepEqual(parseNodeReleases([{ ...good, body: 'Manually published without sequence' }]), []);
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
        { body: 'Atlas-Node-Release-Sequence: 0' },
        { body: 'Atlas-Node-Release-Sequence: 9007199254740992' },
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


function fixtureForCommit(fullCommit: string, publishedAt: string, sequence: number) {
    const short = fullCommit.slice(0, 12);
    const fullTag = 'node-v2.0.0-' + short;
    const download = 'https://github.com/affank1020/atlas/releases/download/' + fullTag + '/atlas-node-v2.0.0-' + short + '.tar.gz';
    return {
        ...good,
        tag_name: fullTag,
        target_commitish: fullCommit,
        published_at: publishedAt,
        body: 'Atlas-Node-Release-Sequence: ' + sequence + '\n\nStandalone archive',
        html_url: 'https://github.com/affank1020/atlas/releases/tag/' + fullTag,
        assets: [
            { name: 'atlas-node-v2.0.0-' + short + '.tar.gz', browser_download_url: download, state: 'uploaded', digest: 'sha256:' + sha },
            { name: 'atlas-node-v2.0.0-' + short + '.tar.gz.sha256', browser_download_url: download + '.sha256', state: 'uploaded' },
        ],
    };
}

test('publisher source sequence keeps newer B ahead when older A publishes last', () => {
    const A = fixtureForCommit('a'.repeat(40), '2026-10-21T20:30:00Z', 120);
    const B = fixtureForCommit('b'.repeat(40), '2026-10-21T20:10:00Z', 121);
    const ordered = parseNodeReleases([A, B]);
    assert.deepEqual(ordered.slice(0, 2).map(x => x.commit), ['b'.repeat(12), 'b'.repeat(12)]);
    assert.deepEqual(ordered.slice(0, 2).map(x => x.platform), ['linux', 'darwin']);
    assert.throws(() => parseNodeReleases([A, { ...B, body: A.body }]), /Conflicting Node release sequence/);
});

test('thirty same-version releases need only one request even with cold cache and simulated compare failures', async () => {
    resetNodeReleaseCacheForTests();
    const releases = Array.from({ length: 30 }, (_, i) =>
        fixtureForCommit(i.toString(16).padStart(12, '0') + 'a'.repeat(28),
            new Date(Date.UTC(2026, 9, 21, 20, 30 - i)).toISOString(),
            i + 100));
    let requests = 0;
    const fetcher = (async (input: string) => {
        requests++;
        if (input.includes('/compare/')) throw new Error('Rate limited: 403');
        return { ok: true, json: async () => releases };
    }) as unknown as typeof fetch;
    const result = await listNodeReleases(false, fetcher);
    assert.equal(result.state, 'ready');
    assert.equal(result.releases.length, 60);
    assert.equal(result.releases[0]!.sourceOrder, 129);
    assert.equal(requests, 1, 'cold catalogue must not make N ancestry requests');
    await listNodeReleases(true, fetcher);
    assert.equal(requests, 2, 'refresh must still only make a single request');

    resetNodeReleaseCacheForTests();
    const failed = await listNodeReleases(false, (async () => ({
        ok: false, status: 403,
    })) as unknown as typeof fetch);
    assert.equal(failed.state, 'unavailable');
    assert.deepEqual(failed.releases, []);
});

test('node-only publication gate ignores later Web-only pushes but rejects newer Node changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-node-release-check-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    const helper = resolve('scripts/node-release-publication-check.sh');
    try {
        git('init', '-q');
        git('config', 'user.email', 'node-releases-test@example.invalid');
        git('config', 'user.name', 'Node Release Test');
        mkdirSync(join(root, 'apps/node'), { recursive: true });
        mkdirSync(join(root, 'apps/web'), { recursive: true });
        writeFileSync(join(root, 'apps/node/runtime.txt'), 'Node A');
        git('add', '.'); git('commit', '-q', '-m', 'Node A');
        const nodeA = git('rev-parse', 'HEAD');

        writeFileSync(join(root, 'apps/web/ui.txt'), 'Web B');
        git('add', '.'); git('commit', '-q', '-m', 'Web B');
        assert.equal(execFileSync('bash', [helper, root, nodeA, 'HEAD'], { encoding: 'utf8' }).trim(), 'current');

        mkdirSync(join(root, 'scripts'), { recursive: true });
        writeFileSync(join(root, 'scripts/macos-node-operator.py'), '# new updater');
        git('add', '.'); git('commit', '-q', '-m', 'Signed macOS operator change');
        assert.equal(execFileSync('bash', [helper, root, nodeA, 'HEAD'], { encoding: 'utf8' }).trim(), 'superseded');

        writeFileSync(join(root, 'apps/node/runtime.txt'), 'Node C');
        git('add', '.'); git('commit', '-q', '-m', 'Node C');
        assert.equal(execFileSync('bash', [helper, root, nodeA, 'HEAD'], { encoding: 'utf8' }).trim(), 'superseded');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publisher stamps a monotonic release sequence and serializes promotion', () => {
    const workflow = readFileSync('.github/workflows/node-package.yml', 'utf8');
    assert.ok(workflow.includes('group: atlas-node-release-publication'));
    assert.ok(workflow.includes('cancel-in-progress: false'));
    assert.ok(workflow.includes('if [[ "$version" == *-* ]]'));
    assert.ok(workflow.includes('node-release-publication-check.sh'));
    assert.ok(workflow.includes('Atlas-Node-Release-Sequence: %s'));
    assert.ok(workflow.includes('"$GITHUB_RUN_NUMBER"'));
});
