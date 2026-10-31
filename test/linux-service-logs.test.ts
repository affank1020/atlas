import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAtlasLinuxServiceLog } from '../apps/node/src/capabilities/linux-service-logs.js';
import { createNodeRuntimeLogger } from '../apps/node/src/core/runtime-logger.js';

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


test('Linux Node diagnostics carry UTC event times through the real private-file reader', async () => {
    await withFixture(async dir => {
        const emitted: string[] = [];
        const sink = {
            log: (line: string) => emitted.push(line + '\n'),
            warn: (line: string) => emitted.push(line + '\n'),
            error: (line: string) => emitted.push(line + '\n'),
        };
        const times = [
            new Date('2026-10-31T14:40:00.000Z'),
            new Date('2026-10-31T14:40:03.050Z'),
            new Date('2026-10-31T14:40:05.950Z'),
        ];
        const logger = createNodeRuntimeLogger('linux', sink, () => times.shift()!);
        logger.info('Atlas Node connected to Atlas Server.');
        logger.warn('Atlas Node WebSocket closed (code 1006); reconnecting.');
        logger.error('Atlas Node connection failed: timeout\ninvestigate retry. Retrying.');
        // These are emitted via the same source logger used in main.ts,
        // not timestamped fixture strings fabricated in the reader.
        await writeFile(join(dir, 'service.log'), emitted.join(''), { mode: 0o600 });
        const result = await readAtlasLinuxServiceLog(10, dir, owner);
        assert.equal(result.available, true);
        assert.deepEqual(result.lines, [
            '2026-10-31T14:40:00.000Z Atlas Node connected to Atlas Server.',
            '2026-10-31T14:40:03.050Z Atlas Node WebSocket closed (code 1006); reconnecting.',
            '2026-10-31T14:40:05.950Z Atlas Node connection failed: timeout',
            '2026-10-31T14:40:05.950Z investigate retry. Retrying.',
        ]);
        assert.ok(result.lines.every(line =>
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /.test(line)));
    });
});

test('macOS output format is preserved and Linux logger keeps severity streams', () => {
    const events: Array<{ level: string; text: string }> = [];
    const sink = {
        log: (text: string) => events.push({ level: 'info', text }),
        warn: (text: string) => events.push({ level: 'warn', text }),
        error: (text: string) => events.push({ level: 'error', text }),
    };
    const now = () => new Date('2026-10-31T14:40:00.000Z');
    const mac = createNodeRuntimeLogger('darwin', sink, now);
    mac.info('connected'); mac.warn('retrying'); mac.error('failed');
    assert.deepEqual(events.splice(0), [
        { level: 'info', text: 'connected' }, { level: 'warn', text: 'retrying' },
        { level: 'error', text: 'failed' },
    ]);
    const linux = createNodeRuntimeLogger('linux', sink, now);
    linux.warn('failed\rnext attempt');
    assert.deepEqual(events, [{
        level: 'warn', text: '2026-10-31T14:40:00.000Z failed\n2026-10-31T14:40:00.000Z next attempt',
    }]);
});
