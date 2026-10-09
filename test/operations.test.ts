import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repository = resolve(".");
const controlScript = join(repository, "scripts/atlas-control.mjs");

function executable(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o700);
}

function fixture(target: "hosted" | "local" = "hosted") {
  const root = mkdtempSync(join(tmpdir(), "atlas-control-test-"));
  const fakeRepository = join(root, "repo");
  const nodeDirectory = join(fakeRepository, "apps/node");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const commandLog = join(root, "commands.log");
  const credential = "test-node-credential-that-must-not-appear-in-plist";
  mkdirSync(join(nodeDirectory, "dist/platforms/desktop"), { recursive: true });
  mkdirSync(join(nodeDirectory, "src/platforms/desktop"), { recursive: true });
  mkdirSync(join(fakeRepository, "apps/server"), { recursive: true });
  mkdirSync(join(fakeRepository, "infra"), { recursive: true });
  mkdirSync(join(home, ".config/tunnel-client"), { recursive: true });
  writeFileSync(join(nodeDirectory, ".env.node"), [
    "ATLAS_NODE_ID=00000000-0000-4000-8000-000000000001",
    `ATLAS_NODE_CREDENTIAL=${credential}`,
    `ATLAS_SERVER_URL=${target === "hosted" ? "wss://atlas.example/node/connect" : "ws://127.0.0.1:3000/node/connect"}`,
    `ATLAS_WORKSPACE_ROOTS=${join(root, "workspace")}`,
  ].join("\n"));
  writeFileSync(join(nodeDirectory, "dist/platforms/desktop/main.js"), "setInterval(() => {}, 1000);\n");
  writeFileSync(join(nodeDirectory, "src/platforms/desktop/main.ts"), "setInterval(() => {}, 1000);\n");
  writeFileSync(join(fakeRepository, "apps/server/.env"), "DATABASE_URL=postgresql://example\n");
  writeFileSync(join(fakeRepository, "infra/docker-compose.yml"), "services: {}\n");
  writeFileSync(join(home, ".config/tunnel-client/atlas-local.yaml"), "test: true\n");

  executable(join(bin, "npm"), [
    "#!/bin/bash",
    'printf "npm %s\\n" "$*" >> "$ATLAS_CONTROL_TEST_LOG"',
    'if [[ "$*" == "run build:node" ]]; then exit 0; fi',
    "sleep 60",
  ].join("\n"));
  executable(join(bin, "osascript"), [
    "#!/bin/bash",
    'last=""',
    'for argument in "$@"; do last="$argument"; done',
    'runner="${last#* }"',
    'runner="${runner#\\\'}"',
    'runner="${runner%\\\'}"',
    'nohup /bin/bash "$runner" >/dev/null 2>&1 &',
  ].join("\n"));
  executable(join(bin, "launchctl"), [
    "#!/bin/bash",
    'state="$ATLAS_CONTROL_TEST_ROOT/launchctl.state"',
    'printf "launchctl %s\\n" "$*" >> "$ATLAS_CONTROL_TEST_LOG"',
    'case "$1" in',
    '  print) test -f "$state" || exit 113; cat "$state" ;;',
    '  bootstrap|kickstart) printf "state = running\\npid = 4242\\n" > "$state" ;;',
    '  kill) printf "state = waiting\\nlast exit code = 0\\n" > "$state" ;;',
    '  bootout) rm -f "$state" ;;',
    "esac",
  ].join("\n"));
  executable(join(bin, "docker"), [
    "#!/bin/bash",
    'printf "docker %s\\n" "$*" >> "$ATLAS_CONTROL_TEST_LOG"',
    'if [[ "$*" == *" ps "* ]]; then printf "postgres\\n"; fi',
  ].join("\n"));
  executable(join(bin, "ssh"), [
    "#!/bin/bash",
    'printf "ssh %s\\n" "$*" >> "$ATLAS_CONTROL_TEST_LOG"',
    'exit "${ATLAS_CONTROL_TEST_SSH_STATUS:-0}"',
  ].join("\n"));

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ATLAS_CONTROL_TEST_ROOT: root,
    ATLAS_CONTROL_TEST_PLATFORM: "darwin",
    ATLAS_CONTROL_TEST_LOG: commandLog,
    ATLAS_CONTROL_TEST_TRUST_PIDS: "1",
    CONTROL_PLANE_API_KEY: "test-only",
  };
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [controlScript, ...args], {
    cwd: repository, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15_000,
  });
  return { root, nodeDirectory, home, commandLog, credential, env, run };
}

