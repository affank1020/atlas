import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('scripts/atlas-node-upgrade.sh');
const commit = '3e9d22be53c314ab78b0057bd2c83590aa1ed562';
const release = 'v2.0.0-3e9d22be53c3';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-upgrade-test-'));
  const bin = join(dir, 'bin'), artifact = join(dir, 'artifact'), empty = join(dir, 'empty');
  mkdirSync(bin); mkdirSync(artifact); mkdirSync(empty);
  const filename = 'atlas-node-' + release + '.tar.gz', archive = join(artifact, filename);
  const tar = spawnSync('tar', ['-czf', archive, '-C', empty, '.'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const sum = spawnSync('shasum', ['-a', '256', archive], { encoding: 'utf8' });
  assert.equal(sum.status, 0, sum.stderr);
  writeFileSync(archive + '.sha256', sum.stdout.split(/\s+/)[0] + '  ' + filename + '\n');
  const log = join(dir, 'commands.log');
  const fake = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, '#!/bin/bash\nset -e\n' + body);
    chmodSync(path, 0o700);
  };
  fake('gh', [
    'echo "gh $*" >> "$ATLAS_UPGRADE_TEST_LOG"',
    'if [[ "$1 $2" == "run list" ]]; then printf "39456645977\\t' + commit + '\\n"; exit 0; fi',
    'if [[ "$1 $2" == "run download" ]]; then',
    '  while [[ $# -gt 0 ]]; do if [[ "$1" == "--dir" ]]; then out="$2"; break; fi; shift; done',
    '  cp "$ATLAS_UPGRADE_TEST_ARCHIVE" "$out/"',
    '  cp "$ATLAS_UPGRADE_TEST_ARCHIVE.sha256" "$out/"',
    '  exit 0',
    'fi',
    'exit 2',
  ].join('\n'));
  fake('ssh', [
    'echo "ssh $*" >> "$ATLAS_UPGRADE_TEST_LOG"',
    'if [[ "$*" == *"mktemp -d"* ]]; then echo "/home/ubuntu/.atlas-node-upgrade.ABCdef12"; exit 0; fi',
    'if [[ "$*" == *"bash ./apply.sh"* ]]; then exit "${ATLAS_UPGRADE_TEST_REMOTE_STATUS:-0}"; fi',
    'exit 0',
  ].join('\n'));
  fake('scp', 'echo "scp $*" >> "$ATLAS_UPGRADE_TEST_LOG"');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH,
    ATLAS_VPS_SSH_HOST: 'ovh', ATLAS_UPGRADE_TEST_LOG: log,
    ATLAS_UPGRADE_TEST_ARCHIVE: archive, TMPDIR: dir };
  const run = (extra: Record<string, string> = {}) =>
    spawnSync('bash', [script], { env: { ...env, ...extra }, cwd: resolve('.'), encoding: 'utf8', timeout: 20000 });
  return { dir, archive, run, logs: () => readFileSync(log, 'utf8') };
}

test('upgrader parses and atlasctl exposes one-command entry', () => {
  const check = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const source = readFileSync('scripts/atlas-control.mjs', 'utf8');
  assert.match(source, /node-upgrade/);
  assert.match(source, /scripts\/atlas-node-upgrade\.sh/);
});

test('main-branch package is verified and only the remote Node lifecycle is invoked', t => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  assert.match(result.stdout, /Linux Node upgraded and WebSocket connection verified/);
  const log = f.logs();
  assert.match(log, /gh run list .*--workflow node-package\.yml --branch main --status success/);
  assert.match(log, /gh run download .*--name atlas-node-3e9d22be53c314ab78b0057bd2c83590aa1ed562/);
  assert.match(log, /scp .*atlas-node-v2\.0\.0-3e9d22be53c3\.tar\.gz/);
  assert.match(log, /ssh -tt .*bash \.\/apply\.sh 'v2\.0\.0-3e9d22be53c3'/);
  const contents = readFileSync(script, 'utf8');
  assert.match(contents, /lifecycle=\/usr\/local\/libexec\/atlas-node-lifecycle\.sh/);
  assert.match(contents, /sudo -n "\$lifecycle" activate "\$release"/);
  assert.doesNotMatch(contents, /sudo -n atlas-node-lifecycle (plan|activate)/);
  assert.doesNotMatch(contents, /docker compose|systemctl restart|ATLAS_NODE_CREDENTIAL/);
});

test('invalid checksum and hostile SSH host fail before remote mutation', t => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  writeFileSync(f.archive + '.sha256', '0'.repeat(64) + '  atlas-node-' + release + '.tar.gz\n');
  assert.notEqual(f.run().status, 0);
  assert.doesNotMatch(f.logs(), /ssh |scp /);
  const invalidHost = f.run({ ATLAS_VPS_SSH_HOST: '-oProxyCommand=evil' });
  assert.notEqual(invalidHost.status, 0);
  assert.match(invalidHost.stderr, /Invalid ATLAS_VPS_SSH_HOST/);
});

