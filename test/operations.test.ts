import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Atlas Control CLI parses after adding hosted Node mode", () => {
  const result = spawnSync(process.execPath, ["--check", "scripts/atlas-control.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("VPS diagnostic shell script passes Bash syntax validation", () => {
  const result = spawnSync("bash", ["-n", "scripts/atlas-vps.sh"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("Atlas Control defaults to hosted Node, with explicit local dev and VPS modes", () => {
  const result = spawnSync(process.execPath, ["scripts/atlas-control.mjs", "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /atlasctl up\s+Start only the MacBook Node/);
  assert.match(result.stdout, /atlasctl down\s+Stop only the managed MacBook Node/);
  assert.match(result.stdout, /atlasctl dev up/);
  assert.match(result.stdout, /atlasctl vps status/);
});

test("default commands refuse legacy local-only flags without changing services", () => {
  for (const argv of [["up", "--ask"], ["down", "--all"]]) {
    const result = spawnSync(process.execPath, ["scripts/atlas-control.mjs", ...argv], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /under '.\/atlasctl dev'/);
  }
});

test("VPS command rejects unexpected arguments without SSH invocation", () => {
  for (const argv of [["vps", "delete"], ["vps", "logs", "arbitrary"], ["vps", "status", "server"]]) {
    const result = spawnSync(process.execPath, ["scripts/atlas-control.mjs", ...argv], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Usage: .\/atlasctl vps/);
  }
});
