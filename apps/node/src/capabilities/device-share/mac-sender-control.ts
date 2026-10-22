import { createServer, createConnection, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nodeStatusPath } from '../../core/node-installation.js';
import type { StandaloneNode } from '../../core/connection/standalone.js';

/** Mac-only, per-user local IPC. This never exposes the Node credential. */
export function macShareSocketPath(): string {
    return join(dirname(nodeStatusPath('darwin')), 'node-share.sock');
}

const MAX_LOCAL_REQUEST = 80 * 1024; // UTF-8 JSON up to 16,384 UTF-16 characters.
type ShareControl = Pick<StandaloneNode, 'shareRecipients' | 'sendDeviceShare'>;
type Approve = (targetId: string, text: string) => Promise<boolean>;

/** A local socket caller is not proof that the user consented. Require a
 * separate macOS GUI decision before forwarding any clipboard content.
 * Only a short preview enters osascript stdin, never argv or Node logs.
 */
export async function promptMacOutgoingShare(targetId: string, text: string): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    const shortId = targetId.slice(0, 8);
    const preview = text.slice(0, 150)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[\\"]/g, char => '\\' + char);
    const script = 'set response to display dialog "Send Atlas clipboard to Node ' +
        shortId + '?" & return & return & "' + preview +
        '" with title "Atlas" buttons {"Cancel", "Send"} default button "Cancel" giving up after 15\n' +
        'return button returned of response\n';
    return new Promise(resolve => {
        const proc = spawn('osascript', ['-'], { stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '', done = false;
        const finish = (allowed: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            resolve(allowed);
        };
        const timeout = setTimeout(() => { proc.kill('SIGKILL'); finish(false); }, 18_000);
        proc.stdout.on('data', bytes => { output = (output + String(bytes)).slice(0, 16); });
        proc.on('error', () => finish(false));
        proc.on('close', code => finish(code === 0 && output.trim() === 'Send'));
        proc.stdin.on('error', () => undefined);
        proc.stdin.end(script);
    });
}


function checkDirectory(parent: string) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new Error('Atlas local sharing directory must be private (0700) and owned by this user.');
}

async function cleanStaleSocket(path: string) {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    if (!stat.isSocket() || stat.uid !== process.getuid?.())
        throw new Error('Refusing to replace an unexpected Atlas sharing socket.');
    // Only unlink a genuinely stale, same-user socket. Never steal a live Node.
    const active = await new Promise<boolean>((resolve, reject) => {
        const probe = createConnection(path);
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ECONNREFUSED') resolve(false);
            else reject(error);
        });
    });
    if (active) throw new Error('Another Atlas sharing listener is already active.');
    const latest = lstatSync(path);
    if (latest.ino !== stat.ino || latest.dev !== stat.dev || !latest.isSocket())
        throw new Error('Atlas sharing socket changed while checking for stale listeners.');
    unlinkSync(path);
}

export async function startMacShareControlServer(
    node: ShareControl, path = macShareSocketPath(), approve: Approve = promptMacOutgoingShare,
) {
    if (process.platform !== 'darwin' && path === macShareSocketPath())
        throw new Error('Mac sharing is supported only in a macOS login session.');
    checkDirectory(dirname(path));
    await cleanStaleSocket(path);
    const connections = new Set<Socket>();
    const server = createServer(socket => {
        connections.add(socket);
        socket.setTimeout(60_000);
        socket.once('close', () => connections.delete(socket));
        socket.once('timeout', () => socket.destroy());
        let buffer = Buffer.alloc(0);
        let handled = false;
        socket.on('data', chunk => {
            if (handled) return;
            // Node's Socket data events are typed as Buffer|string; buffer
            // construction must handle either representation safely.
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
            buffer = Buffer.concat([buffer, bytes]);
            if (buffer.length > MAX_LOCAL_REQUEST) { socket.destroy(); return; }
            const end = buffer.indexOf(10);
            if (end < 0) return;
            handled = true;
            const input = buffer.subarray(0, end).toString('utf8');
            // Never log/persist incoming plaintext or include it in errors.
            void (async () => {
                try {
                    const req: unknown = JSON.parse(input);
                    if (!req || typeof req !== 'object') throw Error('Invalid request');
                    const data = req as Record<string, unknown>;
                    let result: unknown;
                    if (data.action === 'recipients' && Object.keys(data).length === 1) {
                        result = { recipients: await node.shareRecipients() };
                    } else if (data.action === 'send' && Object.keys(data).length === 3 &&
                        typeof data.targetNodeId === 'string' && typeof data.text === 'string') {
                        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
                            .test(data.targetNodeId) ||
                            !data.text.trim() || data.text.length > 16_384)
                            throw Error('Invalid request');
                        if (!await approve(data.targetNodeId, data.text) || socket.destroyed) {
                            result = { cancelled: true };
                        } else {
                            result = await node.sendDeviceShare(data.targetNodeId, data.text);
                        }
                    } else throw Error('Invalid request');
                    socket.end(JSON.stringify({ ok: true, result }) + '\n');
                } catch (error) {
                    const code = error && typeof error === 'object' && 'code' in error &&
                        typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code)
                        ? error.code : 'SHARE_UNAVAILABLE';
                    socket.end(JSON.stringify({ ok: false, code }) + '\n');
                }
            })();
        });
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(path, () => { server.off('error', reject); resolve(); });
        });
        chmodSync(path, 0o600);
        const info = lstatSync(path);
        return {
            async close() {
                for (const client of connections) client.destroy();
                await new Promise<void>(resolve => server.close(() => resolve()));
                try {
                    const actual = lstatSync(path);
                    if (actual.isSocket() && actual.dev === info.dev && actual.ino === info.ino)
                        unlinkSync(path);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            },
        };
    } catch (error) {
        server.close();
        throw error;
    }
}
