import { createPublicKey, verify as verifySignature } from 'node:crypto';

export type McpAuthOptions = {
    enabled: boolean;
    trustedIngress: boolean;
    issuer: string;
    resource: string;
    subject: string;
    scope: string;
};

type JwtHeader = { alg?: unknown; kid?: unknown; typ?: unknown };
type Claims = { iss?: unknown; sub?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; scope?: unknown; permissions?: unknown };
type Jwk = JsonWebKey & { kid?: string; kty?: string; use?: string; alg?: string; key_ops?: string[] };
type JwkSet = { keys: Jwk[] };

function parseBase64UrlJson(segment: string): Record<string, unknown> | undefined {
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > 12000) return;
        const result: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
        return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
    } catch { return; }
}

export function mcpResourceMetadata(config: McpAuthOptions) {
    return {
        resource: config.resource,
        authorization_servers: [config.issuer],
        scopes_supported: [config.scope],
    };
}

/**
 * Atlas is a single-user MCP resource server. The identity provider (Auth0)
 * issues JWT access tokens; Atlas only checks signatures and claims.
 * Fetch only issuer-pinned JWKS (not any URL from the token header).
 */
export function createMcpTokenVerifier(config: McpAuthOptions, fetchImpl: typeof fetch = fetch) {
    const jwksUrl = config.enabled ? new URL('/.well-known/jwks.json', config.issuer) : undefined;
    let cached: JwkSet | undefined;
    let cacheUntil = 0;
    let inFlight: Promise<JwkSet> | undefined;

    async function getJwks(force = false): Promise<JwkSet> {
        if (!jwksUrl) throw new Error('MCP OAuth not configured');
        if (!force && cached && Date.now() < cacheUntil) return cached;
        if (inFlight) return inFlight;
        inFlight = (async () => {
            const response = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(5000), redirect: 'error' });
            if (!response.ok || Number(response.headers.get('content-length') || 0) > 65536)
                throw new Error('OAuth JWKS unavailable');
            const text = await response.text();
            if (text.length > 65536) throw new Error('OAuth JWKS too large');
            const result: unknown = JSON.parse(text);
            if (!result || typeof result !== 'object' || !('keys' in result) || !Array.isArray(result.keys))
                throw new Error('Invalid OAuth JWKS');
            const keys = result.keys as Jwk[];
            if (keys.length > 64) throw new Error('Too many OAuth JWKS keys');
            cached = { keys };
            cacheUntil = Date.now() + 5 * 60 * 1000;
            return cached;
        })();
        try { return await inFlight; }
        finally { inFlight = undefined; }
    }

    async function authenticate(headerValue: string | undefined): Promise<boolean> {
        if (!config.enabled || !headerValue || !/^Bearer [^\s]+$/i.test(headerValue) || headerValue.length > 16384)
            return false;
        const token = headerValue.slice(7);
        const parts = token.split('.');
        if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
        const header = parseBase64UrlJson(parts[0]!) as JwtHeader | undefined;
        const claims = parseBase64UrlJson(parts[1]!) as Claims | undefined;
        if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256)
            return false;
        // Validate the JWT claims before performing expensive signature work, then
        // verify the signature before trusting any of these claims.
        const now = Math.floor(Date.now() / 1000);
        const audience = claims.aud === config.resource || (Array.isArray(claims.aud) && claims.aud.includes(config.resource));
        const scopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/) : [];
        const permitted = scopes.includes(config.scope) ||
            (Array.isArray(claims.permissions) && claims.permissions.includes(config.scope));
        if (claims.iss !== config.issuer || claims.sub !== config.subject || !audience || !permitted ||
            typeof claims.exp !== 'number' || claims.exp <= now - 30 ||
            (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now + 30)))
            return false;
        const signingInput = Buffer.from(parts[0]! + '.' + parts[1]!, 'ascii');
        const signature = Buffer.from(parts[2]!, 'base64url');
        let jwks = await getJwks();
        let key = jwks.keys.find(jwk => jwk.kid === header.kid);
        if (!key) { jwks = await getJwks(true); key = jwks.keys.find(jwk => jwk.kid === header.kid); }
        if (!key || key.kty !== 'RSA' || (key.use && key.use !== 'sig') ||
            (key.alg && key.alg !== 'RS256') || (key.key_ops && !key.key_ops.includes('verify')))
            return false;
        try {
            const publicKey = createPublicKey({ key, format: 'jwk' });
            return verifySignature('RSA-SHA256', signingInput, publicKey, signature);
        } catch { return false; }
    }
    return { authenticate };
}
