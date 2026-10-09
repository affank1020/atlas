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

test("Atlas Control help mentions the hosted mode", () => {
  const result = spawnSync(process.execPath, ["scripts/atlas-control.mjs", "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up --hosted/);
  assert.match(result.stdout, /down --hosted/);
});
