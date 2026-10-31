import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { LocalNodeRuntime } from '../apps/node/src/platforms/desktop/runtime.js';
import { StandaloneNode } from '../apps/node/src/core/connection/standalone.js';
import { startMacShareControlServer } from '../apps/node/src/capabilities/device-share/mac-sender-control.js';
import { safeTerminalLabel, formatShareRecipientOption, queueEligibleRecipients } from '../scripts/atlas-mac-share.mjs';


test('Mac terminal recipient labels cannot execute ANSI, OSC 52, C1 or multiline controls', () => {
    const control = '\x1b';
    const maliciousName = 'Tablet\n2. Fake device \r' +
        control + '[2J' + control + '[31m' +
        control + ']52;c;SGVsbG8=\x07' + '\u009b' + '\u009d' +
        '\u202e' + ' Samsung 🎉';
    const maliciousPlatform = 'android\t' + control + '[H' +
        control + ']52;c;ZGF0YQ==' + control + '\\' + '\u2028' + '🌍';
    const option = formatShareRecipientOption({
        name: maliciousName,
        platform: maliciousPlatform,
    }, 0);
    const cleanName = safeTerminalLabel(maliciousName);
    const cleanPlatform = safeTerminalLabel(maliciousPlatform);
    assert.equal(option, '  1. ' + cleanName + ' (' + cleanPlatform + ')');
    // No terminal-control characters, fake lines or bidirectional overrides.
    assert.doesNotMatch(option, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    assert.equal(option.split('\n').length, 1);
    assert.ok(option.includes('Samsung 🎉'), 'ordinary Unicode survives');
    assert.ok(option.includes('🌍'), 'platform Unicode survives');
    assert.ok(!option.includes('\x1b]52'), 'OSC 52 cannot execute');
    assert.ok(!option.includes('\x1b[2J'), 'screen-clearing CSI cannot execute');
    assert.equal(safeTerminalLabel('Sámšung 🚀'), 'Sámšung 🚀');
    assert.equal(safeTerminalLabel('Plain Mac'), 'Plain Mac');
});

test('queue picker excludes unsupported and legacy recipients but preserves offline-capable peers', () => {
    const targets = [
        { nodeId:randomUUID(), name:'Offline Samsung',status:'offline',available:false,queueCapable:true },
        { nodeId:randomUUID(), name:'Live Mac',status:'online',available:true,queueCapable:true },
        { nodeId:randomUUID(), name:'Unsupported Linux Node',status:'online',available:false,queueCapable:false },
        { nodeId:randomUUID(), name:'Old Directory Entry',status:'offline',available:false },
        { nodeId:randomUUID(), name:'Invalid metadata',status:'offline',available:false,queueCapable:true },
    ];
    const result=queueEligibleRecipients(targets);
    assert.deepEqual(result.map(x=>x.name),['Offline Samsung','Live Mac'],
        'offline support is independent of live availability; legacy/unsupported peers fail closed');
});

test('Mac sender is disabled by default, never appears on Linux, and does not change receiving', () => {
    const ordinary = new LocalNodeRuntime([], new Map(), 'darwin');
    const mac = new LocalNodeRuntime([], new Map(), 'darwin', undefined, true);
    const linux = new LocalNodeRuntime([], new Map(), 'linux', undefined, true);
    assert.ok(!ordinary.getCapabilities().includes('device.share.send'));
    assert.ok(mac.getCapabilities().includes('device.share.send'));
    assert.ok(!linux.getCapabilities().includes('device.share.send'));
    assert.ok(!mac.getCapabilities().includes('device.share.receive'));
    ordinary.close(); mac.close(); linux.close();
});

test('Mac Node lists recipients and sends only via existing authenticated WebSocket', async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const nodeId = randomUUID(), receiverId = randomUUID();
    let registrations = 0, shares = 0, queued = 0;
    sockets.on('connection', socket => {
        socket.on('message', bytes => {
            const msg = JSON.parse(String(bytes));
            if (msg.type === 'register') {
                registrations++;
                assert.deepEqual(msg.capabilities.includes('device.share.send'), true);
                socket.send(JSON.stringify({ type: 'registered', protocol: 2, nodeId }));
            } else if (msg.type === 'device.share.recipients') {
                socket.send(JSON.stringify({ type: 'response', requestId: msg.requestId,
                    ok: true, result: { recipients: [{
                        nodeId: receiverId, name: 'Samsung', platform: 'android',
                        status: 'online', available: true,
                    }] } }));
            } else if (msg.type === 'device.inbox.enqueue') {
                queued++;
                assert.equal(msg.targetNodeId,receiverId);
                assert.equal(msg.text,'Queued from Mac 🚀');
                assert.equal(msg.sourceNodeId,undefined);
                socket.send(JSON.stringify({
                    type:'response',requestId:msg.requestId,ok:true,
                    result:{deliveryId:msg.deliveryId,status:'queued',queued:true},
                }));
            } else if (msg.type === 'device.share.submit') {
                shares++;
                assert.equal(msg.targetNodeId, receiverId);
                assert.equal(msg.text, 'Hello from Mac 🚀');
                assert.ok(typeof msg.deliveryId === 'string');
                assert.equal(msg.sourceNodeId, undefined, 'server derives source');
                socket.send(JSON.stringify({ type: 'response', requestId: msg.requestId,
                    ok: true, result: { accepted: true } }));
            }
        });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const node = new StandaloneNode({
        id: nodeId, name: 'Mac', token: 'x'.repeat(43),
        serverUrl: 'ws://127.0.0.1:' + (server.address() as { port: number }).port,
    }, new LocalNodeRuntime([], new Map(), 'darwin', undefined, true));
    try {
        const online = once(node, 'online');
        node.start(); await online;
        const recipients = await node.shareRecipients();
        assert.deepEqual(recipients.map(x => x.name), ['Samsung']);
        assert.deepEqual(await node.sendDeviceShare(receiverId, 'Hello from Mac 🚀'), { accepted: true });
        assert.equal(registrations, 1, 'sharing must not create a second Node session');
        assert.equal(shares, 1);
        const queuedId=randomUUID();
        assert.deepEqual(await node.queueDeviceShare(receiverId,'Queued from Mac 🚀',queuedId),
            {deliveryId:queuedId,status:'queued',queued:true});
        assert.equal(queued,1);
        assert.equal(registrations,1,'offline queue reuses existing session');
        await assert.rejects(node.queueDeviceShare('not-id','test',queuedId));
        await assert.rejects(node.queueDeviceShare(receiverId,' ',queuedId));
        await assert.rejects(node.sendDeviceShare(receiverId, ' '));
        await assert.rejects(node.sendDeviceShare('not-an-id', 'test'));
    } finally {
        await node.stop();
        for (const socket of sockets.clients) socket.terminate();
        sockets.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

async function ipc(path: string, request: object): Promise<any> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(path);
        let result = '';
        socket.on('data', bytes => { result += String(bytes); });
        socket.on('error', reject);
        socket.on('end', () => {
            try { resolve(JSON.parse(result)); } catch (error) { reject(error); }
        });
        socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    });
}

test('local share IPC is private, strict, and never echoes submitted text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-mac-share-'));
    const path = join(dir, 'node-share.sock');
    const target = randomUUID();
    let delivered = 0, queued = 0;
    let approvalGranted = true;
    const listener = await startMacShareControlServer({
        shareRecipients: async () => [{
            nodeId: target, name: 'Samsung', platform: 'android',
            available: true, status: 'online' as const,
        }],
        sendDeviceShare: async (id, text) => {
            delivered++;
            assert.equal(id, target); assert.equal(text, 'secret message');
            return { accepted: true };
        },
        queueDeviceShare: async (id, text, deliveryId) => {
            queued++;
            assert.equal(id,target);
            assert.equal(text,'secret message');
            assert.ok(typeof deliveryId==='string');
            return {deliveryId,status:'queued' as const,queued:true};
        },
    } as any, path, async () => approvalGranted);
    try {
        assert.equal((await stat(path)).mode & 0o077, 0);
        assert.equal((await ipc(path, { action: 'recipients' })).result.recipients[0].name, 'Samsung');
        assert.deepEqual(await ipc(path, { action: 'send', targetNodeId: target, text: 'secret message' }),
            { ok: true, result: { accepted: true } });
        assert.equal(delivered, 1);
        approvalGranted = false;
        assert.deepEqual(await ipc(path, { action: 'send', targetNodeId: target, text: 'secret message' }),
            { ok: true, result: { cancelled: true } });
        assert.equal(delivered, 1, 'a local client must not bypass the native approval');
        const deliveryId=randomUUID();
        assert.deepEqual(await ipc(path,{action:'queue',targetNodeId:target,
            text:'secret message',deliveryId}),{ok:true,result:{cancelled:true}});
        assert.equal(queued,0,'a denied queue must not enqueue');
        approvalGranted=true;
        assert.deepEqual(await ipc(path,{action:'queue',targetNodeId:target,
            text:'secret message',deliveryId}),{ok:true,result:{deliveryId,status:'queued',queued:true}});
        assert.equal(queued,1);
        assert.equal((await ipc(path,{action:'queue',targetNodeId:target,
            text:'secret message',deliveryId:'invalid'})).ok,false);
        assert.equal(queued,1);
        assert.equal((await ipc(path, { action: 'send', targetNodeId: target, text: 'secret', extra: 'x' })).ok, false);
        assert.equal(delivered, 1);
        assert.ok(!(await ipc(path, { action: 'send', targetNodeId: target, text: 123 })).ok);
    } finally {
        await listener.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('local share IPC refuses a directory visible to other users', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-mac-perms-'));
    try {
        await chmod(dir, 0o755);
        await assert.rejects(startMacShareControlServer({} as any, join(dir, 'share.sock')), /private/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
