import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { z } from 'zod';
import { createHttpTransport } from '../apps/server/src/api/http/index.js';
import type { ServerServices } from '../apps/server/src/server/composition.js';
import type { McpAuthOptions } from '../apps/server/src/api/mcp/oauth.js';

const auth: McpAuthOptions = {
    enabled: true, trustedIngress: true, issuer: 'https://atlas-test-auth.invalid/',
    resource: 'https://atlas.example/mcp', subject: 'auth0|test-owner', scope: 'atlas:access',
};
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };

function token(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: auth.issuer, sub: auth.subject, aud: auth.resource,
        scope: auth.scope, exp: now + 600, ...overrides })).toString('base64url');
    const payload = `${header}.${claims}`;
    return `${payload}.${createSign('RSA-SHA256').update(payload).end().sign(privateKey).toString('base64url')}`;
}

const priorityNames = [
    'football_generalist_evaluate', 'football_generalist_baseline', 'football_generalist_status',
    'football_generalist_evaluation_detail', 'football_generalist_policies', 'football_generalist_assessments',
];

test('authenticated stateless MCP initializes, lists tools, calls status and rejects invalid tokens', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === new URL('/.well-known/jwks.json', auth.issuer).toString()
            ? Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }))
            : originalFetch(input, init)) as typeof fetch;
    let holdStatus: Promise<void> | undefined;
    const services = {
        config: { mcpAuth: auth, mcpDiagnostics: false, workspace: { origins: [] } },
        lifecycle: { close: async () => {} },
        applications: { tools: () => priorityNames.map(name => ({ name, description: name, inputSchema: { value: z.string().optional() } })) },
        dispatch: async (name: string) => {
            if (name !== 'get_atlas_status') return null;
            await holdStatus;
            return { product: 'Atlas', version: 'test' };
        },
    } as unknown as ServerServices;
    const server = createHttpTransport(services);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (id: number, method: string, bearer = token(), signal: AbortSignal = AbortSignal.timeout(5000)) => originalFetch(`${base}/mcp`, {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json, text/event-stream',
            'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method,
            ...(method === 'initialize' ? { params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } } : {}),
            ...(method === 'tools/call' ? { params: { name: 'get_atlas_status', arguments: {} } } : {}) }),
    });
    try {
        const init = await post(1, 'initialize');
        assert.equal(init.status, 200);
        assert.match(await init.text(), /"serverInfo"/);
        const list = await post(2, 'tools/list');
        assert.equal(list.status, 200);
        assert.match(await list.text(), /get_atlas_status/);
        const calls = await Promise.all(Array.from({ length: 4 }, (_, i) => post(3 + i, 'tools/call')));
        for (const response of calls) {
            assert.equal(response.status, 200);
            assert.match(await response.text(), /"product":"Atlas"/);
        }
        assert.equal((await post(8, 'tools/call', 'invalid-test-token')).status, 401);
        assert.equal((await post(9, 'tools/call', token({ exp: 1 }))).status, 401);
        let releaseStatus!: () => void;
        holdStatus = new Promise<void>(resolve => { releaseStatus = resolve; });
        const abort = new AbortController();
        const interrupted = await post(10, 'tools/call', token(), abort.signal);
        assert.equal(interrupted.status, 200);
        const interruptedBody = interrupted.text();
        abort.abort();
        await assert.rejects(interruptedBody);
        releaseStatus();
        holdStatus = undefined;
        const afterCancellation = await post(11, 'tools/call');
        assert.equal(afterCancellation.status, 200);
        assert.match(await afterCancellation.text(), /"product":"Atlas"/);
    } finally {
        globalThis.fetch = originalFetch;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('MCP registration failure terminates the HTTP request', async () => {
    const services = {
        config: { mcpAuth: { ...auth, enabled: false, trustedIngress: false }, mcpDiagnostics: false, workspace: { origins: [] } },
        lifecycle: { close: async () => {} },
        applications: { tools: () => { throw new Error('Registration failed'); } },
    } as unknown as ServerServices;
    const server = createHttpTransport(services);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const response = await fetch(`${base}/mcp`, {
            method: 'POST', signal: AbortSignal.timeout(2000),
            headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
                params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
        });
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: 'MCP_REQUEST_FAILED' });
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
