import test from 'node:test';
import assert from 'node:assert/strict';
import { readAtlasLinuxJournal, type JournalRunner } from '../apps/node/src/capabilities/linux-journal.js';

test('Linux Node journal request uses only the Atlas unit, fixed binary and bounded arguments', async () => {
    let called = false;
    const runner: JournalRunner = async (file, args, options) => {
        called = true;
        assert.equal(file, '/usr/bin/journalctl');
        assert.deepEqual(args, ['--no-pager', '--quiet', '--output=short-iso', '--unit=atlas-node.service', '--lines=3']);
        assert.deepEqual(options.env, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
        assert.equal(options.timeout, 3000);
        assert.equal(options.maxBuffer, 256 * 1024);
        return { stdout: [
            '2026-10-21T21:00:00+0100 atlas-node[1]: connected',
            '2026-10-21T21:00:01+0100 atlas-node[1]: Authorization: Bearer supersecret-token',
            '2026-10-21T21:00:02+0100 atlas-node[1]: DATABASE_URL=postgresql://user:password@db/atlas',
        ].join('\n') + '\n', stderr: '' };
    };
    const output = await readAtlasLinuxJournal(3, runner);
    assert.equal(called, true);
    assert.equal(output.available, true);
    assert.equal(output.source, 'journal');
    assert.equal(output.lines.length, 3);
    assert.equal(output.truncated, true, 'A full tail is not proof of complete historical retention');
    assert.match(output.lines[0], /2026-10-21T21:00:00/);
    assert.doesNotMatch(output.lines.join('\n'), /supersecret-token|user:password/);
    assert.match(output.lines.join('\n'), /REDACTED/);
});

test('Linux journal reports denied, unavailable, and timed-out reads without exposing diagnostics', async () => {
    for (const failure of [
        async () => { throw new Error('Permission denied: /run/secrets/private-password'); },
        async () => ({ stdout: '', stderr: 'Permission denied: /run/secrets/private-password' }),
    ]) {
        const response = await readAtlasLinuxJournal(5, failure as JournalRunner);
        assert.deepEqual(response, { source: 'journal', lines: [], available: false, truncated: false });
    }
});

test('Linux journal rejects non-integer, zero and unbounded line requests before spawning', async () => {
    const runner: JournalRunner = async () => { throw new Error('Runner must not be called'); };
    for (const lines of [0, -1, 201, 1.1, NaN, Infinity]) {
        await assert.rejects(() => readAtlasLinuxJournal(lines, runner), /Invalid Atlas Node log request/);
    }
});

test('Linux journal bounds output to whole, redacted log lines', async () => {
    const output = await readAtlasLinuxJournal(200, async () => ({
        stdout: Array.from({ length: 120 }, (_, n) => `2026-10-21T21:00:00 atlas-node[${n}]: TOKEN=confidential-${n} ${'x'.repeat(850)}`).join('\n'),
        stderr: '',
    }));
    assert.equal(output.available, true);
    assert.equal(output.truncated, true);
    assert.ok(Buffer.byteLength(output.lines.join('\n'), 'utf8') <= 48 * 1024);
    assert.ok(output.lines.length < 120);
    assert.ok(output.lines.every(line => line.startsWith('2026-10-21T21:00:00')));
    assert.doesNotMatch(output.lines.join('\n'), /confidential-\d+/);
});
