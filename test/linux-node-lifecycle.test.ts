import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/linux-node-lifecycle.sh');
const available = process.platform === 'linux' &&
    spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;
const sha = 'a'.repeat(40);
const newerSha = 'b'.repeat(40);

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'atlas-node-lifecycle-test-'));
    const releases = join(root, 'releases');
    const bin = join(root, 'bin');
    const status = join(root, 'node-status.json');
    const log = join(root, 'events.log');
    mkdirSync(releases, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const makeRelease = (hash: string) => {
        const name = 'v2.0.0-' + hash.slice(0, 12);
        const folder = join(releases, name);
        mkdirSync(join(folder, 'apps/node/dist/platforms/desktop'), { recursive: true });
        mkdirSync(join(folder, 'node_modules/ws'), { recursive: true });
        writeFileSync(join(folder, 'apps/node/dist/platforms/desktop/main.js'), '// built node');
        writeFileSync(join(folder, 'node_modules/ws/package.json'), '{"name":"ws"}');
        writeFileSync(join(folder, 'atlas-node-release.json'), JSON.stringify({
            application: '@atlas/node', protocol: 2, version: '2.0.0',
            commit: hash, entrypoint: 'apps/node/dist/platforms/desktop/main.js',
        }));
        return { name, folder };
    };
    const old = makeRelease(sha);
    const newer = makeRelease(newerSha);
    symlinkSync(old.folder, join(root, 'current'));
    writeFileSync(status, JSON.stringify({ pid: 4242, state: 'connected' }));
    const shellScript = [
        '#!/usr/bin/env bash',
        'echo "$*" >> "$ATLAS_TEST_EVENTS"',
        'case "$1" in',
        '  is-active) exit 0 ;;',
        '  show) echo 4242 ;;',
        '  restart)',
        '    if [[ "${ATLAS_TEST_KILL_ACTIVATOR:-0}" == "1" ]]; then',
        '      kill -KILL "$PPID"',
        '      sleep 0.1',
        '    fi',
        '    target="$(readlink "$ATLAS_LIFECYCLE_ROOT/current")"',
        '    if [[ "$ATLAS_TEST_FAIL_TARGET" == "$target" || "${ATLAS_TEST_FAIL_ALL:-0}" == "1" ]]; then',
        '      printf \'{"pid":4242,"state":"reconnecting"}\' > "$ATLAS_LIFECYCLE_STATUS_FILE"',
        '    else',
        '      printf \'{"pid":4242,"state":"connected"}\' > "$ATLAS_LIFECYCLE_STATUS_FILE"',
        '    fi',
        '    exit 0 ;;',
        'esac',
    ].join('\n') + '\n';
    writeFileSync(join(bin, 'systemctl'), shellScript, { mode: 0o700 });
    writeFileSync(join(bin, 'npm'), '#!/bin/bash\nexit 0\n', { mode: 0o700 });
    const env = {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        ATLAS_LIFECYCLE_ROOT: root,
        ATLAS_LIFECYCLE_STATUS_FILE: status,
        ATLAS_LIFECYCLE_LOCK_FILE: join(root, 'update.lock'),
        ATLAS_LIFECYCLE_TIMEOUT: '1',
        ATLAS_TEST_EVENTS: log,
    };
    const run = (args: string[], overrides: Record<string, string> = {}) =>
        spawnSync('bash', [script, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000 });
    return { root, old, newer, status, log, run };
}

test('Linux Node lifecycle script parses', () => {
    const check = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
});

test('lifecycle status/plan are read-only, activation checks connection and records previous', { skip: !available }, t => {
    const f = fixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const plan = f.run(['plan', f.newer.name]);
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
    const active = f.run(['activate', f.newer.name]);
    assert.equal(active.status, 0, active.stderr);
    assert.equal(readlinkSync(join(f.root, 'current')), f.newer.folder);
    assert.equal(readlinkSync(join(f.root, 'previous')), f.old.folder);
    assert.match(active.stdout, /WebSocket registration confirmed/);
    assert.equal(f.run(['status']).status, 0);
    const rollback = f.run(['rollback']);
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
});

