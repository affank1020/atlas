import { hostname } from 'node:os';
import path from 'node:path';
const list = (value: string) => value.split(',').map(x => x.trim()).filter(Boolean);
/** Component loaders also preserve environment defaults for legacy direct constructors. */
export function loadWorkspaceConfig(env: NodeJS.ProcessEnv = process.env) {
    return { roots: list(env.ATLAS_WORKSPACE_ROOTS ?? ''), origins: list(env.ATLAS_WORKSPACE_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173') };
}
export function loadUnityConfig(env: NodeJS.ProcessEnv = process.env) {
    return { binary: env.ATLAS_UNITY_CLI || 'unity', approvedCommands: list(env.ATLAS_UNITY_ALLOWED_COMMANDS ?? '') };
}
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env) { return { baseUrl: env.OLLAMA_URL ?? 'http://127.0.0.1:11434' }; }
export function loadRetrievalConfig(env: NodeJS.ProcessEnv = process.env) { return { embeddingModel: env.FABRIC_EMBEDDING_MODEL ?? 'nomic-embed-text' }; }
export function loadPortfolioConfig(env: NodeJS.ProcessEnv = process.env) {
    return { mediaRoot: env.ATLAS_MEDIA_DIR ?? path.resolve('data/media'), integrationEnvironment: {
        CONTENTFUL_SPACE_ID: env.CONTENTFUL_SPACE_ID,
        CONTENTFUL_ENVIRONMENT: env.CONTENTFUL_ENVIRONMENT,
        CONTENTFUL_DELIVERY_ACCESS_TOKEN: env.CONTENTFUL_DELIVERY_ACCESS_TOKEN,
        CONTENTFUL_WEBHOOK_SIGNING_SECRET: env.CONTENTFUL_WEBHOOK_SIGNING_SECRET,
        CONTENTFUL_WEBHOOK_TTL_SECONDS: env.CONTENTFUL_WEBHOOK_TTL_SECONDS,
    } };
}
export function requireDatabaseUrl(value = process.env.DATABASE_URL) {
    if (!value?.trim()) throw new Error('DATABASE_URL is required. Atlas uses PostgreSQL and does not fall back to JSON storage.');
    return value;
}
export function loadNodeConfig(env: NodeJS.ProcessEnv = process.env) {
    const execution = env.ATLAS_NODE_EXECUTION ?? 'remote';
    if (execution !== 'remote') throw new Error('Atlas Server requires ATLAS_NODE_EXECUTION=remote; run Atlas Node independently.');
    return { name: env.ATLAS_NODE_NAME?.trim() || hostname() || 'Local Node', execution };
}
/** Never log this object: integration settings contain secrets. */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, overrides: { databaseUrl?: string } = {}) {
    const databaseUrl = requireDatabaseUrl(overrides.databaseUrl ?? env.DATABASE_URL ?? '');
    const port = Number(env.ATLAS_PORT ?? 3000);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ATLAS_PORT must be an integer between 0 and 65535.');
    const host = env.ATLAS_HOST ?? '127.0.0.1';
    const trustedIngress = env.ATLAS_TRUSTED_INGRESS === 'true';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !trustedIngress)
        throw new Error('Non-loopback Atlas Server binding requires ATLAS_TRUSTED_INGRESS=true and a reviewed private/reverse-proxy ingress.');
    let oauthIssuer = env.ATLAS_MCP_OAUTH_ISSUER?.trim() || '';
    const oauthSubject = env.ATLAS_MCP_OAUTH_ALLOWED_SUBJECT?.trim() || '';
    const mcpResource = env.ATLAS_MCP_RESOURCE?.trim() || '';
    const scope = 'atlas:access';
    if (oauthIssuer || oauthSubject || mcpResource) {
        if (!oauthIssuer || !oauthSubject || !mcpResource) throw new Error('Atlas MCP OAuth requires ATLAS_MCP_OAUTH_ISSUER, ATLAS_MCP_OAUTH_ALLOWED_SUBJECT and ATLAS_MCP_RESOURCE together.');
        const issuer = new URL(oauthIssuer);
        const resource = new URL(mcpResource);
        if (issuer.protocol !== 'https:' || !issuer.hostname || issuer.search || issuer.hash || issuer.pathname !== '/' ||
            resource.protocol !== 'https:' || resource.pathname !== '/mcp' || resource.search || resource.hash || resource.origin === issuer.origin)
            throw new Error('Atlas MCP OAuth requires an HTTPS issuer root and an HTTPS /mcp resource on separate origins.');
        if (!/^[a-zA-Z0-9|._:@-]{3,256}$/.test(oauthSubject)) throw new Error('Invalid ATLAS_MCP_OAUTH_ALLOWED_SUBJECT.');
        // Auth0 publishes its root issuer with a trailing slash. Keep that exact
        // canonical form for discovery and strict JWT `iss` validation.
        oauthIssuer = issuer.toString();
    }
    return {
        databaseUrl, host, port,
        mcpAuth: { enabled: Boolean(oauthIssuer && oauthSubject && mcpResource), trustedIngress,
            issuer: oauthIssuer, subject: oauthSubject, resource: mcpResource, scope },
        node: loadNodeConfig(env), workspace: loadWorkspaceConfig(env), unity: loadUnityConfig(env), ai: loadAiConfig(env),
        retrieval: loadRetrievalConfig(env), portfolio: loadPortfolioConfig(env),
    };
}
export type ServerConfig = ReturnType<typeof loadServerConfig>;
