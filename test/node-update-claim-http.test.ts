import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { serveNodeUpdateClaim } from '../apps/server/src/api/http/node-update-claim.js';
import { AtlasError } from '../apps/server/src/shared/errors.js';

const nodeId = 'ff20f4df-0b6b-4e4a-8ac4-8b2485af3c37';
const intentId = 'ad42bf7f-a74f-4ccb-a09b-a47719869f63';
const credential = 'a'.repeat(43);
const digest = 'b'.repeat(64);
const version = '2.0.0+cccccccccccc';

async function fixture(options: { refuseAuth?: boolean; refuseClaim?: boolean; disabled?: boolean } = {}) {
    const operations: string[] = [];
    const services = {
        config: { nodeUpdateClaims: { enabled: !options.disabled } },
        identity: { authenticate: async (id: string, token: string) => {
            operations.push('auth:' + id + ':' + token.length);
            if (options.refuseAuth) {
                throw new AtlasError('Invalid Node credential.', 'NODE_AUTH_INVALID');
            }
        }},
        nodes: { updateIntents: { claim: async (...args: unknown[]) => {
            operations.push('claim:' + JSON.stringify(args));
            if (options.refuseClaim) {
                throw new AtlasError('Already claimed.', 'CONFLICT');
            }
            return { id: intentId, nodeId, status: 'claimed', approved: false, executable: false };
        } }},
    };
    const server = createServer((req, res) => { void serveNodeUpdateClaim(req, res,
        services as unknown as Parameters<typeof serveNodeUpdateClaim>[2]).then(handled => {
        if (!handled) { res.writeHead(404); res.end(); }
    }); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const info = server.address();
    if (!info || typeof info === 'string') throw new Error('Test listener missing.');
    const url = `http://127.0.0.1:${info.port}/node/update-intents/claim`;
    const headers = { authorization: 'Bearer ' + credential, 'x-atlas-node-id': nodeId, 'content-type': 'application/json' };
    const close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return { url, headers, operations, close };
}
const data = { intentId, expectedInstalledVersion: version, targetSha256: digest };

test('Node claim endpoint requires native Node bearer and matches approved claim contract', async t => {
    const f = await fixture(); t.after(f.close);
    const res = await fetch(f.url, { method: 'POST', headers: f.headers, body: JSON.stringify(data) });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.intent.status, 'claimed');
    assert.equal(body.intent.approved, false);
    assert.equal(body.intent.executable, false);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(f.operations.length, 2);
    assert.match(f.operations[1]!, /claim:/);
    assert.deepEqual(JSON.parse(f.operations[1]!.slice(6)), [nodeId,intentId,credential,version,digest]);
});

test('Node claim rejects Origin, missing credentials and wrong methods without entering ledger', async t => {
    const f = await fixture(); t.after(f.close);
    const cases: { method?: string; headers?: Record<string,string>; status: number }[] = [
        { method: 'GET', status: 405 },
        { headers: { ...f.headers, origin: 'https://trusted.example' }, status: 403 },
        { headers: { ...f.headers, authorization: 'Bearer nope' }, status: 401 },
        { headers: { ...f.headers, 'x-atlas-node-id': 'not-a-node' }, status: 401 },
    ];
    for (const item of cases) {
        const res = await fetch(f.url, { method: item.method ?? 'POST', headers: item.headers ?? f.headers,
            ...(item.method !== 'GET' && { body: JSON.stringify(data) }) });
        assert.equal(res.status, item.status);
    }
    assert.deepEqual(f.operations, []);
});

test('Node claim authenticates before processing malformed or oversized JSON', async t => {
    const f = await fixture(); t.after(f.close);
    const invalid = [
        '{',
        JSON.stringify({ ...data, unexpected: true }),
        JSON.stringify({ ...data, intentId: 'incorrect' }),
        JSON.stringify({ ...data, targetSha256: '0' }),
        JSON.stringify({ ...data, expectedInstalledVersion: 7 }),
        JSON.stringify({ data: 'x'.repeat(4096) }),
    ];
    for (const body of invalid) {
        const res = await fetch(f.url, { method: 'POST', headers: f.headers, body });
        assert.equal(res.status, 400, body.slice(0, 80));
    }
    assert.equal(f.operations.length, invalid.length);
    assert.ok(f.operations.every(x => x.startsWith('auth:')));
});

test('Node claim declines to read body until Node credential is valid', async t => {
    const f = await fixture({ refuseAuth: true }); t.after(f.close);
    const res = await fetch(f.url, { method: 'POST', headers: f.headers,
        body: JSON.stringify(data) });
    assert.equal(res.status, 401);
    assert.equal(f.operations.length, 1);
});

test('Node claim never treats a failed reservation as host execution', async t => {
    const f = await fixture({ refuseClaim: true }); t.after(f.close);
    const res = await fetch(f.url, { method: 'POST', headers: f.headers,
        body: JSON.stringify(data) });
    assert.equal(res.status, 409);
    assert.equal(f.operations.length, 2);
});

test('Node claim endpoint is unavailable by default until host execution is reviewed', async t => {
    const f = await fixture({ disabled: true }); t.after(f.close);
    const res = await fetch(f.url, { method: 'POST', headers: f.headers, body: JSON.stringify(data) });
    assert.equal(res.status, 404);
    assert.deepEqual(f.operations, [], 'disabled route must not authenticate or touch intent ledger');
});
