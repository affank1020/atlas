import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNodeUpdatePlan } from '../apps/server/src/nodes/update-plan.js';
import type { NodeRelease } from '../apps/server/src/nodes/releases.js';
import type { AtlasNode } from '../apps/server/src/nodes/model.js';

const linux: Pick<AtlasNode, 'id' | 'platform' | 'status' | 'version' | 'credentialState' | 'metadata'> = {
    id: '11111111-1111-4111-8111-111111111111', platform: 'linux',
    status: 'online', version: '2.0.0+aaaaaaaaaaaa', credentialState: 'active',
    metadata: { runtime: 'remote' },
};
const release = (version: string, commit: string, sourceOrder: number, platform: 'linux' | 'darwin' = 'linux'): NodeRelease => ({
    component: 'desktop-node', platform, architecture: 'any', channel: 'stable',
    version, commit, sourceCommit: commit + '0'.repeat(28), sourceOrder,
    protocol: 2, minimumNodeJs: 20, publishedAt: '2026-10-21T12:00:00Z',
    notes: '', sha256: 'b'.repeat(64),
    downloadUrl: 'https://github.com/affank1020/atlas/releases/download/node-v' + version + '-' + commit + '/atlas-node.tar.gz',
    checksumUrl: '', releaseUrl: '', provenance: 'unverified',
});
const old = release('2.0.0', 'aaaaaaaaaaaa', 10);
const newer = release('2.0.0', 'bbbbbbbbbbbb', 11);
const ready = { state: 'ready' as const, releases: [newer, old] };
const plan = (changes: Partial<typeof linux> = {}, catalogue = ready) =>
    buildNodeUpdatePlan({ ...linux, ...changes }, catalogue);

test('Linux stable update plan is read-only even for a newer candidate', () => {
    const result = plan();
    assert.equal(result.status, 'candidate');
    assert.equal(result.candidate?.commit, newer.commit);
    assert.equal(result.candidate?.provenance, 'unverified');
    assert.equal(result.provenanceVerified, false);
    assert.equal(result.canInstall, false);
    assert.equal(result.canActivate, false);
    assert.match(result.reason, /remain unverified/);
});

test('unknown same-version commit is never interpreted as an old build', () => {
    const result = plan({ version: '2.0.0+cccccccccccc' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.candidate, null);
    assert.equal(plan({ version: '2.0.0' }).status, 'unknown');
    assert.equal(plan({ version: '2.0.0+bbbbbbbbbbbb' }).status, 'current');
});

test('lower SemVer is a candidate and higher SemVer is ahead', () => {
    assert.equal(plan({ version: '1.9.9' }).status, 'candidate');
    assert.equal(plan({ version: '2.1.0+cccccccccccc' }).status, 'ahead');
    assert.equal(plan({ version: 'v2.0.0' }).status, 'unknown');
    assert.equal(plan({ version: null }).status, 'unknown');
    assert.equal(plan({ version: '999999999999999999999.0.0' }).status, 'unknown');
});

test('installed version with a newer source order is never downgraded', () => {
    const result = plan({ version: '2.0.0+bbbbbbbbbbbb' }, { state: 'ready', releases: [old, newer] });
    assert.equal(result.status, 'ahead');
    assert.equal(result.candidate, null);
});

test('unsupported, revoked and offline Nodes fail before discussing release candidates', () => {
    const cases: [Partial<typeof linux>, string][] = [
        [{ platform: 'darwin' }, 'unsupported'],
        [{ platform: 'android' }, 'unsupported'],
        [{ metadata: { runtime: 'local' } }, 'unsupported'],
        [{ credentialState: 'revoked' }, 'offline'],
        [{ status: 'offline' }, 'offline'],
        [{ status: 'unavailable' }, 'offline'],
    ];
    for (const [change, status] of cases) {
        const result = plan(change);
        assert.equal(result.status, status);
        assert.equal(result.candidate, null);
        assert.equal(result.canInstall, false);
    }
});

test('missing immutable catalogue does not invent a download', () => {
    const none = plan({}, { state: 'ready', releases: [] });
    assert.equal(none.status, 'unavailable');
    assert.equal(none.candidate, null);
    assert.match(none.reason, /immutable stable Linux/);
    assert.equal(plan({}, { state: 'unavailable', releases: [newer] }).status, 'unavailable');
    const macOnly = plan({}, { state: 'ready', releases: [release('9.0.0', 'cccccccccccc', 12, 'darwin')] });
    assert.equal(macOnly.status, 'unavailable');
});

test('non-protocol-v2 release is ignored', () => {
    const incompatible = { ...newer, protocol: 3 as 2 };
    assert.equal(plan({}, { state: 'ready', releases: [incompatible] }).status, 'unavailable');
});
