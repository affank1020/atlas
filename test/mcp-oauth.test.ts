import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createMcpTokenVerifier, mcpResourceMetadata, type McpAuthOptions } from '../apps/server/src/api/mcp/oauth.js';
import { createHttpTransport } from '../apps/server/src/api/http/index.js';
import type { ServerServices } from '../apps/server/src/server/composition.js';
import { loadServerConfig } from '../apps/server/src/server/config.js';

const config: McpAuthOptions = {
    enabled: true,
    trustedIngress: true,
    issuer: 'https://example.uk.auth0.com/',
    resource: 'https://affan-atlas.duckdns.org/mcp',
    subject: 'auth0|owner-only',
    scope: 'atlas:access',
};
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-1', use: 'sig', alg: 'RS256' };

function jwt(overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, ...headerOverrides })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({
        iss: config.issuer, sub: config.subject, aud: config.resource,
        exp: now + 900, nbf: now - 10, scope: config.scope, ...overrides,
    })).toString('base64url');
    const toSign = header + '.' + claims;
    const signature = createSign('RSA-SHA256').update(toSign).end().sign(privateKey).toString('base64url');
    return toSign + '.' + signature;
}

test('Atlas verifies Auth0 RS256 JWT signature, issuer, resource audience, subject and scope', async () => {
    let calls = 0;
    const fetcher = async (_input: unknown) => {
        calls++;
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    };
    const verifier = createMcpTokenVerifier(config, fetcher as typeof fetch);
    assert.equal(await verifier.authenticate('Bearer ' + jwt()), true);
    assert.equal(await verifier.authenticate('Bearer ' + jwt()), true);
    assert.equal(calls, 1, 'JWKS should be cached across valid requests');

    for (const altered of [
        { iss: 'https://attacker.invalid/' },
        { aud: 'https://attacker.invalid/mcp' },
        { sub: 'auth0|someone-else' },
        { scope: 'openid profile' },
        { exp: 1 },
        { nbf: Math.floor(Date.now() / 1000) + 3600 },
    ]) assert.equal(await verifier.authenticate('Bearer ' + jwt(altered)), false, JSON.stringify(altered));

    assert.equal(await verifier.authenticate('Bearer ' + jwt({}, { alg: 'none' })), false);
    assert.equal(await verifier.authenticate('Bearer ' + jwt().slice(0,-2) + 'xx'), false);
    assert.equal(await verifier.authenticate('Basic credentials'), false);
    assert.equal(await verifier.authenticate(undefined), false);
    assert.equal(await verifier.authenticate('Bearer ' + jwt({ scope: '', permissions: ['atlas:access'] })), true);
});

test('Atlas resource metadata advertises only the selected OAuth issuer and MCP resource', () => {
    assert.deepEqual(mcpResourceMetadata(config), {
        resource: config.resource,
        authorization_servers: [config.issuer],
        scopes_supported: ['atlas:access'],
    });
});

test('Host-configured MCP OAuth fails closed for missing, partial and invalid configuration', () => {
    const env = { DATABASE_URL: 'postgresql://localhost/example', ATLAS_TRUSTED_INGRESS: 'true' };
    assert.equal(loadServerConfig(env).mcpAuth.enabled, false);
    assert.throws(() => loadServerConfig({ ...env, ATLAS_MCP_OAUTH_ISSUER: config.issuer }), /requires.*together/);
    assert.throws(() => loadServerConfig({
        ...env, ATLAS_MCP_OAUTH_ISSUER: 'http://example.com/', ATLAS_MCP_OAUTH_ALLOWED_SUBJECT: config.subject, ATLAS_MCP_RESOURCE: config.resource,
    }), /HTTPS/);
    const configured = loadServerConfig({
        ...env, ATLAS_MCP_OAUTH_ISSUER: config.issuer, ATLAS_MCP_OAUTH_ALLOWED_SUBJECT: config.subject, ATLAS_MCP_RESOURCE: config.resource,
    });
    assert.equal(configured.mcpAuth.enabled, true);
});

test('Atlas canonicalizes an Auth0 issuer for metadata and exact JWT issuer validation', async () => {
    const issuerWithoutSlash = 'https://dev-lgttgg6z833e6cgk.us.auth0.com';
    const canonicalIssuer = issuerWithoutSlash + '/';
    const configured = loadServerConfig({
        DATABASE_URL: 'postgresql://localhost/example',
        ATLAS_TRUSTED_INGRESS: 'true',
        ATLAS_MCP_OAUTH_ISSUER: issuerWithoutSlash,
        ATLAS_MCP_OAUTH_ALLOWED_SUBJECT: config.subject,
        ATLAS_MCP_RESOURCE: config.resource,
    });

    assert.equal(configured.mcpAuth.issuer, canonicalIssuer);
    assert.deepEqual(mcpResourceMetadata(configured.mcpAuth).authorization_servers, [canonicalIssuer]);

    const verifier = createMcpTokenVerifier(configured.mcpAuth, async () =>
        new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
    assert.equal(await verifier.authenticate('Bearer ' + jwt({ iss: canonicalIssuer })), true);
    assert.equal(await verifier.authenticate('Bearer ' + jwt({ iss: issuerWithoutSlash })), false);
});

async function withHttp(mcpAuth: McpAuthOptions, run: (base: string) => Promise<void>) {
    const server = createHttpTransport({
        config: { mcpAuth, workspace: { origins: [] } },
        lifecycle: { close: async () => {} }
    } as unknown as ServerServices);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    try { await run(base); }
    finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}

test('Hosted MCP refuses unauthenticated HTTP requests; metadata stays public', async () => {
    await withHttp(config, async base => {
        const metadata = await fetch(base + '/.well-known/oauth-protected-resource');
        assert.equal(metadata.status, 200);
        assert.equal((await metadata.json()).resource, config.resource);
        const mcp = await fetch(base + '/mcp', { method: 'POST' });
        assert.equal(mcp.status, 401);
        assert.match(mcp.headers.get('www-authenticate') || '', /Bearer resource_metadata/);
        assert.equal((await mcp.json()).error, 'MCP_UNAUTHORIZED');
    });
    await withHttp({ ...config, enabled: false }, async base => {
        const metadata = await fetch(base + '/.well-known/oauth-protected-resource');
        assert.equal(metadata.status, 404);
        const mcp = await fetch(base + '/mcp', { method: 'POST' });
        assert.equal(mcp.status, 503);
        assert.equal((await mcp.json()).error, 'MCP_OAUTH_NOT_CONFIGURED');
    });
});
