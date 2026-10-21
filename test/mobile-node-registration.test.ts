import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { databaseFixture, cleanupDatabases } from './database.js';
import { composeServer } from '../apps/server/src/server/composition.js';
import { loadServerConfig } from '../apps/server/src/server/config.js';
import { createHttpTransport } from '../apps/server/src/api/http/index.js';

after(cleanupDatabases);

/** The Android 0.2 client will use exactly this standard Node v2 handshake. */
test('Android capability-free Node enrols, registers, advertises online, and disconnects', async () => {
    const fixture = await databaseFixture();
    const services = composeServer(loadServerConfig({
        DATABASE_URL: fixture.databaseUrl, ATLAS_NODE_EXECUTION: 'remote', ATLAS_HOST: '127.0.0.1',
    }));
    const http = createHttpTransport(services);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const origin = 'http://127.0.0.1:' + (http.address() as { port: number }).port;
    const endpoint = origin.replace('http:', 'ws:') + '/node/connect';
    let socket: WebSocket | undefined;
    try {
        const ticket = await services.identity.ticket();
        const enrol = await fetch(origin + '/node/enrol', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                token: ticket.enrolmentToken, name: 'Android test', platform: 'android', version: '0.2.0',
            }),
        });
        assert.equal(enrol.status, 200);
        const issued = await enrol.json() as { nodeId: string; credential: string };
        assert.ok(issued.nodeId);
        assert.ok(issued.credential.length >= 32);

        const replay = await fetch(origin + '/node/enrol', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: ticket.enrolmentToken, name: 'Replay', platform: 'android' }),
        });
        assert.equal(replay.status, 400, 'One-time pairing ticket must fail on reuse');

        socket = new WebSocket(endpoint, {
            headers: { Authorization: 'Bearer ' + issued.credential },
        });
        await once(socket, 'open');
        const acknowledgement = once(socket, 'message');
        socket.send(JSON.stringify({
            type: 'register', protocol: 2, nodeId: issued.nodeId,
            name: 'Samsung Android Node', platform: 'android',
            version: '0.2.0', capabilities: [],
        }));
        const message = JSON.parse(String((await acknowledgement)[0]));
        assert.deepEqual(message, { type: 'registered', protocol: 2, nodeId: issued.nodeId });
        const state = await services.nodes.get(issued.nodeId);
        assert.equal(state.status, 'online');
        assert.equal(state.platform, 'android');
        assert.deepEqual(state.capabilities, []);
        assert.equal(state.version, '0.2.0');

        const closed = once(socket, 'close');
        socket.close(1000, 'App backgrounded');
        await closed;
        for (let tries = 0; tries < 30 && (await services.nodes.get(issued.nodeId)).status === 'online'; tries++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal((await services.nodes.get(issued.nodeId)).status, 'offline');
    } finally {
        socket?.terminate();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await services.lifecycle.close();
    }
});
