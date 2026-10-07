#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const atlasDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = resolve(atlasDir, "apps/server");
const nodeDir = resolve(atlasDir, "apps/node");
const uiDir = resolve(atlasDir, "apps/web");
const composeArgs = ["compose", "-f", join(atlasDir, "infra/docker-compose.yml")];
const runtimeDir = join(tmpdir(), `atlas-control-${process.getuid?.() ?? "user"}`);
const tunnelProfile = join(homedir(), ".config/tunnel-client/atlas-local.yaml");
const keychainService = "atlas-tunnel-client";
const keychainAccount = userInfo().username;

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
  node: { label: "Atlas Node", command: "npm", args: ["run", "dev:node"], cwd: atlasDir, requires: join(nodeDir, ".env.node") },
  web: { label: "Atlas Web", command: "npm", args: ["run", "dev:web"], port: 5173, cwd: atlasDir, url: "http://127.0.0.1:5173/" },
  tunnel: { label: "MCP tunnel", command: "tunnel-client", args: ["run", "--profile", "atlas-local"], port: 8080, cwd: atlasDir, url: "http://127.0.0.1:8080/readyz", requires: tunnelProfile },
  ollama: { label: "Ollama", command: "ollama", args: ["serve"], port: 11434, cwd: atlasDir, url: "http://127.0.0.1:11434/api/tags", optional: true },
};

function paths(name) {
  return { pid: join(runtimeDir, `${name}.pid`), log: join(runtimeDir, `${name}.log`) };
}

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command]).status === 0;
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
  const runner = join(runtimeDir, `${name}-runner.zsh`);
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
  const command = `/bin/zsh ${shellQuote(runner)}`;
  const script = 'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run';
  return spawnSync("osascript", ["-e", script, command], { encoding: "utf8" });
}

function readPid(name) {
  const file = paths(name).pid;
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid)) return undefined;
  try { process.kill(pid, 0); return pid; } catch { rmSync(file, { force: true }); return undefined; }
}

function portOpen(port, timeout = 350) {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolveResult(value); };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function serviceState(name) {
  const service = services[name];
  if (service.type === "docker") {
    if (await portOpen(service.port)) return { state: "external", detail: `already listening on :${service.port}` };
    if (!commandExists("docker")) return { state: "missing", detail: "Docker command not found" };
    const result = spawnSync("docker", [...composeArgs, "ps", "--status", "running", "--services"], { cwd: atlasDir, encoding: "utf8" });
    const running = result.status === 0 && result.stdout.split(/\s+/).includes("postgres");
    return running ? { state: "running", detail: "Docker Compose" } : { state: "stopped" };
  }
  const pid = readPid(name);
  if (name === "node" && !pid && existsSync(service.requires)) {
    const match = readFileSync(service.requires, "utf8").match(/^ATLAS_NODE_ID=([0-9a-f-]{36})\s*$/m);
    if (match) {
      try {
        const response = await fetch("http://127.0.0.1:3000/api/tools/get_node", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeId: match[1] }), signal: AbortSignal.timeout(500),
        });
        if (response.ok && (await response.json()).status === "online")
          return { state: "external", detail: "connected to Atlas Server outside Atlas Control" };
      } catch { /* Server unavailable; continue with managed-process status. */ }
    }
  }
  if (!service.port) {
    if (pid) return { state: "running", detail: `managed · pid ${pid}` };
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

function stateText(state) {
  if (state === "running") return `${colors.green}RUNNING ${colors.reset}`;
  if (state === "external") return `${colors.green}RUNNING*${colors.reset}`;
  if (state === "starting") return `${colors.yellow}STARTING${colors.reset}`;
  if (state === "missing") return `${colors.red}MISSING ${colors.reset}`;
  return `${colors.dim}STOPPED ${colors.reset}`;
}

async function printStatus() {
  console.log(`${colors.bold}Atlas Control${colors.reset}\n`);
  for (const name of Object.keys(services)) {
    const service = services[name];
    const current = await serviceState(name);
    const suffix = current.detail ? `  ${colors.dim}${current.detail}${colors.reset}` : "";
    console.log(`${stateText(current.state)}  ${service.label.padEnd(14)}${suffix}`);
  }
  console.log(`\n${colors.dim}* Running outside Atlas Control; it will be left alone.${colors.reset}`);
  console.log(`Web:        http://127.0.0.1:5173`);
  console.log(`Tunnel UI:  http://127.0.0.1:8080/ui`);
}

async function waitForPort(port, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

async function startService(name) {
  const service = services[name];
  const current = await serviceState(name);
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

async function stopService(name) {
  const service = services[name];
  if (service.type === "docker") {
    const current = await serviceState(name);
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
    const current = await serviceState(name);
    console.log(current.state === "external"
      ? `${service.label} is running outside Atlas Control; leaving it alone.`
      : `${service.label} is already stopped.`);
    return true;
  }
  const descendants = [];
  const visit = (parent) => {
    const result = spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8" });
    for (const value of result.stdout?.trim().split(/\s+/).filter(Boolean) ?? []) {
      const child = Number(value);
      if (Number.isInteger(child)) { visit(child); descendants.push(child); }
    }
  };
  visit(pid);
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
  ./atlasctl up [--ask]        Start the normal stack; --ask also starts Ollama
  ./atlasctl down [--all]      Stop managed services; --all also stops PostgreSQL
  ./atlasctl restart [--ask]   Restart the managed stack
  ./atlasctl status            Show what is running
  ./atlasctl start <service>   Start one service
  ./atlasctl stop <service>    Stop one managed service
  ./atlasctl logs [service]    Show the latest managed logs
  ./atlasctl configure tunnel-key
                               Save the tunnel API key in macOS Keychain
  ./atlasctl open              Open Atlas Web in the default browser

Services: postgres, server, node, web, tunnel, ollama
Legacy aliases: atlas → server, observatory → web

The normal stack is PostgreSQL + Atlas Server + Atlas Node + Atlas Web + MCP tunnel.
Ollama is optional and only included by --ask.`);
}

async function up(includeAsk) {
  const remoteNode = true;
  for (const name of ["postgres", "server", ...(remoteNode ? ["node"] : []), "web", ...(includeAsk ? ["ollama"] : []), "tunnel"]) {
    if (!await startService(name)) { process.exitCode = 1; return; }
  }
  console.log(`\nAtlas is ready${includeAsk ? " with Ask Atlas support" : ""}.`);
  console.log("Open http://127.0.0.1:5173");
}

async function down(includePostgres) {
  for (const name of ["tunnel", "ollama", "web", "node", "server", ...(includePostgres ? ["postgres"] : [])]) await stopService(name);
}

const [command = "status", argument] = process.argv.slice(2);
switch (command) {
  case "up": await up(process.argv.includes("--ask")); break;
  case "down": await down(process.argv.includes("--all")); break;
  case "restart": await down(false); await up(process.argv.includes("--ask")); break;
  case "status": await printStatus(); break;
  case "start": if (selectedService(argument)) await startService(argument); break;
  case "stop": if (selectedService(argument)) await stopService(argument); break;
  case "logs": showLogs(argument); break;
  case "configure":
    if (argument === "tunnel-key") await configureTunnelKey();
    else { console.error("Usage: ./atlasctl configure tunnel-key"); process.exitCode = 2; }
    break;
  case "open": spawn("open", ["http://127.0.0.1:5173"], { detached: true, stdio: "ignore" }).unref(); break;
  case "help": case "--help": case "-h": usage(); break;
  default: console.error(`Unknown command "${command}".\n`); usage(); process.exitCode = 2;
}
