import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('Linux release installer syntax, help, and nonmutating rejection paths', () => {
    const syntax = spawnSync('bash', ['-n', 'scripts/linux-node-release.sh'], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const help = spawnSync('bash', ['scripts/linux-node-release.sh', '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /never activates|does not start|never activates it/i);
    const noArchive = spawnSync('bash', ['scripts/linux-node-release.sh', 'install', '/no/such/archive.tar.gz', '/no/such/archive.sha256'], { encoding: 'utf8' });
    assert.notEqual(noArchive.status, 0);
    const script = readFileSync('scripts/linux-node-release.sh', 'utf8');
    assert.doesNotMatch(script, /systemctl (start|restart|enable)|docker compose|ATLAS_NODE_CREDENTIAL/);
    assert.match(script, /sha256sum/);
    assert.match(script, /--ignore-scripts/);
});


test('Linux verifier accepts a valid artifact and rejects corruption and symlinks', async t => {
    if (process.platform !== 'linux') return t.skip('Installer verifier runs on Linux');
    const { mkdtemp, mkdir, writeFile, rm, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, dirname } = await import('node:path');
    const { createHash } = await import('node:crypto');
    const root = await mkdtemp(join(tmpdir(), 'atlas-linux-release-'));
    t.after(() => rm(root, { force: true, recursive: true }));
    const tree = join(root, 'package');
    const commit = 'a'.repeat(40);
    const name = 'atlas-node-v2.0.0-' + commit.slice(0, 12) + '.tar.gz';
    const archive = join(root, name);
    const signature = archive + '.sha256';
    const required = [
        'package.json', 'package-lock.json', 'apps/node/package.json',
        'apps/server/package.json', 'apps/web/package.json',
        'packages/protocol/package.json', 'packages/view-runtime/package.json'
    ];
    for (const file of required) {
        await mkdir(dirname(join(tree, file)), { recursive: true });
        await writeFile(join(tree, file), '{}');
    }
    await writeFile(join(tree, 'atlas-node-release.json'), JSON.stringify({
        application: '@atlas/node', version: '2.0.0', commit, protocol: 2,
        entrypoint: 'apps/node/dist/platforms/desktop/main.js'
    }));
    const pack = () => {
        const result = spawnSync('tar', ['-czf', archive, '-C', tree, '.'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    };
    const sign = async () => {
        const bytes = await (await import('node:fs/promises')).readFile(archive);
        await writeFile(signature, createHash('sha256').update(bytes).digest('hex') + '  ' + name + '\n');
    };
    const verify = () => spawnSync('bash', ['scripts/linux-node-release.sh', 'verify', archive, signature], { encoding: 'utf8' });
    pack();
    await sign();
    const ok = verify();
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Verified Atlas Node release/);
    await writeFile(signature, '0'.repeat(64) + '  ' + name + '\n');
    assert.equal(verify().status, 1, 'incorrect checksum must fail');
    // A correctly checksummed archive with a symlink must still fail.
    await symlink('/etc/passwd', join(tree, 'link'));
    pack();
    await sign();
    const denied = verify();
    assert.equal(denied.status, 1, denied.stderr);
    assert.match(denied.stderr, /links or non-regular entries/);
});
