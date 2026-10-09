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

function hostedWebUrl() {
  const configFile = join(nodeDir, ".env.node");
  if (existsSync(configFile)) {
    // Read the hostname only; never print the Node identity or credential.
    const match = readFileSync(configFile, "utf8")
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

function nodeTarget() {
  const config = join(nodeDir, ".env.node");
  if (!existsSync(config)) return undefined;
  const value = readFileSync(config, "utf8").match(/^ATLAS_SERVER_URL\s*=\s*["']?([^"'\r\n# ]+)/m)?.[1];
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "wss:" ? "hosted" : "local";
  } catch { return "invalid"; }
}

async function serviceState(name) {
  const service = services[name];
  if (service.type === "docker") {
    if (await portOpen(service.port)) return { state: "external", detail: `already listening on :${service.port}` };
    if (!commandExists("docker")) return { state: "stopped", detail: "Docker unavailable (only needed for local dev)" };
    const result = spawnSync("docker", [...composeArgs, "ps", "--status", "running", "--services"], { cwd: atlasDir, encoding: "utf8" });
    const running = result.status === 0 && result.stdout.split(/\s+/).includes("postgres");
    return running ? { state: "running", detail: "Docker Compose" } : { state: "stopped" };
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
Set ATLAS_SERVER_URL=wss://affan-atlas.duckdns.org/node/connect in apps/node/.env.node first.
The explicit 'dev' mode manages PostgreSQL + local Server + Node + Web + MCP tunnel.
The old --hosted forms remain aliases for up/down/restart during migration.
Ollama is optional and included with --ask in local development mode.`);
}

async function up(includeAsk, hosted = true) {
  if (hosted) {
    const nodeConfig = join(nodeDir, ".env.node");
    if (!existsSync(nodeConfig)) {
      console.error("Missing apps/node/.env.node; keep the existing Node identity and credential.");
      process.exitCode = 1;
      return;
    }
    const contents = readFileSync(nodeConfig, "utf8");
    const match = contents.match(/^ATLAS_SERVER_URL\s*=\s*[\"']?([^\"'\r\n# ]+)/m);
    if (!match || !/^wss:\/\/[^/]+\/node\/connect\/?$/.test(match[1])) {
      console.error("Hosted mode requires ATLAS_SERVER_URL=wss://<hostname>/node/connect in apps/node/.env.node.");
      console.error("Do not change ATLAS_NODE_ID or ATLAS_NODE_CREDENTIAL.");
      process.exitCode = 1;
      return;
    }
    if (!await startService("node")) process.exitCode = 1;
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
    if (!await startService(name)) { process.exitCode = 1; return; }
  }
  console.log(`\nAtlas is ready${includeAsk ? " with Ask Atlas support" : ""}.`);
  console.log("Open http://127.0.0.1:5173");
}

async function down(includePostgres, hosted = true) {
  if (hosted) { await stopService("node"); return; }
  // Dev teardown must never terminate the independently managed hosted Node.
  const devServices = ["tunnel", "ollama", "web", ...(nodeTarget() === "local" ? ["node"] : []), "server", ...(includePostgres ? ["postgres"] : [])];
  if (nodeTarget() === "hosted") console.log("Hosted Atlas Node is untouched by dev down.");
  for (const name of devServices) await stopService(name);
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
    if (!failDevFlag()) { await down(false, true); if (!process.exitCode) await up(false, true); }
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
  case "vps": vpsCommand(argument || "status", process.argv[3]); break;
  case "start": { const name = selectedService(argument); if (name && !await startService(name)) process.exitCode = 1; break; }
  case "stop": { const name = selectedService(argument); if (name && !await stopService(name)) process.exitCode = 1; break; }
  case "logs": showLogs(argument); break;
  case "configure":
    if (argument === "tunnel-key") await configureTunnelKey();
    else { console.error("Usage: ./atlasctl configure tunnel-key"); process.exitCode = 2; }
    break;
  case "open": spawn("open", [hostedWebUrl()], { detached: true, stdio: "ignore" }).unref(); break;
  case "help": case "--help": case "-h": usage(); break;
  default: console.error(`Unknown command "${command}".\n`); usage(); process.exitCode = 2;
}