test('lifecycle refuses missing target and auto-rolls back an unconnected release', { skip: !available }, t => {
    const f = fixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    assert.notEqual(f.run(['activate', 'v2.0.0-' + 'c'.repeat(12)]).status, 0);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
    const failed = f.run(['activate', f.newer.name], { ATLAS_TEST_FAIL_TARGET: f.newer.folder });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /restoring previous release/);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
    assert.equal(f.run(['status']).status, 0);
    const events = readFileSync(f.log, 'utf8');
    assert.ok((events.match(/^restart atlas-node$/gm) ?? []).length >= 2);
});

test('killed activator leaves a durable journal; host recovery restores and restarts old Node', { skip: !available }, t => {
    const f = fixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const killed = f.run(['activate', f.newer.name], { ATLAS_TEST_KILL_ACTIVATOR: '1' });
    assert.notEqual(killed.status, 0, 'a killed activation cannot report success');
    assert.equal(readlinkSync(join(f.root, 'current')), f.newer.folder);
    assert.equal(readFileSync(join(f.root, '.activation-pending'), 'utf8'), f.old.name + '\n' + f.newer.name + '\nactivate\n');
    assert.match(f.run(['status']).stdout, /Recovery: pending/);
    const blocked = f.run(['rollback']);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Pending activation must be recovered/);
    const restored = f.run(['recover']);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
    assert.equal(existsSync(join(f.root, '.activation-pending')), false);
    assert.match(restored.stdout, /Recovery completed/);
    assert.match(readFileSync(f.log, 'utf8'), /restart atlas-node/);
    assert.equal(f.run(['recover']).status, 0, 'recovery should be idempotent');
});

test('malformed interrupted activation journal cannot redirect or trigger a recovery', { skip: !available }, t => {
    const f = fixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    writeFileSync(join(f.root, '.activation-pending'), 'v2.0.0-' + 'c'.repeat(12) + '\n/other/path\n');
    const recovery = f.run(['recover']);
    assert.notEqual(recovery.status, 0);
    assert.match(recovery.stderr, /Invalid pending activation journal/);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
    assert.equal(existsSync(f.log), false, 'no systemctl invocation permitted with a malformed journal');
    assert.notEqual(f.run(['activate', f.newer.name]).status, 0);
});

test('unhealthy rollback remains pending until independent recovery observes a connection', { skip: !available }, t => {
    const f = fixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const failed = f.run(['activate', f.newer.name], { ATLAS_TEST_FAIL_ALL: '1' });
    assert.notEqual(failed.status, 0);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
    assert.equal(existsSync(join(f.root, '.activation-pending')), true,
        'unhealthy rollback must keep the pending journal');
    const recovered = f.run(['recover']);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
    assert.equal(existsSync(join(f.root, '.activation-pending')), false);
});

test('interrupted manual rollback finishes rollback, never restores the rejected version', { skip: !available }, t => {
    const f = fixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const installed = f.run(['activate', f.newer.name]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(readlinkSync(join(f.root, 'current')), f.newer.folder);
    const killed = f.run(['rollback'], { ATLAS_TEST_KILL_ACTIVATOR: '1' });
    assert.notEqual(killed.status, 0);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
    assert.equal(readFileSync(join(f.root, '.activation-pending'), 'utf8'),
        f.newer.name + '\n' + f.old.name + '\nrollback\n');
    const recovered = f.run(['recover']);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder,
        'recovery must never undo an explicitly requested rollback');
    assert.equal(existsSync(join(f.root, '.activation-pending')), false);
});

test('failed manual rollback does not re-activate its rejected newer release', { skip: !available }, t => {
    const f = fixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    assert.equal(f.run(['activate', f.newer.name]).status, 0);
    const failed = f.run(['rollback'], { ATLAS_TEST_FAIL_TARGET: f.old.folder });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /host recovery will retry/);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
    assert.equal(existsSync(join(f.root, '.activation-pending')), true);
    const recovered = f.run(['recover']);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readlinkSync(join(f.root, 'current')), f.old.folder);
    assert.equal(existsSync(join(f.root, '.activation-pending')), false);
});
