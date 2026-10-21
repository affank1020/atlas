import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MacShareReceiver, type IncomingShare } from '../apps/node/src/capabilities/device-share/mac-receiver.js';
import { LocalNodeRuntime } from '../apps/node/src/platforms/desktop/runtime.js';

const item = (): IncomingShare => ({
    deliveryId: randomUUID(),
    sourceNodeId: randomUUID(),
    text: 'sample https://example.org',
    expiresAt: new Date(Date.now() + 25_000).toISOString(),
});

test('desktop capability is opt-in and only a macOS runtime can advertise device.share.receive', () => {
    const mac = new LocalNodeRuntime([], new Map(), 'darwin', new MacShareReceiver(async () => false, async () => {}));
    const plain = new LocalNodeRuntime([], new Map(), 'darwin');
    const linux = new LocalNodeRuntime([], new Map(), 'linux', new MacShareReceiver(async () => true, async () => {}));
    assert.ok(mac.getCapabilities().includes('device.share.receive'));
    assert.ok(!plain.getCapabilities().includes('device.share.receive'));
    assert.ok(!linux.getCapabilities().includes('device.share.receive'));
    mac.close(); plain.close(); linux.close();
});

test('macOS share receiver copies exact text only after explicit approval', async () => {
    const copies: string[] = [];
    const receiver = new MacShareReceiver(async () => true, async text => { copies.push(text); });
    const share = item();
    assert.deepEqual(await receiver.receive(share), { accepted: true });
    assert.deepEqual(copies, [share.text]);
    assert.deepEqual(await receiver.receive(share), { accepted: true });
    assert.equal(copies.length, 1, 'replay must not copy again');
    await assert.rejects(receiver.receive({ ...share, text: 'tampered' }), (e: any) => e.code === 'SHARE_REPLAY');
});

test('macOS share receiver rejects declined, expired, busy and interrupted shares without copying', async () => {
    let copied = false;
    const denied = new MacShareReceiver(async () => false, async () => { copied = true; });
    assert.deepEqual(await denied.receive(item()), { accepted: false });
    assert.equal(copied, false);
    await assert.rejects(denied.receive({ ...item(), expiresAt: '2020-01-01T00:00:00Z' }),
        (e: any) => e.code === 'SHARE_EXPIRED');

    let release!: (value: boolean) => void;
    const waiting = new MacShareReceiver(async () => new Promise(resolve => { release = resolve; }),
        async () => { copied = true; });
    const active = waiting.receive(item());
    await assert.rejects(waiting.receive(item()), (e: any) => e.code === 'SHARE_BUSY');
    release(false); await active;
    assert.equal(copied, false);

    const controller = new AbortController();
    const interrupted = new MacShareReceiver(async () => { controller.abort(); return true; },
        async () => { copied = true; });
    assert.deepEqual(await interrupted.receive(item(), controller.signal), { accepted: false });
    assert.equal(copied, false);
});
