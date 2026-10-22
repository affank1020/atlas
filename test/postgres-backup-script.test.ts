import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync, symlinkSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const script = fileURLToPath(new URL("../scripts/postgres-backup.sh", import.meta.url));
function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "atlas-pg-backup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const deploy = path.join(root, "deploy");
  const output = path.join(root, "private");
  mkdirSync(bin);
  mkdirSync(path.join(deploy, "infra"), { recursive: true });
  writeFileSync(path.join(deploy, "infra/production.env"), "POSTGRES_PASSWORD=testing-only\n");
  writeFileSync(path.join(deploy, "infra/docker-compose.production.yml"), "services: {}\n");
  const trace = path.join(root, "trace");
  const docker = [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "$*" >> "$MOCK_TRACE"',
    'if [[ "$*" == *"exec -T server node -e"* ]]; then',
    '  printf "%s" "$FAKE_DATABASE"',
    "  exit 0",
    "fi",
    'if [[ "$*" == *"exec -T postgres pg_dump"* ]]; then',
    '  printf "PGDMPmock-consistent-snapshot"',
    '  if [[ "$FAKE_DUMP_FAIL" == 1 ]]; then exit 7; fi',
    "  exit 0",
    "fi",
    "exit 8",
    "",
  ].join("\n");
  const age = [
    "#!/usr/bin/env bash",
    'printf "age-encryption.org/v1\\n"',
    "head -c 200 /dev/zero | tr '\\0' x",
    "cat",
    'if [[ "$FAKE_AGE_FAIL" == 1 ]]; then exit 7; fi',
    "",
  ].join("\n");
  writeFileSync(path.join(bin, "docker"), docker);
  writeFileSync(path.join(bin, "age"), age);
  chmodSync(path.join(bin, "docker"), 0o700);
  chmodSync(path.join(bin, "age"), 0o700);
  const run = (args: string[], overrides: Record<string, string> = {}) => spawnSync("bash", [script, ...args], {
    cwd: deploy, encoding: "utf8",
    env: { ...process.env, HOME: root, PATH: bin + ":" + process.env.PATH,
      MOCK_TRACE: trace, FAKE_DATABASE:"atlas_import", FAKE_DUMP_FAIL:"0", FAKE_AGE_FAIL:"0",
      ATLAS_PG_BACKUP_RECIPIENT: "age1testpublicrecipient", ...overrides },
  });
  return { root, output, trace, run };
}

test("default dry run only inspects active database", t => {
  const f = fixture(t);
  const result = f.run(["--out-dir=" + f.output]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN: active_database=atlas_import/);
  assert.match(readFileSync(f.trace, "utf8"), /exec -T server/);
  assert.doesNotMatch(readFileSync(f.trace, "utf8"), /pg_dump/);
  assert.equal(existsSync(f.output), false);
});

test("mutations require exact explicit confirmation", t => {
  const f = fixture(t);
  for (const args of [
    ["--apply"], ["--confirm=BACKUP_POSTGRES"], ["--apply", "--confirm=WRONG"],
    ["--dry-run", "--apply", "--confirm=BACKUP_POSTGRES"],
  ]) {
    const r = f.run([...args, "--out-dir=" + f.output]);
    assert.notEqual(r.status, 0);
  }
  assert.equal(existsSync(f.output), false);
});

test("creates private encrypted output and sidecar with unverified restore status", t => {
  const f = fixture(t);
  const r = f.run(["--apply", "--confirm=BACKUP_POSTGRES", "--out-dir=" + f.output]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(f.trace, "utf8"), /pg_dump/);
  const names = readdirSync(f.output);
  assert.equal(names.length, 2);
  const name = names.find(n => n.endsWith(".dump.age"));
  assert.ok(name);
  const ciphertext = readFileSync(path.join(f.output, name));
  assert.ok(ciphertext.toString().startsWith("age-encryption.org/v1\n"));
  assert.equal(lstatSync(path.join(f.output, name)).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.output).mode & 0o777, 0o700);
  const manifest = JSON.parse(readFileSync(path.join(f.output, name + ".json"), "utf8"));
  assert.equal(manifest.database, "atlas_import");
  assert.equal(manifest.verifiedRestore, false);
  assert.equal(manifest.bytes, ciphertext.length);
  assert.equal(manifest.ciphertextSha256, createHash("sha256").update(ciphertext).digest("hex"));
});

test("failed pg_dump or age never publishes a backup", t => {
  const f = fixture(t);
  for (const key of ["FAKE_DUMP_FAIL", "FAKE_AGE_FAIL"]) {
    const r = f.run(["--apply", "--confirm=BACKUP_POSTGRES", "--out-dir=" + f.output], { [key]: "1" });
    assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(f.output), []);
  }
});

test("refuses unsafe and symlinked destination", t => {
  const f = fixture(t);
  mkdirSync(f.output, { mode: 0o755 });
  const bad = f.run(["--apply", "--confirm=BACKUP_POSTGRES", "--out-dir=" + f.output]);
  assert.notEqual(bad.status, 0);
  assert.deepEqual(readdirSync(f.output), []);
  const target = path.join(f.root, "target"); mkdirSync(target, { mode: 0o700 });
  const link = path.join(f.root, "linked"); symlinkSync(target, link);
  const badLink = f.run(["--apply", "--confirm=BACKUP_POSTGRES", "--out-dir=" + link]);
  assert.notEqual(badLink.status, 0);
  assert.deepEqual(readdirSync(target), []);
});

test("refuses malformed active DB names before dump", t => {
  const f = fixture(t);
  const r = f.run(["--apply", "--confirm=BACKUP_POSTGRES", "--out-dir=" + f.output], { FAKE_DATABASE: "atlas\nunsafe" });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(readFileSync(f.trace, "utf8"), /pg_dump/);
});
