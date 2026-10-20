import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedNodeVersion, nodeStatusPath } from '../apps/node/src/core/node-installation.js';

test('Node state location uses macOS-compatible and Linux XDG paths', () => {
    assert.equal(nodeStatusPath('darwin', {}, '/home/test'), '/home/test/Library/Application Support/Atlas/node-status.json');
    assert.equal(nodeStatusPath('linux', {}, '/home/test'), '/home/test/.local/state/atlas/node-status.json');
    assert.equal(nodeStatusPath('linux', { XDG_STATE_HOME: '/run/user/test/state' }, '/home/test'), '/run/user/test/state/atlas/node-status.json');
    assert.equal(nodeStatusPath('linux', { XDG_STATE_HOME: 'relative-path' }, '/home/test'), '/home/test/.local/state/atlas/node-status.json');
});
test('Node package version works for checkout and signed-off release metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-version-test-'));
    const dir = join(root, 'apps/node');
    try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '2.0.0' }));
        assert.equal(installedNodeVersion(dir), '2.0.0');
        await writeFile(join(root, 'atlas-node-release.json'), JSON.stringify({
            application: '@atlas/node', version: '2.0.0', commit: 'b'.repeat(40)
        }));
        assert.equal(installedNodeVersion(dir), '2.0.0+' + 'b'.repeat(12));
    } finally { await rm(root, { recursive: true, force: true }); }
});