test("Atlas Control CLI and VPS diagnostics scripts parse", () => {
  const cli = spawnSync(process.execPath, ["--check", "scripts/atlas-control.mjs"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const vps = spawnSync("bash", ["-n", "scripts/atlas-vps.sh"], { encoding: "utf8" });
  assert.equal(vps.status, 0, vps.stderr);
});

test("help exposes hosted, local development, launchd and VPS modes", () => {
  const result = spawnSync(process.execPath, [controlScript, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /atlasctl up\s+Start only the MacBook Node/);
  assert.match(result.stdout, /atlasctl dev up/);
  assert.match(result.stdout, /atlasctl launchd install/);
  assert.match(result.stdout, /atlasctl vps status/);
  assert.match(result.stdout, /compiled Node without a file watcher/);
});

test("status reports stopped PostgreSQL without treating absent Docker as a missing service", t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const result = item.run(["status"], { ATLAS_CONTROL_TEST_MISSING_COMMANDS: "docker" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STOPPED\s+PostgreSQL\s+Docker unavailable/);
  assert.doesNotMatch(result.stdout, /MISSING\s+PostgreSQL/);
});

test("hosted mode uses the compiled Node and dev down leaves it running", t => {
  const item = fixture("hosted");
  t.after(() => {
    item.run(["down"]);
    rmSync(item.root, { recursive: true, force: true });
  });
  const started = item.run(["up"]);
  assert.equal(started.status, 0, started.stderr);
  const runner = readFileSync(join(item.root, "runtime/node-hosted-runner.zsh"), "utf8");
  assert.match(runner, /npm' 'run' 'start:node/);
  assert.doesNotMatch(runner, /dev:node|tsx watch/);
  assert.ok(existsSync(join(item.root, "runtime/node-hosted.pid")));

  const devDown = item.run(["dev", "down"]);
  assert.equal(devDown.status, 0, devDown.stderr);
  assert.match(devDown.stdout, /Hosted Atlas Node is untouched/);
  assert.ok(existsSync(join(item.root, "runtime/node-hosted.pid")));

  const stopped = item.run(["down"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(existsSync(join(item.root, "runtime/node-hosted.pid")), false);
});

test("local Node keeps tsx watch and dev down --all alone manages PostgreSQL", t => {
  const item = fixture("local");
  t.after(() => {
    item.run(["dev", "down", "--all"]);
    rmSync(item.root, { recursive: true, force: true });
  });
  const started = item.run(["start", "node"]);
  assert.equal(started.status, 0, started.stderr);
  const runner = readFileSync(join(item.root, "runtime/node-dev-runner.zsh"), "utf8");
  assert.match(runner, /npm' 'run' 'dev:node/);

  writeFileSync(item.commandLog, "");
  assert.equal(item.run(["dev", "down"]).status, 0);
  assert.doesNotMatch(readFileSync(item.commandLog, "utf8"), /docker .* stop postgres/);

  writeFileSync(item.commandLog, "");
  assert.equal(item.run(["dev", "down", "--all"]).status, 0);
  assert.match(readFileSync(item.commandLog, "utf8"), /docker .* stop postgres/);
});

test("unmanaged Node processes are reported but never claimed or stopped", async t => {
  const item = fixture("hosted");
  const entrypoint = join(item.nodeDirectory, "dist/platforms/desktop/main.js");
  const external = spawn(process.execPath, [entrypoint], { stdio: "ignore" });
  t.after(() => {
    external.kill("SIGTERM");
    rmSync(item.root, { recursive: true, force: true });
  });
  await new Promise(resolveWait => setTimeout(resolveWait, 100));

  const injected = { ATLAS_CONTROL_TEST_EXTERNAL_NODE_PIDS: String(external.pid) };
  const status = item.run(["status"], injected);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`RUNNING\\*\\s+Unmanaged Node\\s+pid ${external.pid}`));
  assert.match(status.stdout, /connection target unknown/);

  const stopped = item.run(["down"], injected);
  assert.equal(stopped.status, 1);
  assert.doesNotThrow(() => process.kill(external.pid!, 0));
});

test("launchd install creates a credential-free user LaunchAgent and preserves configuration on uninstall", t => {
  const item = fixture("hosted");
  t.after(() => rmSync(item.root, { recursive: true, force: true }));

  const installed = item.run(["launchd", "install"]);
  assert.equal(installed.status, 0, installed.stderr);
  const plist = join(item.home, "Library/LaunchAgents/com.affank1020.atlas.node.plist");
  const contents = readFileSync(plist, "utf8");
  assert.match(contents, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(contents, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.ok(contents.includes(process.execPath));
  assert.match(contents, /dist\/platforms\/desktop\/main\.js/);
  assert.match(contents, /ATLAS_NODE_ENV_FILE/);
  assert.doesNotMatch(contents, /tsx|ATLAS_NODE_CREDENTIAL|test-node-credential/);
  if (process.platform === "darwin") {
    const linted = spawnSync("plutil", ["-lint", plist], { encoding: "utf8" });
    assert.equal(linted.status, 0, linted.stderr);
  }

  const status = item.run(["launchd", "status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /running · pid 4242/);

  assert.equal(item.run(["down"]).status, 0);
  assert.equal(item.run(["up"]).status, 0);
  assert.equal(item.run(["restart"]).status, 0);

  writeFileSync(item.commandLog, "");
  const devDown = item.run(["dev", "down"]);
  assert.equal(devDown.status, 0, devDown.stderr);
  assert.doesNotMatch(readFileSync(item.commandLog, "utf8"), /launchctl (?:kill|bootout)/);

  const uninstalled = item.run(["launchd", "uninstall"]);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(existsSync(plist), false);
  assert.equal(existsSync(join(item.nodeDirectory, ".env.node")), true);
});

test("invalid local flags and commands return usage errors, while VPS exit status is preserved", t => {
  for (const argv of [["up", "--ask"], ["down", "--all"]]) {
    const result = spawnSync(process.execPath, [controlScript, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
  }
  for (const argv of [["vps", "delete"], ["vps", "logs", "arbitrary"], ["launchd", "invalid"]]) {
    const result = spawnSync(process.execPath, [controlScript, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
  }
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const vps = item.run(["vps", "status"], { ATLAS_CONTROL_TEST_SSH_STATUS: "7" });
  assert.equal(vps.status, 7);
  assert.match(readFileSync(item.commandLog, "utf8"), /ssh -o BatchMode=yes ovh cd ~\/atlas-deploy && \.\/atlas-vps\.sh status/);
});
