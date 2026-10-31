import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAtlasLinuxServiceLog } from '../apps/node/src/capabilities/linux-service-logs.js';

const owner = process.getuid?.() ?? 0;

async function withFixture(run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-service-log-test-'));
    try { await run(dir); }
    finally { await rm(dir, { recursive: true, force: true }); }
}

test('private Linux service log reads only complete bounded redacted entries', async () => {
    await withFixture(async dir => {
        await writeFile(join(dir, 'service.log'),
            'Atlas Node connected\nAuthorization: Bearer supersecret\nTOKEN=topsecret\nlast partial', { mode: 0o600 });
        const result = await readAtlasLinuxServiceLog(2, dir, owner);
        assert.equal(result.source, 'service');
        assert.equal(result.available, true);
        assert.equal(result.truncated, true);
        assert.equal(result.lines.length, 2);
        assert.ok(result.lines.join('\n').includes('REDACTED'));
        assert.doesNotMatch(result.lines.join('\n'), /supersecret|topsecret|last partial/);
    });
});

test('missing, symlinked, group-visible, hardlinked or untrusted directory logs fail closed', async () => {
    await withFixture(async dir => {
        const path = join(dir, 'service.log');
        assert.equal((await readAtlasLinuxServiceLog(1, dir, owner)).available, false);
        await writeFile(path, 'bounded\n', { mode: 0o600 });
        const other = join(dir, 'other.log');
        await link(path, other);
        assert.equal((await readAtlasLinuxServiceLog(1, dir, owner)).available, false, 'hardlink not trusted');
        await rm(other);
        await chmod(path, 0o640);
        assert.equal((await readAtlasLinuxServiceLog(1, dir, owner)).available, false, 'group-readable file');
        await chmod(path, 0o600);
        await chmod(dir, 0o770);
        assert.equal((await readAtlasLinuxServiceLog(1, dir, owner)).available, false, 'group-writable parent');
        await chmod(dir, 0o700);
        await rm(path);
        await writeFile(other, 'secret\n', { mode: 0o600 });
        await symlink(other, path);
        assert.equal((await readAtlasLinuxServiceLog(1, dir, owner)).available, false, 'symlinked file');
    });
});

test('service log reader rejects caller-supplied invalid limits and does not read device paths', async () => {
    for (const lines of [0, -1, 201, 1.5, NaN, Infinity])
        await assert.rejects(() => readAtlasLinuxServiceLog(lines), (e: any) => e.code === 'INVALID_REQUEST');
    await withFixture(async dir => {
        const path = join(dir, 'service.log');
        await symlink(dir, join(dir, 'nested'));
        assert.equal((await readAtlasLinuxServiceLog(1, join(dir, 'nested'), owner)).available, false);
        await writeFile(path, 'partial untrusted value', { mode: 0o600 });
        const result = await readAtlasLinuxServiceLog(1, dir, owner);
        assert.deepEqual(result.lines, [], 'incomplete final line is not exposed');
        assert.equal(result.available, true);
        assert.equal((await lstat(path)).isFile(), true);
    });
});

test('large logs remain bounded to whole redacted lines and support in-place rotation', async () => {
    await withFixture(async dir => {
        const path = join(dir, 'service.log');
        await writeFile(path, Array.from({ length: 5000 }, (_, index) =>
            `entry-${index}: SECRET=private-${index} ${'x'.repeat(110)}\n`).join(''), { mode: 0o600 });
        const result = await readAtlasLinuxServiceLog(200, dir, owner);
        assert.equal(result.available, true);
        assert.equal(result.truncated, true);
        assert.ok(result.lines.length <= 200);
        assert.ok(Buffer.byteLength(result.lines.join('\n'), 'utf8') <= 48 * 1024);
        assert.ok(result.lines.every(line => line.startsWith('entry-')));
        assert.doesNotMatch(result.lines.join('\n'), /private-\d+/);
        // logrotate copytruncate keeps the inode; a new tail must not include old data.
        await writeFile(path, 'after-rotate\n', { mode: 0o600 });
        const rotated = await readAtlasLinuxServiceLog(10, dir, owner);
        assert.deepEqual(rotated.lines, ['after-rotate']);
        assert.equal(rotated.truncated, false);
    });
});
