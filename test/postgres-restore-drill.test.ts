import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/postgres-restore-drill.sh', import.meta.url));
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'atlas-restore-drill-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const archive = path.join(root, 'atlas-import-20261022.dump.age');
  const ciphertext = Buffer.alloc(260, 88);
  writeFileSync(archive, ciphertext, {mode: 0o600});
  const hash = createHash('sha256').update(ciphertext).digest('hex');
  const manifest = archive + '.json';
  writeFileSync(manifest, JSON.stringify({
    schemaVersion: 1, kind: 'postgres-custom-age', database: 'atlas_import',
    createdAt: '2026-10-22T10:00:00Z', bytes: ciphertext.length,
    ciphertextSha256: hash, verifiedRestore: false,
  }), {mode: 0o600});
  const identity = path.join(root, 'offline-age-identity');
  writeFileSync(identity, 'AGE-SECRET-KEY-fake-test-only\n', {mode: 0o600});
  const trace = path.join(root, 'docker-trace');
  const fakeDocker = [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$MOCK_DOCKER_TRACE"',
    '[[ "$1" == --host && "$2" == unix:///var/run/docker.sock ]] || exit 81',
    'shift 2',
    'if [[ "$1" == info ]]; then printf "%s\\n" "$MOCK_DOCKER_ID"; exit 0; fi',
    'if [[ "$1" == run ]]; then printf "mockcontainer\\n"; exit 0; fi',
    'if [[ "$1" == inspect ]]; then',
    '  if [[ "$MOCK_BAD_MOUNTS" == 1 ]]; then',
    '    printf \'{"HostConfig":{"Tmpfs":{"/var/lib/postgresql/data":"rw,size=1536m"},"NetworkMode":"none"},"Mounts":[{"Type":"volume","Destination":"/var/lib/postgresql/data"}]}\\n\'',
    '  else',
    '    printf \'{"HostConfig":{"Tmpfs":{"/var/lib/postgresql/data":"rw,size=1536m"},"NetworkMode":"none"},"Mounts":[]}\\n\'',
    '  fi',
    '  exit 0',
    'fi',
    'if [[ "$1" == rm ]]; then exit 0; fi',
    'if [[ "$*" == *"pg_isready"* ]]; then exit 0; fi',
    'if [[ "$*" == *"pg_restore"* ]]; then cat >/dev/null; [[ "$MOCK_RESTORE_FAIL" == 1 ]] && exit 32; exit 0; fi',
    'if [[ "$*" == *"psql"* ]]; then [[ "$MOCK_ZERO_PROJECTS" == 1 ]] && printf "0\\n" || printf "3\\n"; exit 0; fi',
    'exit 87',
    '',
  ].join('\n');
  const fakeAge = [
    '#!/usr/bin/env bash',
    '[[ "$1" == --decrypt ]] || exit 88',
    'if [[ "$MOCK_AGE_FAIL" == 1 ]]; then exit 35; fi',
    'printf "PGDMP mock archive content"',
    '',
  ].join('\n');
  writeFileSync(path.join(bin, 'docker'), fakeDocker, {mode:0o700});
  writeFileSync(path.join(bin, 'age'), fakeAge, {mode:0o700});
  const run = (args: string[], overrides: Record<string, string> = {}) =>
    spawnSync('bash', [script, ...args], {encoding:'utf8', cwd:root,
      env: {...process.env, PATH:bin + ':' + process.env.PATH,
        MOCK_DOCKER_TRACE:trace, MOCK_RESTORE_FAIL:'0', MOCK_ZERO_PROJECTS:'0', MOCK_AGE_FAIL:'0',
        MOCK_BAD_MOUNTS:'0', MOCK_DOCKER_ID:'LOCAL-RECOVERY-DAEMON-123',
        ATLAS_RECOVERY_DOCKER_ID:'LOCAL-RECOVERY-DAEMON-123',
        DOCKER_HOST:'', DOCKER_CONTEXT:'', DOCKER_CONFIG:'', DOCKER_TLS_VERIFY:'', DOCKER_CERT_PATH:'',
        ...overrides}});
  return {root,archive,manifest,identity,trace,hash,run};
}

test('default dry run validates ciphertext but never launches Docker or decrypts', t => {
  const f=fixture(t);
  const r=f.run(['--archive='+f.archive]);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/DRY RUN PASSED:/);
  assert.match(r.stdout,/restore_verified=false/);
  assert.equal(existsSync(f.trace),false);
});

test('refuses corrupted, malformed, and insecure local files', t => {
  const f=fixture(t);
  writeFileSync(f.archive, Buffer.alloc(260,70));
  assert.notEqual(f.run(['--archive='+f.archive]).status,0);
  assert.equal(existsSync(f.trace),false);
  const metadata=JSON.parse(readFileSync(f.manifest,'utf8'));
  metadata.ciphertextSha256 = createHash('sha256').update(Buffer.alloc(260,70)).digest('hex');
  metadata.database = '../../atlas';
  writeFileSync(f.manifest,JSON.stringify(metadata));
  assert.notEqual(f.run(['--archive='+f.archive]).status,0);
  metadata.database='atlas_import';
  writeFileSync(f.manifest,JSON.stringify(metadata));
  chmodSync(f.archive,0o644);
  assert.notEqual(f.run(['--archive='+f.archive]).status,0);
  chmodSync(f.archive,0o600);
  const link=path.join(f.root,'linked.dump.age');
  symlinkSync(f.archive,link);
  assert.notEqual(f.run(['--archive='+link]).status,0);
  assert.equal(existsSync(f.trace),false);
});

