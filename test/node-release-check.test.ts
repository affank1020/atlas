import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/atlas-node-release-check.sh');

test('release checker parses and rejects unsupported update modes', () => {
  const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const reject = spawnSync('bash', [script, '--apply'], { encoding: 'utf8' });
  assert.equal(reject.status, 2);
});

test('release checker discovers a package without downloading or touching SSH', t => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'gh');
  writeFileSync(fake, '#!/bin/sh\nprintf "123456\\t' + 'a'.repeat(40) + '\\n"\n', { mode: 0o755 });
  const result = spawnSync('bash', [script, '--check'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir + ':' + process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Node package run: 123456/);
  assert.match(result.stdout, /Commit: a{40}/);
});
