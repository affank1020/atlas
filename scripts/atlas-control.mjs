#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const testRoot = process.env.ATLAS_CONTROL_TEST_ROOT ? resolve(process.env.ATLAS_CONTROL_TEST_ROOT) : undefined;
const atlasDir = testRoot ? join(testRoot, "repo") : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const controlHome = testRoot ? join(testRoot, "home") : homedir();
const controlPlatform = testRoot ? (process.env.ATLAS_CONTROL_TEST_PLATFORM || process.platform) : process.platform;
const serverDir = resolve(atlasDir, "apps/server");
const nodeDir = resolve(atlasDir, "apps/node");
const uiDir = resolve(atlasDir, "apps/web");
const composeArgs = ["compose", "-f", join(atlasDir, "infra/docker-compose.yml")];
const runtimeDir = testRoot ? join(testRoot, "runtime") : join(tmpdir(), `atlas-control-${process.getuid?.() ?? "user"}`);
const tunnelProfile = join(controlHome, ".config/tunnel-client/atlas-local.yaml");
const keychainService = "atlas-tunnel-client";
const keychainAccount = userInfo().username;
const nodeEnvFile = join(nodeDir, ".env.node");
const compiledNodeEntrypoint = join(nodeDir, "dist/platforms/desktop/main.js");
const sourceNodeEntrypoint = join(nodeDir, "src/platforms/desktop/main.ts");
const launchdLabel = "com.affank1020.atlas.node";
const launchdDirectory = join(controlHome, "Library/LaunchAgents");
const launchdPlist = join(launchdDirectory, `${launchdLabel}.plist`);
const launchdLogDirectory = join(controlHome, "Library/Logs/Atlas");
const launchdStdout = join(launchdLogDirectory, "node.log");
const launchdStderr = join(launchdLogDirectory, "node-error.log");
const launchdDomain = `gui/${process.getuid?.() ?? userInfo().uid}`;
const launchdTarget = `${launchdDomain}/${launchdLabel}`;

