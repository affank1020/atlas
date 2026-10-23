#!/usr/bin/env node
// CI-only adapter for the existing Atlas test suites. Executes build, Node
// tests, Vitest and macOS UI checks in the same order as "npm test", once.
// Adds reporters; does not modify runtime code or install dependencies.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeJunit, scopeLcov } from "./benchmark-reporting.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, ".benchmark");
await mkdir(out, { recursive: true });
const paths = {
  nodeJunit: join(out, "node-junit.xml"),
  webJunit: join(out, "web-junit.xml"),
  rawLcov: join(out, "raw-node-lcov.info"),
  junit: join(out, "junit.xml"),
  lcov: join(out, "lcov.info")
};
for (const path of Object.values(paths)) await rm(path, { force: true });

function execute(name, cmd, args) {
  console.log("\n=== Benchmark: " + name + " ===");
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  return result.status === 0;
}

async function optionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

let success = false;
try {
  if (execute("Build", "npm", ["run", "build"])) {
    const tests = (await readdir(join(root, "test")))
      .filter(name => name.endsWith(".test.ts"))
      .sort().map(name => join("test", name));
    if (!tests.length) throw new Error("No Atlas Node tests were discovered");
    const nodePassed = execute("Node integration tests with JUnit/LCOV", process.execPath, [
      "--import", "tsx", "--experimental-test-coverage", "--test",
      "--test-reporter=spec", "--test-reporter-destination=stdout",
      "--test-reporter=junit", "--test-reporter-destination=" + paths.nodeJunit,
      "--test-reporter=lcov", "--test-reporter-destination=" + paths.rawLcov,
      ...tests
    ]);
    // Retain partial reports even if tests fail. Never convert failing tests
    // into a successful CI run just because reporting succeeded.
    if (nodePassed) {
      const webPassed = execute("Vitest with JUnit", "npm", [
        "run", "test", "-w", "@atlas/web", "--",
        "--reporter=default", "--reporter=junit",
        "--outputFile.junit=" + paths.webJunit
      ]);
      if (webPassed) {
        success = execute("Native UI checks", "npm", ["run", "test:mac-ui"]);
      }
    }
  }
} finally {
  const nodeXml = await optionalFile(paths.nodeJunit);
  const webXml = await optionalFile(paths.webJunit);
  if (nodeXml || webXml) {
    await writeFile(paths.junit, mergeJunit(nodeXml, webXml));
  }
  const raw = await optionalFile(paths.rawLcov);
  if (raw) {
    await writeFile(paths.lcov, scopeLcov(raw));
  }
}
if (!success) process.exitCode = 1;
