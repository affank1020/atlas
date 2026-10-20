import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const script = 'scripts/linux-node-preflight.sh';
const run = (arg: string) => spawnSync('bash', [script, arg], { encoding: 'utf8', timeout: 3000 });

test('Linux preflight is syntactically valid, read-only and rejects unexpected flags', () => {
    const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const help = run('--help');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Read|read|preflight|diagnostic/);
    assert.equal(run('--unknown').status, 2);
});

test('Linux preflight emits bounded numeric readiness without exposing environment', () => {
    const out = run('--json');
    if (process.platform !== 'linux') {
        assert.equal(out.status, 2);
        assert.match(out.stderr, /Linux VPS/);
        return;
    }
    assert.equal(out.status, 0, out.stderr);
    const info = JSON.parse(out.stdout);
    assert.equal(typeof info.ready, 'boolean');
    for (const key of ['memoryTotalMiB', 'memoryAvailableMiB', 'swapTotalMiB', 'swapFreeMiB',
        'diskAvailableMiB', 'cpus', 'nodeMajor']) {
        assert.ok(Number.isInteger(info[key]) && info[key] >= 0, key);
    }
    assert.ok(info.memoryAvailableMiB <= info.memoryTotalMiB);
    assert.equal(typeof info.git, 'boolean');
    assert.equal(typeof info.systemd, 'boolean');
    assert.ok(!Object.hasOwn(info, 'hostname') && !Object.hasOwn(info, 'environment'));
});