const colors = process.stdout.isTTY
  ? { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" }
  : { green: "", yellow: "", red: "", dim: "", bold: "", reset: "" };

const serviceAliases = {
  atlas: "server",
  observatory: "web",
};

const services = {
  postgres: { label: "PostgreSQL", type: "docker", port: 5432, cwd: atlasDir },
  server: { label: "Atlas Server", command: "npm", args: ["run", "dev:server"], port: 3000, cwd: atlasDir, requires: join(serverDir, ".env"), url: "http://127.0.0.1:3000/health" },
  node: { label: "Local Dev Node", command: "npm", args: ["run", "dev:node"], cwd: atlasDir, requires: nodeEnvFile },
  web: { label: "Atlas Web", command: "npm", args: ["run", "dev:web"], port: 5173, cwd: atlasDir, url: "http://127.0.0.1:5173/" },
  tunnel: { label: "MCP tunnel", command: "tunnel-client", args: ["run", "--profile", "atlas-local"], port: 8080, cwd: atlasDir, url: "http://127.0.0.1:8080/readyz", requires: tunnelProfile },
  ollama: { label: "Ollama", command: "ollama", args: ["serve"], port: 11434, cwd: atlasDir, url: "http://127.0.0.1:11434/api/tags", optional: true },
};
const hostedNodeService = { label: "Hosted Atlas Node", command: "npm", args: ["run", "start:node"], cwd: atlasDir, requires: nodeEnvFile };

function paths(name) {
  return { pid: join(runtimeDir, `${name}.pid`), log: join(runtimeDir, `${name}.log`), runner: join(runtimeDir, `${name}-runner.zsh`) };
}

function hostedWebUrl() {
  if (existsSync(nodeEnvFile)) {
    // Read the hostname only; never print the Node identity or credential.
    const match = readFileSync(nodeEnvFile, "utf8")
      .match(/^ATLAS_SERVER_URL\s*=\s*["']?([^"'\r\n# ]+)/m);
    if (match) {
      try {
        const url = new URL(match[1]);
        if (url.protocol === "wss:" && url.pathname === "/node/connect") {
          url.protocol = "https:";
          url.pathname = "/";
          return url.toString();
        }
      } catch { /* Ignore invalid local configuration; startup reports its error. */ }
    }
  }
  return "https://affan-atlas.duckdns.org/";
}

function commandExists(command) {
  const forcedMissing = testRoot ? (process.env.ATLAS_CONTROL_TEST_MISSING_COMMANDS || "").split(",") : [];
  if (forcedMissing.includes(command)) return false;
  return spawnSync("/bin/sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command]).status === 0;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function keychainHasTunnelKey() {
  const keychain = spawnSync("security", ["find-generic-password", "-s", keychainService, "-a", keychainAccount], { stdio: "ignore" }).status === 0;
  return keychain || Boolean(process.env.CONTROL_PLANE_API_KEY || process.env.OPENAI_API_KEY);
}

async function configureTunnelKey() {
  if (process.platform !== "darwin" || !commandExists("security")) {
    console.error("Automatic secure storage currently requires macOS Keychain.");
    process.exitCode = 1;
    return;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const key = (await prompt.question("OpenAI control-plane API key (input is visible): ")).trim();
  prompt.close();
  if (!key) {
    console.error(`${colors.red}✗${colors.reset} No key entered; nothing was changed.`);
    process.exitCode = 1;
    return;
  }
  const result = spawnSync("security", ["add-generic-password", "-U", "-a", keychainAccount, "-s", keychainService, "-l", "Atlas MCP tunnel API key", "-w", key], { stdio: ["ignore", "ignore", "inherit"] });
  if (result.status === 0) console.log(`${colors.green}✓${colors.reset} Tunnel API key saved in macOS Keychain.`);
  else { console.error(`${colors.red}✗${colors.reset} The key was not saved.`); process.exitCode = 1; }
}

function terminalRunner(name, service, pid, log) {
  const runner = paths(name).runner;
  const credential = name === "tunnel"
    ? `if security find-generic-password -s ${shellQuote(keychainService)} -a ${shellQuote(keychainAccount)} >/dev/null 2>&1; then
  export CONTROL_PLANE_API_KEY=\"$(security find-generic-password -w -s ${shellQuote(keychainService)} -a ${shellQuote(keychainAccount)})\"
elif [[ -z \"\${CONTROL_PLANE_API_KEY:-}\" && -z \"\${OPENAI_API_KEY:-}\" ]]; then
  echo "Atlas Control: no tunnel API key is configured."
  exit 1
fi
`
    : "";
  const command = [service.command, ...service.args].map(shellQuote).join(" ");
  writeFileSync(runner, `#!/bin/zsh
set -o pipefail
echo $$ > ${shellQuote(pid)}
cd ${shellQuote(service.cwd)}
${credential}echo "Atlas Control: ${service.label}"
echo "Working directory: ${service.cwd}"
echo
${command} 2>&1 | tee -a ${shellQuote(log)}
result=\${pipestatus[1]}
rm -f ${shellQuote(pid)}
echo
echo "${service.label} exited with status $result. You can close this window."
exit 0
`);
  spawnSync("chmod", ["700", runner]);
  return runner;
}

function openTerminalRunner(runner) {
  if (testRoot) {
    const child = spawn("/bin/bash", [runner], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    return { status: 0, stderr: "" };
  }
  const command = `/bin/zsh ${shellQuote(runner)}`;
  const script = 'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run';
  return spawnSync("osascript", ["-e", script, command], { encoding: "utf8" });
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function processCwd(pid) {
  if (!commandExists("lsof")) return undefined;
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split("\n").find(line => line.startsWith("n"))?.slice(1) : undefined;
}

function childPids(pid) {
  const descendants = [];
  const visit = (parent) => {
    const result = spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8" });
    for (const value of result.stdout?.trim().split(/\s+/).filter(Boolean) ?? []) {
      const child = Number(value);
      if (Number.isInteger(child)) { visit(child); descendants.push(child); }
    }
  };
  visit(pid);
  return descendants;
}

function readPid(name) {
  const file = paths(name).pid;
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 1) { rmSync(file, { force: true }); return undefined; }
  try { process.kill(pid, 0); }
  catch { rmSync(file, { force: true }); return undefined; }
  if (testRoot && process.env.ATLAS_CONTROL_TEST_TRUST_PIDS === "1") return pid;
  // A numeric PID can be reused after a managed process exits. Only trust the
  // record while it still points at Atlas Control's exact runner script.
  if (!processCommand(pid).includes(paths(name).runner)) {
    rmSync(file, { force: true });
    return undefined;
  }
  return pid;
}

function managedNodePids() {
  const roots = ["node-hosted", "node-dev", "node"].map(readPid).filter(Boolean);
  return new Set(roots.flatMap(pid => [pid, ...childPids(pid)]));
}

function externalNodeProcesses() {
  const ignored = managedNodePids();
  const launchd = launchdState();
  if (launchd.pid) ignored.add(launchd.pid);
  if (testRoot && process.env.ATLAS_CONTROL_TEST_EXTERNAL_NODE_PIDS) {
    return process.env.ATLAS_CONTROL_TEST_EXTERNAL_NODE_PIDS.split(",").map(Number)
      .filter(pid => Number.isInteger(pid) && pid > 1 && !ignored.has(pid))
      .map(pid => ({ pid, command: "test-injected unmanaged Atlas Node" }));
  }
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return [];
    const pid = Number(match[1]);
    const command = match[2];
    if (ignored.has(pid) || pid === process.pid) return [];
    const exactEntrypoint = command.includes(compiledNodeEntrypoint) || command.includes(sourceNodeEntrypoint);
    const relativeCommand = command.includes("dist/platforms/desktop/main.js") || command.includes("src/platforms/desktop/main.ts");
    const relativeEntrypoint = relativeCommand && processCwd(pid) === nodeDir;
    return exactEntrypoint || relativeEntrypoint ? [{ pid, command }] : [];
  });
}

function portOpen(port, timeout = 350) {
  if (testRoot) {
    const open = (process.env.ATLAS_CONTROL_TEST_OPEN_PORTS || "").split(",").map(Number);
    return Promise.resolve(open.includes(port));
  }
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolveResult(value); };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function nodeTarget() {
  if (!existsSync(nodeEnvFile)) return undefined;
  const value = readFileSync(nodeEnvFile, "utf8").match(/^ATLAS_SERVER_URL\s*=\s*["']?([^"'\r\n# ]+)/m)?.[1];
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "wss:" ? "hosted" : "local";
  } catch { return "invalid"; }
}

function hostedConfigurationError() {
  if (!existsSync(nodeEnvFile)) return "Missing apps/node/.env.node; keep the existing Node identity and credential.";
  const value = readFileSync(nodeEnvFile, "utf8").match(/^ATLAS_SERVER_URL\s*=\s*["']?([^"'\r\n# ]+)/m)?.[1];
  if (!value || !/^wss:\/\/[^/]+\/node\/connect\/?$/.test(value))
    return "Hosted mode requires ATLAS_SERVER_URL=wss://<hostname>/node/connect in apps/node/.env.node.";
}

function launchdState() {
  const installed = existsSync(launchdPlist);
  if (controlPlatform !== "darwin" || !commandExists("launchctl"))
    return { supported: false, installed, loaded: false };
  const result = spawnSync("launchctl", ["print", launchdTarget], { encoding: "utf8" });
  if (result.status !== 0) return { supported: true, installed, loaded: false };
  const state = result.stdout.match(/^\s*state\s*=\s*(.+)$/m)?.[1]?.trim();
  const pidValue = Number(result.stdout.match(/^\s*pid\s*=\s*(\d+)$/m)?.[1]);
  const lastExitValue = Number(result.stdout.match(/^\s*last exit code\s*=\s*(-?\d+)$/m)?.[1]);
  return {
    supported: true, installed, loaded: true, state,
    pid: Number.isInteger(pidValue) && pidValue > 1 ? pidValue : undefined,
    lastExit: Number.isInteger(lastExitValue) ? lastExitValue : undefined,
  };
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function launchdPath() {
  const values = [dirname(process.execPath), ...(process.env.PATH || "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(values.filter(value => value.startsWith("/")))].join(":");
}

function launchdConfiguration() {
  const strings = [process.execPath, compiledNodeEntrypoint].map(value => `      <string>${xmlEscape(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${launchdLabel}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(nodeDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ATLAS_NODE_ENV_FILE</key>
    <string>${xmlEscape(nodeEnvFile)}</string>
    <key>PATH</key>
    <string>${xmlEscape(launchdPath())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(launchdStdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(launchdStderr)}</string>
</dict>
</plist>
`;
}

function buildHostedNode() {
  console.log("Building the compiled Atlas Node…");
  const result = spawnSync("npm", ["run", "build:node"], { cwd: atlasDir, stdio: "inherit" });
  if (result.status !== 0 || !existsSync(compiledNodeEntrypoint)) {
    console.error(`${colors.red}✗${colors.reset} Atlas Node build failed or did not create ${compiledNodeEntrypoint}.`);
    return false;
  }
  return true;
}

async function waitForLaunchdPid() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = launchdState();
    if (current.pid) return current;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  return launchdState();
}

async function installLaunchd() {
  if (controlPlatform !== "darwin" || !commandExists("launchctl")) {
    console.error("Atlas Node launchd integration requires macOS and launchctl.");
    return false;
  }
  const configError = hostedConfigurationError();
  if (configError) {
    console.error(configError);
    console.error("Do not change ATLAS_NODE_ID or ATLAS_NODE_CREDENTIAL.");
    return false;
  }
  if (readPid("node-dev") || (nodeTarget() === "local" && readPid("node"))) {
    console.error("A managed local-development Node is running. Stop it with './atlasctl dev down' before installing launchd.");
    return false;
  }
  const external = externalNodeProcesses();
  if (external.length) {
    console.error(`An unmanaged Atlas Node process is already running (pid ${external[0].pid}); refusing to create a duplicate.`);
    return false;
  }
  if (!buildHostedNode()) return false;

  const existing = launchdState();
  if (existing.loaded) {
    const stopped = spawnSync("launchctl", ["bootout", launchdTarget], { encoding: "utf8" });
    if (stopped.status !== 0) {
      console.error(`Could not unload the existing LaunchAgent: ${stopped.stderr.trim()}`);
      return false;
    }
  }
  if (!await stopService("node-hosted", hostedNodeService)) return false;
  if (nodeTarget() === "hosted" && !await stopService("node", hostedNodeService)) return false;

  mkdirSync(launchdDirectory, { recursive: true });
  mkdirSync(launchdLogDirectory, { recursive: true });
  const temporary = `${launchdPlist}.next`;
  writeFileSync(temporary, launchdConfiguration(), { mode: 0o600 });
  renameSync(temporary, launchdPlist);
  chmodSync(launchdPlist, 0o600);
  const loaded = spawnSync("launchctl", ["bootstrap", launchdDomain, launchdPlist], { encoding: "utf8" });
  if (loaded.status !== 0) {
    console.error(`Could not load the Atlas Node LaunchAgent: ${loaded.stderr.trim()}`);
    return false;
  }
  const current = await waitForLaunchdPid();
  if (!current.pid) {
    console.error(`The LaunchAgent loaded but Atlas Node did not stay running. Inspect ${launchdStderr}.`);
    return false;
  }
  console.log(`${colors.green}✓${colors.reset} Atlas Node LaunchAgent installed and running (pid ${current.pid}).`);
  console.log(`Logs: ${launchdStdout} and ${launchdStderr}`);
  return true;
}

async function uninstallLaunchd() {
  if (controlPlatform !== "darwin" || !commandExists("launchctl")) {
    console.error("Atlas Node launchd integration requires macOS and launchctl.");
    return false;
  }
  const current = launchdState();
  if (current.loaded) {
    const stopped = spawnSync("launchctl", ["bootout", launchdTarget], { encoding: "utf8" });
    if (stopped.status !== 0) {
      console.error(`Could not unload the Atlas Node LaunchAgent: ${stopped.stderr.trim()}`);
      return false;
    }
  }
  rmSync(launchdPlist, { force: true });
  console.log("Atlas Node LaunchAgent uninstalled. Node credentials, Workspace configuration and logs were preserved.");
  return true;
}

function printLaunchdStatus() {
  if (controlPlatform !== "darwin") {
    console.error("Atlas Node launchd integration is available only on macOS.");
    return false;
  }
  const current = launchdState();
  console.log(`LaunchAgent: ${launchdLabel}`);
  console.log(`Plist:       ${launchdPlist}${current.installed ? "" : " (not installed)"}`);
  console.log(`State:       ${current.loaded ? (current.pid ? `running · pid ${current.pid}` : `loaded · ${current.state || "not running"}`) : "not loaded"}`);
  if (current.lastExit !== undefined) console.log(`Last exit:   ${current.lastExit}`);
  console.log(`Logs:        ${launchdStdout}\n             ${launchdStderr}`);
  return current.loaded;
}

async function serviceState(name, service = services[name]) {
  if (service.type === "docker") {
    if (await portOpen(service.port)) return { state: "external", detail: `already listening on :${service.port}` };
    if (!commandExists("docker")) return { state: "stopped", detail: "Docker unavailable (only needed for local dev)" };
    const result = spawnSync("docker", [...composeArgs, "ps", "--status", "running", "--services"], { cwd: atlasDir, encoding: "utf8" });
    const running = result.status === 0 && result.stdout.split(/\s+/).includes("postgres");
    return running ? { state: "running", detail: "Docker Compose" } : { state: "stopped", detail: result.status === 0 ? undefined : "Docker Compose unavailable (only needed for local dev)" };
  }
  const pid = readPid(name);
  if (!service.port) {
    if (pid) return { state: "running", detail: `managed · pid ${pid}${name === "node" ? " · configured " + (nodeTarget() || "unknown") : ""}` };
    if (service.requires && !existsSync(service.requires)) return { state: "missing", detail: `missing ${service.requires}` };
    return { state: "stopped" };
  }
  const listening = await portOpen(service.port);
  if (pid && listening) return { state: "running", detail: `managed · pid ${pid} · :${service.port}` };
  if (pid) return { state: "starting", detail: `managed · pid ${pid}` };
  if (listening) return { state: "external", detail: `already listening on :${service.port}` };
  if (!commandExists(service.command)) return { state: "missing", detail: `${service.command} command not found` };
  if (service.requires && !existsSync(service.requires)) return { state: "missing", detail: `missing ${service.requires}` };
  return { state: "stopped" };
}

async function hostedNodeState() {
  const launchd = launchdState();
  if (launchd.loaded) {
    if (launchd.pid) return { state: "running", detail: `launchd · pid ${launchd.pid} · configured ${nodeTarget() || "unknown"}` };
    return { state: "stopped", detail: `launchd loaded · ${launchd.state || "not running"}${launchd.lastExit === undefined ? "" : ` · last exit ${launchd.lastExit}`}` };
  }
  if (launchd.installed) return { state: "stopped", detail: "launchd installed but not loaded" };
  const managed = readPid("node-hosted");
  if (managed) return { state: "running", detail: `terminal-managed · pid ${managed} · compiled` };
  const legacy = nodeTarget() === "hosted" ? readPid("node") : undefined;
  if (legacy) return { state: "running", detail: `legacy terminal-managed · pid ${legacy} · watcher` };
  const configError = hostedConfigurationError();
  if (configError && !existsSync(nodeEnvFile)) return { state: "missing", detail: "missing apps/node/.env.node" };
  return { state: "stopped", detail: `configured ${nodeTarget() || "unknown"}` };
}

async function localNodeState() {
  const managed = readPid("node-dev");
  if (managed) return { state: "running", detail: `terminal-managed · pid ${managed} · tsx watch` };
  const legacy = nodeTarget() === "local" ? readPid("node") : undefined;
  if (legacy) return { state: "running", detail: `legacy terminal-managed · pid ${legacy} · tsx watch` };
  return { state: "stopped" };
}

function stateText(state) {
  if (state === "running") return `${colors.green}RUNNING ${colors.reset}`;
  if (state === "external") return `${colors.green}RUNNING*${colors.reset}`;
  if (state === "starting") return `${colors.yellow}STARTING${colors.reset}`;
  if (state === "missing") return `${colors.red}MISSING ${colors.reset}`;
  return `${colors.dim}STOPPED ${colors.reset}`;
}

async function printStatus() {
  console.log(`${colors.bold}Atlas Control${colors.reset}\n`);
  for (const name of ["postgres", "server"]) {
    const service = services[name];
    const current = await serviceState(name);
    const suffix = current.detail ? `  ${colors.dim}${current.detail}${colors.reset}` : "";
    console.log(`${stateText(current.state)}  ${service.label.padEnd(14)}${suffix}`);
  }
  for (const [label, current] of [["Hosted Atlas Node", await hostedNodeState()], ["Local Dev Node", await localNodeState()]]) {
    const suffix = current.detail ? `  ${colors.dim}${current.detail}${colors.reset}` : "";
    console.log(`${stateText(current.state)}  ${label.padEnd(14)}${suffix}`);
  }
  const externalNodes = externalNodeProcesses();
  if (externalNodes.length) {
    const current = { state: "external", detail: `pid ${externalNodes[0].pid} · connection target unknown · left untouched` };
    console.log(`${stateText(current.state)}  ${"Unmanaged Node".padEnd(14)}  ${colors.dim}${current.detail}${colors.reset}`);
  }
  for (const name of ["web", "tunnel", "ollama"]) {
    const service = services[name];
    const current = await serviceState(name);
    const suffix = current.detail ? `  ${colors.dim}${current.detail}${colors.reset}` : "";
    console.log(`${stateText(current.state)}  ${service.label.padEnd(14)}${suffix}`);
  }
  console.log(`\n${colors.dim}* Running outside Atlas Control; it will be left alone.${colors.reset}`);
  console.log(`Hosted Web: ${hostedWebUrl()}`);
  console.log(`Local dev:  http://127.0.0.1:5173`);
  console.log(`Legacy MCP tunnel UI: http://127.0.0.1:8080/ui`);
}

async function waitForPort(port, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

async function startService(name, service = services[name]) {
  const current = await serviceState(name, service);
  if (["running", "external"].includes(current.state)) {
    console.log(`${colors.green}✓${colors.reset} ${service.label} is already running${current.state === "external" ? " (outside Atlas Control)" : ""}.`);
    return true;
  }
  if (current.state === "missing") {
    console.error(`${colors.red}✗${colors.reset} ${service.label}: ${current.detail}`);
    return false;
  }
  if (service.type === "docker") {
    console.log(`Starting ${service.label}…`);
    const result = spawnSync("docker", [...composeArgs, "up", "-d", "postgres"], { cwd: atlasDir, stdio: "inherit" });
    if (result.status !== 0) return false;
    return waitForPort(service.port, 30000);
  }
  if (name === "tunnel" && !keychainHasTunnelKey()) {
    console.error(`${colors.red}✗${colors.reset} MCP tunnel API key is not configured.`);
    console.error("  Run ./atlasctl configure tunnel-key once, then retry.");
    return false;
  }
  mkdirSync(runtimeDir, { recursive: true });
  const { pid, log } = paths(name);
  const runner = terminalRunner(name, service, pid, log);
  console.log(`Starting ${service.label} in a new Terminal window…`);
  const opened = openTerminalRunner(runner);
  if (opened.status !== 0) {
    console.error(`${colors.red}✗${colors.reset} Could not open Terminal: ${opened.stderr.trim()}`);
    return false;
  }
  const ready = service.port ? await waitForPort(service.port) : await (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (readPid(name)) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    return false;
  })();
  if (!ready) {
    console.error(`${colors.red}✗${colors.reset} ${service.label} did not start. Run ./atlasctl logs ${name}.`);
    return false;
  }
  console.log(`${colors.green}✓${colors.reset} ${service.label} is ready.`);
  return true;
}

async function stopService(name, service = services[name]) {
  if (service.type === "docker") {
    const current = await serviceState(name, service);
    if (current.state === "external") {
      console.log(`${service.label} is running outside Atlas Control; leaving it alone.`);
      return true;
    }
    if (current.state === "stopped") {
      console.log(`${service.label} is already stopped.`);
      return true;
    }
    if (current.state === "missing") {
      console.log(`${service.label} cannot be managed here (${current.detail}).`);
      return false;
    }
    console.log(`Stopping ${service.label}…`);
    const result = spawnSync("docker", [...composeArgs, "stop", "postgres"], { cwd: atlasDir, stdio: "inherit" });
    return result.status === 0;
  }
  const { pid: pidFile } = paths(name);
  const pid = readPid(name);
  if (!pid) {
    const current = await serviceState(name, service);
    console.log(current.state === "external"
      ? `${service.label} is running outside Atlas Control; leaving it alone.`
      : `${service.label} is already stopped.`);
    return true;
  }
  const descendants = childPids(pid);
  for (const child of descendants) { try { process.kill(child, "SIGTERM"); } catch {} }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { process.kill(pid, 0); await new Promise((resolveWait) => setTimeout(resolveWait, 100)); }
    catch { break; }
  }
  try { process.kill(pid, 0); process.kill(pid, "SIGTERM"); } catch {}
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { process.kill(pid, 0); await new Promise((resolveWait) => setTimeout(resolveWait, 150)); }
    catch { break; }
  }
  rmSync(pidFile, { force: true });
  console.log(`${colors.green}✓${colors.reset} Stopped ${service.label}.`);
  return true;
}

async function startLaunchdNode() {
  const current = launchdState();
  if (!current.loaded) {
    console.error("The Atlas Node LaunchAgent is installed but not loaded. Run './atlasctl launchd install' to repair it.");
    return false;
  }
  if (current.pid) {
    console.log(`${colors.green}✓${colors.reset} Hosted Atlas Node is already running under launchd (pid ${current.pid}).`);
    return true;
  }
  const started = spawnSync("launchctl", ["kickstart", launchdTarget], { encoding: "utf8" });
  if (started.status !== 0) {
    console.error(`Could not start the Atlas Node LaunchAgent: ${started.stderr.trim()}`);
    return false;
  }
  const ready = await waitForLaunchdPid();
  if (!ready.pid) {
    console.error(`Hosted Atlas Node did not stay running. Inspect ${launchdStderr}.`);
    return false;
  }
  console.log(`${colors.green}✓${colors.reset} Hosted Atlas Node is running under launchd (pid ${ready.pid}).`);
  return true;
}

async function stopLaunchdNode() {
  const current = launchdState();
  if (!current.loaded || !current.pid) {
    console.log("Hosted Atlas Node is already stopped; its LaunchAgent remains installed for the next login.");
    return true;
  }
  const stopped = spawnSync("launchctl", ["kill", "SIGTERM", launchdTarget], { encoding: "utf8" });
  if (stopped.status !== 0) {
    console.error(`Could not stop the Atlas Node LaunchAgent process: ${stopped.stderr.trim()}`);
    return false;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!launchdState().pid) {
      console.log(`${colors.green}✓${colors.reset} Stopped Hosted Atlas Node; launchd remains installed.`);
      return true;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  console.error("Hosted Atlas Node did not stop within five seconds.");
  return false;
}

async function startHostedNode({ build = true } = {}) {
  const configError = hostedConfigurationError();
  if (configError) {
    console.error(configError);
    console.error("Do not change ATLAS_NODE_ID or ATLAS_NODE_CREDENTIAL.");
    return false;
  }
  const launchd = launchdState();
  if (launchd.loaded) return startLaunchdNode();
  if (launchd.installed) {
    console.error("The Atlas Node LaunchAgent plist exists but is not loaded. Run './atlasctl launchd install' or 'uninstall'.");
    return false;
  }
  const current = readPid("node-hosted");
  if (current) {
    console.log(`${colors.green}✓${colors.reset} Hosted Atlas Node is already running (pid ${current}).`);
    return true;
  }
  const legacy = readPid("node");
  const external = externalNodeProcesses();
  if (external.length) {
    console.error(`An unmanaged Atlas Node process is already running (pid ${external[0].pid}); refusing to create a duplicate.`);
    return false;
  }
  if (build && !buildHostedNode()) return false;
  if (legacy) {
    console.log("Replacing the legacy watched hosted Node with the compiled Node…");
    if (!await stopService("node", hostedNodeService)) return false;
  }
  return startService("node-hosted", hostedNodeService);
}

async function stopHostedNode() {
  const launchd = launchdState();
  if (launchd.loaded) return stopLaunchdNode();
  let okay = await stopService("node-hosted", hostedNodeService);
  if (nodeTarget() === "hosted") okay = await stopService("node", hostedNodeService) && okay;
  const external = externalNodeProcesses();
  if (external.length) {
    console.error(`An unmanaged Atlas Node process remains (pid ${external[0].pid}); Atlas Control did not stop it.`);
    return false;
  }
  return okay;
}

async function restartHostedNode() {
  const configError = hostedConfigurationError();
  if (configError) { console.error(configError); return false; }
  if (!buildHostedNode()) return false;
  const launchd = launchdState();
  if (launchd.loaded) {
    const restarted = spawnSync("launchctl", ["kickstart", "-k", launchdTarget], { encoding: "utf8" });
    if (restarted.status !== 0) {
      console.error(`Could not restart the Atlas Node LaunchAgent: ${restarted.stderr.trim()}`);
      return false;
    }
    const ready = await waitForLaunchdPid();
    if (!ready.pid) { console.error(`Hosted Atlas Node did not stay running. Inspect ${launchdStderr}.`); return false; }
    console.log(`${colors.green}✓${colors.reset} Restarted Hosted Atlas Node under launchd (pid ${ready.pid}).`);
    return true;
  }
  if (!await stopHostedNode()) return false;
  return startHostedNode({ build: false });
}

async function startLocalNode() {
  if (nodeTarget() !== "local") {
    console.error("Local dev requires the Node to point at ws://127.0.0.1:3000/node/connect.");
    console.error("The Node is configured for a different Server. Use './atlasctl up' instead.");
    return false;
  }
  if (launchdState().loaded || readPid("node-hosted")) {
    console.error("The hosted Node is running; refusing to start a second local-development Node.");
    return false;
  }
  const external = externalNodeProcesses();
  if (external.length) {
    console.error(`An unmanaged Atlas Node process is already running (pid ${external[0].pid}); refusing to create a duplicate.`);
    return false;
  }
  return startService("node-dev", services.node);
}

async function stopLocalNode() {
  let okay = await stopService("node-dev", services.node);
  if (nodeTarget() === "local") okay = await stopService("node", services.node) && okay;
  return okay;
}

function selectedService(value) {
  const canonical = serviceAliases[value] ?? value;
  if (!services[canonical]) {
    console.error(`Unknown service "${value}". Choose: ${Object.keys(services).join(", ")}`);
    process.exitCode = 2;
    return undefined;
  }
  if (canonical !== value) {
    console.log(`"${value}" is a legacy alias for "${canonical}".`);
  }
  return canonical;
}

function showLogs(name) {
  if (name === "node") {
    const candidates = [paths("node-hosted").log, paths("node-dev").log, paths("node").log, launchdStdout, launchdStderr];
    for (const log of candidates) {
      if (!existsSync(log)) continue;
      console.log(`\n${colors.bold}── Atlas Node · ${log}${colors.reset}`);
      const lines = readFileSync(log, "utf8").trimEnd().split("\n");
      console.log(lines.slice(-40).join("\n"));
    }
    if (!candidates.some(existsSync)) console.log("No Atlas Node log yet.");
    return;
  }
  const names = name ? [selectedService(name)].filter(Boolean) : Object.keys(services).filter((key) => services[key].type !== "docker");
  for (const item of names) {
    const log = paths(item).log;
    console.log(`\n${colors.bold}── ${services[item].label} · ${log}${colors.reset}`);
    if (!existsSync(log)) console.log("No Atlas Control log yet.");
    else {
      const lines = readFileSync(log, "utf8").trimEnd().split("\n");
      console.log(lines.slice(-40).join("\n"));
    }
  }
}

function usage() {
  console.log(`Atlas Control

Usage:
  ./atlasctl up                Start only the MacBook Node for the hosted Server
  ./atlasctl down              Stop only the managed MacBook Node
  ./atlasctl restart           Restart only the managed MacBook Node
  ./atlasctl dev up [--ask]    Start the legacy local development stack + MCP tunnel
  ./atlasctl dev down [--all]  Stop local dev services without stopping a hosted Node
  ./atlasctl dev restart       Restart the local development stack
  ./atlasctl status            Show local service status (Docker only needed for dev)
  ./atlasctl start <service>   Start one service
  ./atlasctl stop <service>    Stop one managed service
  ./atlasctl logs [service]    Show the latest managed logs
  ./atlasctl launchd install   Install/start the hosted Node user LaunchAgent
  ./atlasctl launchd status    Show LaunchAgent state and log paths
  ./atlasctl launchd uninstall Remove it without deleting Node configuration
  ./atlasctl configure tunnel-key
                               Save the tunnel API key in macOS Keychain
  ./atlasctl open              Open hosted Atlas Web
  ./atlasctl dev open          Open local development Atlas Web
  ./atlasctl vps status        Check VPS Docker services via SSH
  ./atlasctl vps diagnose      Run VPS diagnostics via SSH
  ./atlasctl vps mcp           Check hosted MCP OAuth protection
  ./atlasctl vps logs server   Inspect VPS Server logs via SSH

Services: postgres, server, node, web, tunnel, ollama
Legacy aliases: atlas → server, observatory → web

This CLI runs on your Mac; the 'vps' subcommands call the VPS diagnostics over SSH.
By default, up/down/restart manage only the MacBook Node connecting to hosted Atlas.
Hosted mode builds and runs the compiled Node without a file watcher.
When the LaunchAgent is installed, up/down/restart operate through launchd.
Set ATLAS_SERVER_URL=wss://affan-atlas.duckdns.org/node/connect in apps/node/.env.node first.
The explicit 'dev' mode keeps tsx watch and manages PostgreSQL + local Server + Node + Web + MCP tunnel.
The old --hosted forms remain aliases for up/down/restart during migration.
Ollama is optional and included with --ask in local development mode.`);
}

async function up(includeAsk, hosted = true) {
  if (hosted) {
    if (!await startHostedNode()) process.exitCode = 1;
    else console.log("Hosted Node started. Local Server, Web, PostgreSQL and MCP tunnel were not started.");
    return;
  }
  // Never combine a local Server/MCP tunnel with a Node pointing at production.
  const nodeConfig = join(nodeDir, ".env.node");
  if (existsSync(nodeConfig)) {
    const contents = readFileSync(nodeConfig, "utf8");
    const configured = contents.match(/^ATLAS_SERVER_URL\s*=\s*["']?([^"'\r\n# ]+)/m)?.[1];
    if (configured && !/^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):3000\/node\/connect\/?$/.test(configured)) {
      console.error("Local dev requires the Node to point at ws://127.0.0.1:3000/node/connect.");
      console.error("The Node is configured for a different Server. Use './atlasctl up' instead.");
      process.exitCode = 2;
      return;
    }
  }
  for (const name of ["postgres", "server", "node", "web", ...(includeAsk ? ["ollama"] : []), "tunnel"]) {
    const started = name === "node" ? await startLocalNode() : await startService(name);
    if (!started) { process.exitCode = 1; return; }
  }
  console.log(`\nAtlas is ready${includeAsk ? " with Ask Atlas support" : ""}.`);
  console.log("Open http://127.0.0.1:5173");
}

async function down(includePostgres, hosted = true) {
  if (hosted) {
    if (!await stopHostedNode()) process.exitCode = 1;
    return;
  }
  // Dev teardown must never terminate the independently managed hosted Node.
  let okay = true;
  for (const name of ["tunnel", "ollama", "web"]) okay = await stopService(name) && okay;
  okay = await stopLocalNode() && okay;
  okay = await stopService("server") && okay;
  if (includePostgres) okay = await stopService("postgres") && okay;
  if (nodeTarget() === "hosted" || launchdState().loaded || readPid("node-hosted")) console.log("Hosted Atlas Node is untouched by dev down.");
  if (!okay) process.exitCode = 1;
}

const [command = "status", argument] = process.argv.slice(2);
function vpsCommand(action = "status", service) {
  const valid = new Set(["status", "health", "https", "mcp", "nodes", "migrations", "logs", "follow", "diagnose"]);
  const targets = new Set(["server", "postgres", "ingress"]);
  if (!valid.has(action) || (service && (!["logs", "follow"].includes(action) || !targets.has(service)))) {
    console.error("Usage: ./atlasctl vps [status|health|https|mcp|nodes|migrations|diagnose|logs|follow] [server|ingress|postgres]");
    process.exitCode = 2;
    return;
  }
  const host = process.env.ATLAS_VPS_SSH_HOST || "ovh";
  if (!/^[a-zA-Z0-9._@-]+$/.test(host)) {
    console.error("ATLAS_VPS_SSH_HOST must be a simple SSH host alias or user@host.");
    process.exitCode = 2;
    return;
  }
  const script = "cd ~/atlas-deploy && ./atlas-vps.sh " + action + (service ? " " + service : "");
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", host, script], { stdio: "inherit" });
  if (result.error) {
    console.error("SSH failed: " + result.error.message);
    process.exitCode = 1;
  } else if (result.signal) {
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
const failDevFlag = () => {
  if (process.argv.includes("--ask") || process.argv.includes("--all")) {
    console.error("Local-stack flags belong under './atlasctl dev'. Try './atlasctl dev up --ask' or './atlasctl dev down --all'.");
    process.exitCode = 2;
    return true;
  }
  return false;
};
switch (command) {
  case "up": if (!failDevFlag()) await up(false, true); break;
  case "down": if (!failDevFlag()) await down(false, true); break;
  case "restart":
    if (!failDevFlag() && !await restartHostedNode()) process.exitCode = 1;
    break;
  case "dev":
    switch (argument || "status") {
      case "up": await up(process.argv.includes("--ask"), false); break;
      case "down": await down(process.argv.includes("--all"), false); break;
      case "restart":
        await down(false, false);
        if (!process.exitCode) await up(process.argv.includes("--ask"), false);
        break;
      case "status": await printStatus(); break;
      case "open": spawn("open", ["http://127.0.0.1:5173"], { detached: true, stdio: "ignore" }).unref(); break;
      default: console.error("Usage: ./atlasctl dev [up|down|restart|status|open] [--ask|--all]"); process.exitCode = 2;
    }
    break;
  case "status": await printStatus(); break;
  case "launchd":
    switch (argument || "status") {
      case "install": if (!await installLaunchd()) process.exitCode = 1; break;
      case "status": if (!printLaunchdStatus()) process.exitCode = 1; break;
      case "uninstall": if (!await uninstallLaunchd()) process.exitCode = 1; break;
      default: console.error("Usage: ./atlasctl launchd [install|status|uninstall]"); process.exitCode = 2;
    }
    break;
  case "vps": vpsCommand(argument || "status", process.argv[4]); break;
  case "start": {
    const name = selectedService(argument);
    const started = name === "node" ? (nodeTarget() === "hosted" ? await startHostedNode() : await startLocalNode()) : name ? await startService(name) : true;
    if (!started) process.exitCode = 1;
    break;
  }
  case "stop": {
    const name = selectedService(argument);
    const stopped = name === "node" ? (nodeTarget() === "hosted" ? await stopHostedNode() : await stopLocalNode()) : name ? await stopService(name) : true;
    if (!stopped) process.exitCode = 1;
    break;
  }
  case "logs": showLogs(argument); break;
  case "configure":
    if (argument === "tunnel-key") await configureTunnelKey();
    else { console.error("Usage: ./atlasctl configure tunnel-key"); process.exitCode = 2; }
    break;
  case "open": spawn("open", [hostedWebUrl()], { detached: true, stdio: "ignore" }).unref(); break;
  case "help": case "--help": case "-h": usage(); break;
  default: console.error(`Unknown command "${command}".\n`); usage(); process.exitCode = 2;
}