test('failed remote activation does not claim success', t => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const result = f.run({ ATLAS_UPGRADE_TEST_REMOTE_STATUS: '17' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VPS upgrade failed/);
  assert.doesNotMatch(result.stdout, /Linux Node upgraded and WebSocket connection verified/);
});

/** Exercise the exact remote apply script that the normal atlasctl upgrade sends over SSH. */
test('normal VPS upgrade uses the recovery-aware executable; interrupted activation cannot report success', t => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const source = readFileSync(script, 'utf8');
  const match = source.match(/cat > "\$scratch\/apply\.sh" <<'REMOTE'\n([\s\S]*?)\nREMOTE/);
  assert.ok(match, 'remote apply heredoc is part of the standard upgrade entrypoint');
  const remote = join(f.dir, 'remote');
  mkdirSync(remote);
  writeFileSync(join(remote, 'apply.sh'), match[1] + '\n');
  copyFileSync(f.archive, join(remote, 'atlas-node-' + release + '.tar.gz'));
  copyFileSync(f.archive + '.sha256', join(remote, 'atlas-node-' + release + '.tar.gz.sha256'));
  const sudo = join(f.dir, 'bin', 'sudo');
  writeFileSync(sudo, `#!/usr/bin/env bash
echo "sudo $*" >> "$ATLAS_UPGRADE_TEST_LOG"
case "$*" in
  "-v") exit 0 ;;
  "-n test -x /usr/local/libexec/atlas-node-lifecycle.sh")
    exit "\${ATLAS_TEST_MISSING_LIFECYCLE:-0}" ;;
  "-n systemctl is-enabled --quiet atlas-node-lifecycle-recover.timer"|
  "-n systemctl is-active --quiet atlas-node-lifecycle-recover.timer")
    exit "\${ATLAS_TEST_MISSING_WATCHDOG:-0}" ;;
  "-n test -d /opt/atlas-node/releases/"*) exit 0 ;;
  "-n /usr/local/libexec/atlas-node-lifecycle.sh plan "*) exit 0 ;;
  "-n /usr/local/libexec/atlas-node-lifecycle.sh activate "*)
    exit "\${ATLAS_TEST_ACTIVATION_STATUS:-0}" ;;
  "-n /usr/local/libexec/atlas-node-lifecycle.sh status") exit 0 ;;
esac
echo "Unexpected privileged command: $*" >&2
exit 99
`);
  chmodSync(sudo, 0o700);
  const runRemote = (extra: Record<string, string> = {}) => spawnSync('bash', [join(remote, 'apply.sh'), release], {
    cwd: remote, encoding: 'utf8', timeout: 12000,
    env: { ...process.env, PATH: join(f.dir, 'bin') + ':' + process.env.PATH,
      ATLAS_UPGRADE_TEST_LOG: join(f.dir, 'commands.log'), ...extra },
  });
  const success = runRemote();
  assert.equal(success.status, 0, success.stderr);
  assert.match(f.logs(), /sudo -n \/usr\/local\/libexec\/atlas-node-lifecycle\.sh plan/);
  assert.match(f.logs(), /sudo -n \/usr\/local\/libexec\/atlas-node-lifecycle\.sh activate/);
  assert.match(f.logs(), /sudo -n \/usr\/local\/libexec\/atlas-node-lifecycle\.sh status/);
  writeFileSync(join(f.dir, 'commands.log'), '');
  const interrupted = runRemote({ ATLAS_TEST_ACTIVATION_STATUS: '137' });
  assert.notEqual(interrupted.status, 0);
  assert.match(f.logs(), /sudo -n \/usr\/local\/libexec\/atlas-node-lifecycle\.sh activate/);
  assert.doesNotMatch(f.logs(), /lifecycle\.sh status/);
  writeFileSync(join(f.dir, 'commands.log'), '');
  const missingWatchdog = runRemote({ ATLAS_TEST_MISSING_WATCHDOG: '1' });
  assert.notEqual(missingWatchdog.status, 0);
  assert.match(missingWatchdog.stderr, /watchdog is not enabled and active/);
  assert.doesNotMatch(f.logs(), /lifecycle\.sh plan|lifecycle\.sh activate|linux-node-release\.sh install/);
  writeFileSync(join(f.dir, 'commands.log'), '');
  const missingExecutable = runRemote({ ATLAS_TEST_MISSING_LIFECYCLE: '1' });
  assert.notEqual(missingExecutable.status, 0);
  assert.match(missingExecutable.stderr, /Recovery-aware Node lifecycle not installed/);
  assert.doesNotMatch(f.logs(), /lifecycle\.sh plan|lifecycle\.sh activate|linux-node-release\.sh install/);
});
