import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { databaseFixture, cleanupDatabases } from './database.js';
import { NodeIdentity } from '../apps/server/src/nodes/identity.js';
import { loadServerConfig } from '../apps/server/src/server/config.js';
import { composeServer } from '../apps/server/src/server/composition.js';
import { createHttpTransport } from '../apps/server/src/api/http/index.js';

after(cleanupDatabases);
const ack = (socket: WebSocket) => once(socket, 'message').then(([bytes]) => JSON.parse(String(bytes)) as any);

test('queue configuration is strictly additional to ordinary directional approval', async () => {
    const source = randomUUID(), target = randomUUID();
    const base = { DATABASE_URL: 'postgresql://example.invalid/db' };
    const { supportsAndroidInbox } = await import('../apps/server/src/infrastructure/nodes/durable-share-inbox.js');
    assert.equal(supportsAndroidInbox('0.5.0'), false);
    assert.equal(supportsAndroidInbox('0.6.0'), false);
    assert.equal(supportsAndroidInbox('0.7.0'), true);
    assert.equal(supportsAndroidInbox('1.0.0'), true);
    assert.equal(supportsAndroidInbox(null), false);
    const empty = loadServerConfig(base);
    assert.equal(empty.deviceShares.queuePairs.size, 0);
    assert.equal(empty.deviceShares.queueKey, undefined);
    const configured = loadServerConfig({ ...base,
        ATLAS_DEVICE_SHARE_QUEUE_PAIRS: source + ':' + target,
        ATLAS_DEVICE_SHARE_QUEUE_KEY: 'ab'.repeat(32) });
    assert.ok(configured.deviceShares.queuePairs.has(source + ':' + target));
    assert.equal(configured.deviceShares.approvedPairs.size, 0);
    assert.throws(() => loadServerConfig({ ...base,
        ATLAS_DEVICE_SHARE_QUEUE_PAIRS: source + ':' + target + ',bad' }));
});

