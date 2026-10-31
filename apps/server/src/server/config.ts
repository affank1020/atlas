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
    const endpoint = env.ATLAS_R2_ENDPOINT?.trim() ?? '';
    const bucket = env.ATLAS_R2_BUCKET?.trim() ?? '';
    const accessKeyId = env.ATLAS_R2_ACCESS_KEY_ID?.trim() ?? '';
    const secretAccessKey = env.ATLAS_R2_SECRET_ACCESS_KEY?.trim() ?? '';
    const values = [endpoint, bucket, accessKeyId, secretAccessKey];
    if (values.some(Boolean) && !values.every(Boolean))
        throw new Error('ATLAS_R2_ENDPOINT, ATLAS_R2_BUCKET, ATLAS_R2_ACCESS_KEY_ID and ATLAS_R2_SECRET_ACCESS_KEY must all be set together.');
    const r2 = values.every(Boolean) ? { endpoint, bucket, accessKeyId, secretAccessKey } : null;
    return { mediaRoot: env.ATLAS_MEDIA_DIR ?? path.resolve('data/media'), r2, integrationEnvironment: {
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
/** Explicit, directional and deny-by-default Node share approvals. No wildcard support. */
export function loadDeviceShareConfig(env: NodeJS.ProcessEnv = process.env) {
    const approvedPairs = new Set<string>();
    const value = env.ATLAS_DEVICE_SHARE_PAIRS?.trim() ?? '';
    if (!value) return { approvedPairs };
    const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
    for (const item of value.split(',')) {
        const pair = item.trim().split(':').map(x => x.trim().toLowerCase());
        if (pair.length !== 2 || !uuid.test(pair[0]!) || !uuid.test(pair[1]!) || pair[0] === pair[1])
            throw new Error('ATLAS_DEVICE_SHARE_PAIRS must contain directional sourceUUID:targetUUID pairs.');
        approvedPairs.add(pair[0] + ':' + pair[1]);
    }
    if (approvedPairs.size > 64) throw new Error('ATLAS_DEVICE_SHARE_PAIRS permits at most 64 explicit pairs.');
    return { approvedPairs };
}


/** Explicit repository-to-immutable-GitHub-user-ID trust map; fail closed if absent.
 * A login or free-text review heading is never sufficient proof of publisher origin.
 */
export function loadReviewPublisherTrust(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, ReadonlySet<number>> {
    const raw = env.ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON?.trim();
    const trusted = new Map<string, ReadonlySet<number>>();
    if (!raw) return trusted;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('Invalid ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length > 100)
        throw new Error('Invalid ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON.');
    for (const [repository, ids] of Object.entries(value)) {
        const key = repository.toLowerCase();
        if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(key) ||
            trusted.has(key) || !Array.isArray(ids) || ids.length < 1 || ids.length > 20 ||
            ids.some(id => !Number.isSafeInteger(id) || id < 1))
            throw new Error('Invalid ATLAS_CODE_REVIEW_TRUSTED_PUBLISHERS_JSON repository or publisher IDs.');
        trusted.set(key, new Set(ids as number[]));
    }
    return trusted;
}

/** Explicit allowlist for GitHub review publication; empty means disabled. */
export function loadCodeReviewPublishRepositories(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
    const raw = env.ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES?.trim() || '';
    if (!raw) return new Set();
    const values = raw.split(',').map(v => v.trim().toLowerCase());
    if (values.length > 30 || values.some(v => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(v)) ||
        new Set(values).size !== values.length)
        throw new Error('ATLAS_CODE_REVIEW_PUBLISH_REPOSITORIES must list distinct owner/repo pairs.');
    return new Set(values);
}

/** Separate opt-in from the legacy COMMENT-review publisher.
 * A repository enabled for old review publication is NOT automatically
 * enabled for managed, editable GitHub issue comments.
 */
export function loadManagedSummaryRepositories(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
    const raw = env.ATLAS_CODE_REVIEW_MANAGED_SUMMARY_REPOSITORIES?.trim() ?? '';
    if (!raw) return new Set();
    const values = raw.split(',').map(x => x.trim().toLowerCase());
    if (values.length > 30 || values.some(v => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(v) ||
        v.split('/').some(segment => segment === '.' || segment === '..')) ||
        new Set(values).size !== values.length)
        throw new Error('ATLAS_CODE_REVIEW_MANAGED_SUMMARY_REPOSITORIES requires distinct valid owner/repo pairs.');
    return new Set(values);
}

/** Separate opt-in for initial inline roots. Never inherit the legacy review
 * or managed summary publishing allowlists.
 */
export function loadInlineRootRepositories(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
    const raw = env.ATLAS_CODE_REVIEW_INLINE_ROOT_REPOSITORIES?.trim() ?? '';
    if (!raw) return new Set();
    const values = raw.split(',').map(value => value.trim().toLowerCase());
    if (values.length > 30 || values.some(v => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(v) ||
        v.split('/').some(segment => segment === '.' || segment === '..')) ||
        new Set(values).size !== values.length)
        throw new Error('ATLAS_CODE_REVIEW_INLINE_ROOT_REPOSITORIES requires distinct valid owner/repo pairs.');
    return new Set(values);
}

/** Separate deny-by-default reply allowlist. Initial root opt-in alone
 * must never authorize follow-up mutations.
 */
export function loadInlineReplyRepositories(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
    const raw = env.ATLAS_CODE_REVIEW_INLINE_REPLY_REPOSITORIES?.trim() ?? '';
    if (!raw) return new Set();
    const values = raw.split(',').map(value => value.trim().toLowerCase());
    if (values.length > 30 || values.some(value =>
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value) ||
        value.split('/').some(segment => segment === '.' || segment === '..')) ||
        new Set(values).size !== values.length)
        throw new Error('ATLAS_CODE_REVIEW_INLINE_REPLY_REPOSITORIES requires distinct owner/repo pairs.');
    return new Set(values);
}

/** Separate disabled-by-default flag for fix-evidence replies.
 * It does NOT inherit any other Code Reviews publication allowlist.
 */
export function loadInlineFixRepositories(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
    const raw=env.ATLAS_CODE_REVIEW_INLINE_FIX_REPOSITORIES?.trim()??'';
    if (!raw) return new Set();
    const values=raw.split(',').map(v=>v.trim().toLowerCase());
    if (values.length>30 || values.some(v=>
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(v) ||
        v.split('/').some(x=>x==='.' || x==='..')) ||
        new Set(values).size!==values.length)
        throw new Error('ATLAS_CODE_REVIEW_INLINE_FIX_REPOSITORIES requires distinct owner/repo pairs.');
    return new Set(values);
}

/** Independent opt-in: publishing fix evidence NEVER enables GraphQL thread mutation. */
export function loadThreadResolutionRepositories(env:NodeJS.ProcessEnv=process.env):ReadonlySet<string>{
    const raw=env.ATLAS_CODE_REVIEW_RESOLVE_THREAD_REPOSITORIES?.trim()??'';
    if(!raw)return new Set();
    const entries=raw.split(',').map(x=>x.trim().toLowerCase());
    if(entries.length>30||entries.some(x=>
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(x)||
        x.split('/').some(part=>part==='.'||part==='..'))||
        new Set(entries).size!==entries.length)
        throw new Error('ATLAS_CODE_REVIEW_RESOLVE_THREAD_REPOSITORIES must list distinct owner/repo pairs.');
    return new Set(entries);
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
    const relayTokenHash = env.ATLAS_MCP_RELAY_TOKEN_SHA256?.trim() || '';
    if (relayTokenHash && !/^[a-f0-9]{64}$/.test(relayTokenHash))
        throw new Error('ATLAS_MCP_RELAY_TOKEN_SHA256 must be a lowercase SHA-256 hex digest.');
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
    const portfolio = loadPortfolioConfig(env);
    // Never make the legacy per-run GitHub review and any managed publisher
    // available for the same repository. A bad cutover configuration must
    // fail at startup rather than allow duplicate GitHub publication.
    const publishRepositories = loadCodeReviewPublishRepositories(env);
    const managedSummaryRepositories = loadManagedSummaryRepositories(env);
    const inlineRootRepositories = loadInlineRootRepositories(env);
    const inlineReplyRepositories = loadInlineReplyRepositories(env);
    const inlineFixRepositories = loadInlineFixRepositories(env);
    const threadResolutionRepositories = loadThreadResolutionRepositories(env);
    const managedAllowLists = [managedSummaryRepositories, inlineRootRepositories,
        inlineReplyRepositories, inlineFixRepositories, threadResolutionRepositories];
    if ([...publishRepositories].some(repo => managedAllowLists.some(set => set.has(repo))))
        throw new Error('Atlas Code Reviews legacy and managed GitHub publishing must not overlap for a repository.');
    return {
        databaseUrl, host, port,
        mcpDiagnostics: env.ATLAS_MCP_DIAGNOSTICS === 'true',
        serverDiagnosticsEnabled: env.ATLAS_SERVER_DIAGNOSTICS_ENABLED !== 'false',
        mcpAuth: { enabled: Boolean(oauthIssuer && oauthSubject && mcpResource), trustedIngress,
            issuer: oauthIssuer, subject: oauthSubject, resource: mcpResource, scope, relayTokenHash },
        nodeFiles: { enabled: env.ATLAS_NODE_FILES_ENABLED === 'true' },
        // Fail closed until the separately reviewed host executor is installed.
        nodeUpdateClaims: { enabled: env.ATLAS_NODE_UPDATE_CLAIMS_ENABLED === 'true' },
        deviceShares: loadDeviceShareConfig(env),
        node: loadNodeConfig(env), workspace: loadWorkspaceConfig(env), unity: loadUnityConfig(env), ai: loadAiConfig(env),
        retrieval: loadRetrievalConfig(env), portfolio,
        codeReviews: { trustedPublishers: loadReviewPublisherTrust(env),
            publishRepositories, managedSummaryRepositories, inlineRootRepositories,
            inlineReplyRepositories, inlineFixRepositories, threadResolutionRepositories },
        storageAnalytics: { accountId: env.ATLAS_CF_ACCOUNT_ID?.trim(), analyticsToken: env.ATLAS_CF_ANALYTICS_TOKEN?.trim(), bucket: portfolio.r2?.bucket },
    };
}
export type ServerConfig = ReturnType<typeof loadServerConfig>;
