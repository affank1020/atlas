import { config as loadEnv } from 'dotenv';
import { hostname } from 'node:os';
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
node.on('online', () => console.log(`Atlas Node ${id} connected to Atlas Server.`));
node.on('offline', () => console.log(`Atlas Node ${id} disconnected; reconnecting.`));
node.on('connectionError', message => console.error(`Atlas Node connection failed: ${message}. Retrying.`));
node.start();
let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    await node.stop();
    process.exitCode = 0;
};
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
