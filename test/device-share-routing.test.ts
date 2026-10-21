import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { loadDeviceShareConfig, loadServerConfig } from '../apps/server/src/server/config.js';
import { composeServer } from '../apps/server/src/server/composition.js';
import { createHttpTransport } from '../apps/server/src/api/http/index.js';

after(cleanupDatabases);
const ack = (socket: WebSocket) => once(socket, 'message').then(([bytes]) => JSON.parse(String(bytes)) as any);

test('device-share allowlist is directional, strict and disabled by default', () => {
    const a = randomUUID(), b = randomUUID();
    assert.equal(loadDeviceShareConfig({}).approvedPairs.size, 0);
    const pairs = loadDeviceShareConfig({ ATLAS_DEVICE_SHARE_PAIRS: a + ':' + b }).approvedPairs;
    assert.ok(pairs.has(a + ':' + b));
    assert.ok(!pairs.has(b + ':' + a));
    for (const invalid of ['*:*', a + ':' + a, 'bad:' + b, a + ':' + b + ':other']) {
        assert.throws(() => loadDeviceShareConfig({ ATLAS_DEVICE_SHARE_PAIRS: invalid }));
    }
});

test('authenticated share relay requires approved peers, active advertised capabilities, explicit receipt and replay safety', async () => {
    const fixture = await databaseFixture();
    const identity = new NodeIdentity(fixture.store.pool);
    const enrolled = await Promise.all([identity.ticket(), identity.ticket(), identity.ticket()]);
    const [sender, receiver, outsider] = await Promise.all(
        enrolled.map((ticket, i) => identity.enrol({
            token: ticket.enrolmentToken, name: 'Test node ' + i, platform: 'test',
        }))
    );
    const config = loadServerConfig({
        DATABASE_URL: fixture.databaseUrl,
        ATLAS_NODE_EXECUTION: 'remote',
        ATLAS_HOST: '127.0.0.1',
        ATLAS_DEVICE_SHARE_PAIRS: sender.nodeId + ':' + receiver.nodeId,
    });
    const services = composeServer(config);
    const http = createHttpTransport(services);
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const url = 'ws://127.0.0.1:' + (http.address() as AddressInfo).port + '/node/connect';
    const sockets: WebSocket[] = [];
    const connect = async (id: string, credential: string, capabilities: string[]) => {
        const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + credential } });
        sockets.push(ws);
        await once(ws, 'open');
        const response = ack(ws);
        ws.send(JSON.stringify({ type: 'register', protocol: 2, nodeId: id,
            name: 'Test', platform: 'test', capabilities }));
        assert.equal((await response).type, 'registered');
        return ws;
    };
    try {
        const src = await connect(sender.nodeId, sender.credential, ['device.share.send']);
        const dst = await connect(receiver.nodeId, receiver.credential, ['device.share.receive']);
        const other = await connect(outsider.nodeId, outsider.credential, ['device.share.send']);
        let deliveries = 0;
        let acceptance = true;
        dst.on('message', bytes => {
            const message = JSON.parse(String(bytes));
            if (message.kind !== 'device_share') return;
            deliveries++;
            assert.equal(message.sourceNodeId, sender.nodeId);
            assert.equal(message.text, 'share hello');
            assert.ok(Date.parse(message.expiresAt) > Date.now());
            dst.send(JSON.stringify({ type: 'response', requestId: message.requestId,
                ok: true, result: { accepted: acceptance } }));
        });
        const send = async (ws: WebSocket, target: string, deliveryId: string, text = 'share hello') => {
            const requestId = randomUUID();
            const response = ack(ws);
            ws.send(JSON.stringify({ type: 'device.share.submit', requestId, deliveryId,
                targetNodeId: target, text }));
            return response;
        };
        const firstId = randomUUID();
        const first = await send(src, receiver.nodeId, firstId);
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.deepEqual(first.result, { accepted: true });
        assert.equal(deliveries, 1);

        const duplicate = await send(src, receiver.nodeId, firstId);
        assert.deepEqual(duplicate.result, { accepted: true });
        assert.equal(deliveries, 1, 'Replay of same deliveryId must not cause a second device action');

        const modified = await send(src, receiver.nodeId, firstId, 'changed payload');
        assert.equal(modified.ok, false);
        assert.equal(modified.error.code, 'SHARE_REPLAY');

        acceptance = false;
        const deniedByRecipient = await send(src, receiver.nodeId, randomUUID());
        assert.equal(deniedByRecipient.ok, true);
        assert.deepEqual(deniedByRecipient.result, { accepted: false });

        const notApproved = await send(other, receiver.nodeId, randomUUID());
        assert.equal(notApproved.ok, false);
        assert.equal(notApproved.error.code, 'SHARE_DENIED');

        const reverse = await send(dst, sender.nodeId, randomUUID());
        assert.equal(reverse.ok, false);
        assert.equal(reverse.error.code, 'SHARE_DENIED');

        const wrongDestination = await send(src, outsider.nodeId, randomUUID());
        assert.equal(wrongDestination.ok, false);
        assert.equal(wrongDestination.error.code, 'SHARE_DENIED');

        src.send(JSON.stringify({ type: 'device.share.submit', requestId: randomUUID(),
            deliveryId: randomUUID(), sourceNodeId: outsider.nodeId,
            targetNodeId: receiver.nodeId, text: 'spoofed' }));
        // Invalid strict-schema messages fail the socket rather than hitting the routing path.
        const closed = once(src, 'close');
        await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Malformed submission not closed')), 1500))]);
        assert.equal(deliveries, 2);
    } finally {
        for (const ws of sockets) ws.terminate();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await services.lifecycle.close();
    }
});

test('sharing is disabled when the server has no directional pair approval', async () => {
    const fixture = await databaseFixture();
    const identity = new NodeIdentity(fixture.store.pool);
    const t = await identity.ticket();
    const sender = await identity.enrol({ token: t.enrolmentToken, name: 'Sender', platform: 'test' });
    const services = composeServer(loadServerConfig({
        DATABASE_URL: fixture.databaseUrl, ATLAS_NODE_EXECUTION: 'remote', ATLAS_HOST: '127.0.0.1',
    }));
    const http = createHttpTransport(services);
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const socket = new WebSocket('ws://127.0.0.1:' + (http.address() as AddressInfo).port + '/node/connect',
        { headers: { Authorization: 'Bearer ' + sender.credential } });
    try {
        await once(socket, 'open');
        const registered = ack(socket);
        socket.send(JSON.stringify({ type: 'register', nodeId: sender.nodeId, name: 'Sender',
            protocol: 2, platform: 'test', capabilities: ['device.share.send'] }));
        await registered;
        const response = ack(socket);
        socket.send(JSON.stringify({ type: 'device.share.submit', requestId: randomUUID(),
            deliveryId: randomUUID(), targetNodeId: randomUUID(), text: 'hello' }));
        assert.equal((await response).error.code, 'SHARE_DENIED');
    } finally {
        socket.terminate();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await services.lifecycle.close();
    }
});