test('offline encrypted shares preserve queued-vs-copied states, replay safety, and grant revocation', async () => {
    const fixture = await databaseFixture();
    const identity = new NodeIdentity(fixture.store.pool);
    const tickets = await Promise.all([identity.ticket(), identity.ticket()]);
    const [sender, receiver] = await Promise.all(tickets.map((t,i) =>
        identity.enrol({ token: t.enrolmentToken, name: 'Device ' + i,
            platform: i === 0 ? 'darwin' : 'android' })));
    const services = composeServer(loadServerConfig({
        DATABASE_URL: fixture.databaseUrl, ATLAS_NODE_EXECUTION: 'remote', ATLAS_HOST: '127.0.0.1',
        ATLAS_DEVICE_SHARE_QUEUE_PAIRS: sender.nodeId + ':' + receiver.nodeId,
        ATLAS_DEVICE_SHARE_QUEUE_KEY: 'ab'.repeat(32),
    }));
    const http = createHttpTransport(services);
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const url = 'ws://127.0.0.1:' + (http.address() as AddressInfo).port + '/node/connect';
    const sockets: WebSocket[] = [];
    const connect = async (node: typeof sender, caps: string[]) => {
        const socket = new WebSocket(url, { headers: { Authorization: 'Bearer ' + node.credential } });
        sockets.push(socket);
        await once(socket, 'open');
        const registration = ack(socket);
        socket.send(JSON.stringify({ type: 'register', protocol: 2,
            nodeId: node.nodeId, name: 'Test device', platform: node.nodeId === receiver.nodeId ? 'android' : 'darwin',
            capabilities: caps }));
        assert.equal((await registration).type, 'registered');
        return socket;
    };
    const request = async (socket: WebSocket, body: Record<string, unknown>) => {
        const reply = ack(socket);
        socket.send(JSON.stringify({ ...body, requestId: randomUUID() }));
        return reply;
    };
    try {
        const senderSocket = await connect(sender, ['device.share.send']);
        let receiverSocket = await connect(receiver, ['device.share.receive']);
        await services.shareApprovals.update({ sourceNodeId: sender.nodeId,
            targetNodeId: receiver.nodeId, enabled: true });
        // Simulate an enrolled tablet that is running the inbox-capable APK.
        // Older Android 0.5/0.6 clients have no inbox retrieval API.
        await fixture.store.pool.query("UPDATE nodes SET version='0.7.0' WHERE id=$1",
            [receiver.nodeId]);
        const offline = once(receiverSocket, 'close'); receiverSocket.terminate(); await offline;
        for (let i = 0; i < 60 && (await services.nodes.get(receiver.nodeId)).status === 'online'; i++)
            await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal((await services.nodes.get(receiver.nodeId)).status, 'offline');

        // Offline NodeService masks runtime capabilities, but an inbox-capable
        // registered Android Node should still appear as queue-eligible.
        const directory = await request(senderSocket, { type: 'device.share.recipients' });
        assert.equal(directory.ok, true, JSON.stringify(directory));
        const recipient = directory.result.recipients.find(
            (entry: { nodeId: string }) => entry.nodeId === receiver.nodeId);
        assert.ok(recipient);
        assert.equal(recipient.available, false);
        assert.equal(recipient.queueAvailable, true);

        const deliveryId = randomUUID(), text = 'Secret queued text: 😀\nnext line';
        const payload = { type: 'device.share.queue', deliveryId,
            targetNodeId: receiver.nodeId, text };
        const first = await request(senderSocket, payload);
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.equal(first.result.state, 'queued');
        assert.ok(Date.parse(first.result.expiresAt) > Date.now());
        const repeat = await request(senderSocket, { ...payload, targetNodeId: receiver.nodeId.toUpperCase() });
        assert.equal(repeat.result.state, 'queued');
        const altered = await request(senderSocket, { ...payload, text: 'tampered' });
        assert.equal(altered.ok, false);
        assert.equal(altered.error.code, 'SHARE_REPLAY');

        const database = await fixture.store.pool.query(
            'SELECT ciphertext,nonce,auth_tag FROM node_share_inbox WHERE delivery_id=$1', [deliveryId]);
        assert.equal(database.rowCount, 1);
        assert.equal(Buffer.from(database.rows[0].nonce).length, 12);
        assert.equal(Buffer.from(database.rows[0].auth_tag).length, 16);
        assert.ok(!Buffer.from(database.rows[0].ciphertext).includes(Buffer.from(text)));

        receiverSocket = await connect(receiver, ['device.share.receive']);
        const list = await request(receiverSocket, { type: 'device.share.inbox.list' });
        assert.equal(list.ok, true, JSON.stringify(list));
        assert.equal(list.result.items.length, 1);
        assert.equal(list.result.items[0].text, text);
        assert.equal(list.result.items[0].sourceNodeId, sender.nodeId);

        const copy = await request(receiverSocket, { type: 'device.share.inbox.resolve',
            deliveryId, sourceNodeId: sender.nodeId, accepted: true });
        assert.equal(copy.result.state, 'copied');
        const empty = await request(receiverSocket, { type: 'device.share.inbox.list' });
        assert.deepEqual(empty.result.items, []);
        const scrubbed = await fixture.store.pool.query(
            'SELECT status,ciphertext FROM node_share_inbox WHERE delivery_id=$1', [deliveryId]);
        assert.equal(scrubbed.rows[0].status, 'copied');
        assert.equal(scrubbed.rows[0].ciphertext, null);
        const repeated = await request(senderSocket, payload);
        assert.equal(repeated.result.state, 'copied');

        const secondId = randomUUID();
        await request(senderSocket, { ...payload, deliveryId: secondId });
        await services.shareApprovals.update({ sourceNodeId: sender.nodeId,
            targetNodeId: receiver.nodeId, enabled: false });
        const revoked = await request(receiverSocket, { type: 'device.share.inbox.list' });
        assert.deepEqual(revoked.result.items, []);
        const denied = await request(senderSocket, { ...payload, deliveryId: randomUUID() });
        assert.equal(denied.ok, false);
        assert.equal(denied.error.code, 'SHARE_DENIED');
    } finally {
        for (const socket of sockets) socket.terminate();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await services.lifecycle.close();
    }
});
