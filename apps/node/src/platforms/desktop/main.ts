import { config as loadEnv } from 'dotenv';
import { hostname, homedir } from 'node:os';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadWorkspaceConfig, loadUnityConfig } from '../../core/config.js';
import { LocalNodeRuntime } from './runtime.js';
import { UnityAdapter, UnityCliConnection } from '../../capabilities/unity/unity.js';
import { StandaloneNode } from '../../core/connection/standalone.js';
import { WorkspaceFiles } from '../../capabilities/workspace-files/files.js';

loadEnv({ path: process.env.ATLAS_NODE_ENV_FILE || '.env.node', quiet: true });
const id = z.string().uuid().parse(process.env.ATLAS_NODE_ID);
const name = (process.env.ATLAS_NODE_NAME || hostname()).trim();
if (!name || name.length > 200) throw new Error('ATLAS_NODE_NAME must be 1–200 characters.');
const token = process.env.ATLAS_NODE_CREDENTIAL || '';
if (token.length < 32) throw new Error('ATLAS_NODE_CREDENTIAL must contain at least 32 characters. Enrol the Node first.');
const serverUrl = new URL(process.env.ATLAS_SERVER_URL || 'ws://127.0.0.1:3000/node/connect');
if (serverUrl.pathname !== '/node/connect' || serverUrl.search || serverUrl.hash || !['ws:', 'wss:'].includes(serverUrl.protocol))
    throw new Error('ATLAS_SERVER_URL must be a WebSocket URL ending in /node/connect.');
if (serverUrl.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(serverUrl.hostname))
    throw new Error('A non-local Node connection requires wss://.');
const roots = loadWorkspaceConfig().roots;
if (!roots.length) throw new Error('ATLAS_WORKSPACE_ROOTS must contain at least one approved absolute path.');
const files = new WorkspaceFiles(roots);
const adapters = new Map();
if (process.env.ATLAS_NODE_UNITY_ENABLED === '1') {
    const unity = loadUnityConfig();
    adapters.set('unity', new UnityAdapter(files, new UnityCliConnection(unity.binary), unity.approvedCommands));
}
const runtime = new LocalNodeRuntime(roots, adapters);
const node = new StandaloneNode({ id, name, platform: process.env.ATLAS_NODE_PLATFORM || process.platform, version: process.env.ATLAS_NODE_VERSION || undefined, serverUrl: serverUrl.toString(), token }, runtime);
// Local, credential-free status for the macOS UI. It is intentionally
// independent of Atlas Hosted so a disconnected Node can still be inspected.
const statusDir = join(homedir(), 'Library', 'Application Support', 'Atlas');
const statusPath = join(statusDir, 'node-status.json');
type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'stopping';
let connectionState: ConnectionState = 'connecting';
let detail = '';
let changedAt = new Date().toISOString();
function publishStatus() {
    try {
        mkdirSync(statusDir, { recursive: true, mode: 0o700 });
        const temporary = statusPath + '.' + process.pid + '.tmp';
        writeFileSync(temporary, JSON.stringify({
            pid: process.pid, state: connectionState, detail,
            changedAt, updatedAt: new Date().toISOString(),
        }), { mode: 0o600 });
        renameSync(temporary, statusPath);
    } catch (error) {
        // Diagnostics must never take down the Node.
        console.error('Could not write local Atlas Node diagnostics:', error instanceof Error ? error.message : 'unknown error');
    }
}
function setConnectionState(state: ConnectionState, message = '') {
    if (connectionState !== state || detail !== message) changedAt = new Date().toISOString();
    connectionState = state;
    detail = message.slice(0, 160);
    publishStatus();
}
node.on('online', () => {
    setConnectionState('connected');
    console.log(`Atlas Node ${id} connected to Atlas Server.`);
});
node.on('offline', () => console.log(`Atlas Node ${id} disconnected; reconnecting.`));
node.on('socketClosed', (code: number, reason: string) => {
    const description = `WebSocket closed (code ${code}${reason ? ': ' + reason : ''})`;
    if (connectionState !== 'stopping') setConnectionState('reconnecting', description);
    console.warn(`Atlas Node ${description}; reconnecting.`);
});
node.on('connectionError', (message: string) => {
    if (connectionState !== 'stopping') setConnectionState('reconnecting', message);
    console.error(`Atlas Node connection failed: ${message}. Retrying.`);
});
publishStatus();
setInterval(publishStatus, 10_000).unref();
node.start();
let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    setConnectionState('stopping');
    await node.stop();
    process.exitCode = 0;
};
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