test('requires exact explicit apply confirmation and a private identity', t => {
  const f=fixture(t);
  const base=['--archive='+f.archive,'--identity='+f.identity];
  for(const args of [ [...base,'--apply'],[...base,'--confirm=ISOLATED_PG_RESTORE'],
    [...base,'--apply','--confirm=BAD'],[...base,'--dry-run'] ])
    assert.notEqual(f.run(args).status,0);
  chmodSync(f.identity,0o644);
  assert.notEqual(f.run([...base,'--apply','--confirm=ISOLATED_PG_RESTORE']).status,0);
  assert.equal(existsSync(f.trace),false);
});

test('successful drill uses ephemeral networkless container and reports SHA', t => {
  const f=fixture(t);
  const r=f.run(['--archive='+f.archive,'--identity='+f.identity,'--apply','--confirm=ISOLATED_PG_RESTORE']);
  assert.equal(r.status,0,r.stderr);
  const report=JSON.parse(r.stdout);
  assert.equal(report.status,'isolated_restore_passed');
  assert.equal(report.archiveCiphertextSha256,f.hash);
  assert.equal(report.databaseRestored,true);
  assert.equal(report.noHostBackedDatabaseVolume,true);
  assert.equal(report.r2ObjectsRestored,false);
  const log=readFileSync(f.trace,'utf8');
  assert.match(log,/--host unix:\/\/\/var\/run\/docker.sock info --format/);
  assert.match(log,/--host unix:\/\/\/var\/run\/docker.sock run --detach --rm --name atlas-pg-drill-/);
  assert.match(log,/--host unix:\/\/\/var\/run\/docker.sock inspect --format/);
  assert.ok(log.trim().split('\n').every(line=>line.startsWith('--host unix:///var/run/docker.sock ')));
  assert.match(log,/--network none/);
  assert.match(log,/--tmpfs \/var\/lib\/postgresql\/data:rw,nosuid,nodev,noexec,size=1536m,mode=0700/);
  assert.match(log,/POSTGRES_DB=atlas_recovery/);
  assert.match(log,/pg_restore/);
  assert.match(log,/psql/);
  assert.match(log,/rm -f atlas-pg-drill-/);
  // Only inspect docker run options: psql itself uses -v ON_ERROR_STOP=1.
  const dockerRun=log.split('\n').find(line => line.includes(' run --detach '));
  assert.ok(dockerRun);
  assert.doesNotMatch(dockerRun,/(^| )(-p|--publish|-v|--volume|--network host)( |$)/);
});

test('failed decrypt, failed restore and empty restored catalog never report success and clean container', t => {
  for(const setting of ['MOCK_AGE_FAIL','MOCK_RESTORE_FAIL','MOCK_ZERO_PROJECTS']) {
    const f=fixture(t);
    const r=f.run(['--archive='+f.archive,'--identity='+f.identity,'--apply','--confirm=ISOLATED_PG_RESTORE'],{[setting]:'1'});
    assert.notEqual(r.status,0,setting);
    assert.doesNotMatch(r.stdout,/isolated_restore_passed/);
    assert.match(readFileSync(f.trace,'utf8'),/rm -f atlas-pg-drill-/);
  }
});

test('never runs from a production deploy working directory', t => {
  const f=fixture(t);
  mkdirSync(path.join(f.root,'infra'));
  writeFileSync(path.join(f.root,'infra/production.env'),'MOCK=1');
  const r=f.run(['--archive='+f.archive,'--identity='+f.identity,'--apply','--confirm=ISOLATED_PG_RESTORE']);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/production deployment directory/);
  assert.equal(existsSync(f.trace),false);
});

test('refuses Docker endpoint overrides before accessing even the mocked daemon', t => {
  for (const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']) {
    const f=fixture(t);
    const r=f.run(['--archive='+f.archive,'--identity='+f.identity,'--apply','--confirm=ISOLATED_PG_RESTORE'],
      {[key]:'ssh://production.example'});
    assert.notEqual(r.status,0,key);
    assert.match(r.stderr,/overrides are not permitted/);
    assert.equal(existsSync(f.trace),false);
  }
});

test('refuses missing or mismatched approved recovery daemon before container creation', t => {
  for (const overrides of [
    {ATLAS_RECOVERY_DOCKER_ID:''},
    {ATLAS_RECOVERY_DOCKER_ID:'OTHER-DOCKER-DAEMON'},
    {MOCK_DOCKER_ID:'ANOTHER-DOCKER-DAEMON'}
  ]) {
    const f=fixture(t);
    const r=f.run(['--archive='+f.archive,'--identity='+f.identity,'--apply','--confirm=ISOLATED_PG_RESTORE'],overrides);
    assert.notEqual(r.status,0);
    assert.equal(existsSync(f.trace) ? readFileSync(f.trace,'utf8').includes(' run ') : false,false);
    assert.doesNotMatch(r.stdout,/isolated_restore_passed/);
  }
});

test('refuses Docker implicit volume and cleans container before decrypting', t => {
  const f=fixture(t);
  const r=f.run(['--archive='+f.archive,'--identity='+f.identity,'--apply','--confirm=ISOLATED_PG_RESTORE'],
    {MOCK_BAD_MOUNTS:'1'});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Docker isolation inspection failed/);
  const commands=readFileSync(f.trace,'utf8');
  assert.match(commands,/ inspect --format /);
  assert.match(commands,/ rm -f atlas-pg-drill-/);
  assert.doesNotMatch(commands,/ pg_restore/);
  assert.doesNotMatch(r.stdout,/isolated_restore_passed/);
});
