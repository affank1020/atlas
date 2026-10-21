import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MacShareReceiver, copyMacShare, plainTextPasteboardScript, type IncomingShare } from '../apps/node/src/capabilities/device-share/mac-receiver.js';
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

test('NSPasteboard bridge always requests plain UTF-8 strings (including RTF-like and Unicode)', () => {
    const payloads = [String.raw\`{\rtf1\ansi Literal, not rich text\`, '%!PS-Adobe-3.0', 'مرحبا 中文 😊 café', 'line 1\\nline 2'];
    for (const text of payloads) {
        const script = plainTextPasteboardScript(text);
        assert.ok(script.includes('$.NSPasteboardTypeString'));
        assert.ok(script.includes('$.NSUTF8StringEncoding'));
        assert.ok(script.includes(Buffer.from(text, 'utf8').toString('base64')));
        assert.ok(!script.includes(text), 'Original text must not be inserted into JXA source');
    }
});

test('real macOS pasteboard faithfully round-trips RTF headers and Unicode', {
    skip: process.platform !== 'darwin' || process.env.ATLAS_MAC_PASTEBOARD_TEST !== '1',
}, async () => {
    // Explicit opt-in only: this changes the human user's clipboard.
    const payloads = [String.raw\`{\rtf1\ansi Literal RTF prefix\`, 'Unicode: مرحبا 👋 漢字 é'];
    assert.ok(payloads[0]!.startsWith(String.raw`{\rtf1`),
        'The regression must use a genuine single-backslash RTF header');
    for (const text of payloads) {
        await copyMacShare(text);
        const value = execFileSync('osascript', ['-l', 'JavaScript', '-e',
            "ObjC.import('AppKit'); ObjC.unwrap($.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString))"],
            { encoding: 'utf8' }).replace(/\n$/, '');
        assert.equal(value, text);
    }
});
