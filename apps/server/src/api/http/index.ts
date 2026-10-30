import { timed } from '../../shared/performance.js';
import { serveFilesRequest } from './files.js';
import { serveNodeFileUpload } from './node-files.js';
import { serveNodeResumableRequest } from './node-resumable.js';
import { serveNodeUpdateClaim } from './node-update-claim.js';
import { serveNodeUpdateReport } from './node-update-report.js';
import { nodeSchemas } from '../../nodes/contracts.js';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { workspaceSchemas, type WorkspaceToolName } from "../../workspaces/contracts.js";
import { AtlasError } from "../../shared/errors.js";
import { standaloneViewPage } from "../../view-standalone.js";
import { verifyContentfulWebhook } from "../../integrations/contentful.js";
import type { ServerServices } from "../../server/composition.js";
import { createMcpTransport, RELAY_READ_TOOLS } from "../mcp/index.js";
import { createMcpTokenVerifier, mcpResourceMetadata, verifyRelayServiceToken } from '../mcp/oauth.js';
export function createHttpTransport(services: ServerServices) {
    const { catalog, askPortfolio, contentful, portfolio, media, lifecycle, config } = services;
    const mcpVerifier = createMcpTokenVerifier(config.mcpAuth);
    const http = createServer(async (request: IncomingMessage, response: ServerResponse) => {
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-atlas-client", "access-control-allow-methods": "GET,POST,OPTIONS" };
        // Opaque-origin View frames must never invoke privileged HTTP/MCP endpoints,
        // even if a future browser/runtime regression bypasses their connect-src policy.
        if(request.method === "POST" && request.headers.origin === "null") {
            response.writeHead(403,{"content-type":"application/json"}); response.end(JSON.stringify({error:"VIEW_ORIGIN_DENIED",message:"Sandboxed Views cannot call Atlas APIs."})); return;
        }
        // Workspace access must not be callable by arbitrary web origins. Native MCP
        // clients omit Origin; Observatory uses an explicitly trusted local origin.
        const workspaceRoute = /^\/api\/tools\/(?:.*workspace.*|unity_.*|list_github_repositories|list_nodes|get_monitoring_health|list_node_releases|plan_node_update|prepare_node_update|list_node_update_intents|cancel_node_update_intent|get_node|create_node_enrolment|update_node|rotate_node_credential|revoke_node|assign_workspace_node|list_node_share_approvals|update_node_share_approval)$/.test(request.url ?? "");
        if ((workspaceRoute || request.url === "/mcp") && request.headers.origin && request.headers.origin !== "null") {
            const allowedOrigins = config.workspace.origins;
            if (!allowedOrigins.includes(request.headers.origin)) { response.writeHead(403,{"content-type":"application/json"}); response.end(JSON.stringify({error:"ORIGIN_DENIED",message:"Origin is not approved for workspace access."})); return; }
        }
        if (await serveNodeUpdateReport(request, response, services)) return;
        if (await serveNodeUpdateClaim(request, response, services)) return;
        if (await serveNodeResumableRequest(request, response, services)) return;
        if (await serveNodeFileUpload(request, response, services)) return;
        if (request.method === "POST" && request.url === "/node/enrol") {
            try {
                const chunks: Buffer[] = []; let bytes = 0;
                for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) throw new AtlasError('Enrolment request too large.'); chunks.push(Buffer.from(chunk)); }
                const { token, name, platform, version } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (typeof token !== 'string' || token.length < 32 || typeof name !== 'string' || !name.trim() || name.length > 200 || typeof platform !== 'string' || !platform.trim() || platform.length > 80 || (version !== undefined && (typeof version !== 'string' || version.length > 80))) throw new AtlasError('Invalid enrolment metadata.');
                const result = await services.identity.enrol({ token, name: name.trim(), platform: platform.trim(), version });
                response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result));
            } catch (error) {
                response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: error instanceof AtlasError ? error.code : 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Enrolment failed.' }));
            }
            return;
        }
        // OAuth metadata must be public so ChatGPT can discover and link the MCP app.
        if (request.method === 'GET' && (request.url === '/.well-known/oauth-protected-resource' || request.url === '/.well-known/oauth-protected-resource/mcp')) {
            if (!config.mcpAuth.enabled) { response.writeHead(404); response.end(); return; }
            response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
            response.end(JSON.stringify(mcpResourceMetadata(config.mcpAuth)));
            return;
        }
        // Files handles its own strict preflight; never return wildcard CORS
        // headers for the private /api/files namespace.
        if (await serveFilesRequest(request, response, services)) return;
        if (request.method === "OPTIONS") { response.writeHead(204, cors); response.end(); return; }
        if (request.method === "POST" && request.url === "/integrations/contentful/webhook") {
            const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const rawBody = Buffer.concat(chunks).toString("utf8");
            if (!contentful.config.webhookSecret) { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Contentful webhook signing is not configured." })); return; }
            try {
                if (!verifyContentfulWebhook(request, rawBody, contentful.config.webhookSecret, contentful.config.requestTtlSeconds)) throw new Error("Invalid Contentful signature.");
            } catch (error) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Invalid Contentful webhook signature.", message: error instanceof Error ? error.message : String(error) })); return; }
            const idempotencyKey = String(request.headers["x-contentful-idempotency-key"] ?? "").trim();
            const topic = String(request.headers["x-contentful-topic"] ?? "unknown");
            if (!idempotencyKey) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Missing X-Contentful-Idempotency-Key." })); return; }
            try {
                const accepted = await contentful.acceptWebhook(idempotencyKey, topic);
                if (accepted) lifecycle.run("Contentful webhook sync", () => contentful.syncPortfolio("webhook", topic));
                response.writeHead(accepted ? 202 : 200, { "content-type": "application/json" }); response.end(JSON.stringify({ accepted, duplicate: !accepted }));
            } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Unable to persist Contentful webhook delivery.", message: error instanceof Error ? error.message : String(error) })); }
            return;
        }
        if (request.method === "POST" && request.url === "/api/ask-portfolio") {
            try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; const value = await askPortfolio.ask(input); response.writeHead(200, { ...cors, "content-type": "application/json" }); response.end(JSON.stringify(value)); }
            catch (error) { response.writeHead(400, { ...cors, "content-type": "application/json" }); response.end(JSON.stringify({ error: "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error) })); } return;
        }
        if (request.method === "GET" && request.url === "/api/public/portfolio") {
            try { const protocol=String(request.headers["x-forwarded-proto"]??"http").split(",")[0]!.trim();const baseUrl=request.headers.host?`${protocol}://${request.headers.host}`:"";response.writeHead(200,{...cors,"content-type":"application/json","cache-control":"public, max-age=60"}); response.end(JSON.stringify(await portfolio.publicContent(baseUrl))); }
            catch(error){ response.writeHead(500,{...cors,"content-type":"application/json"}); response.end(JSON.stringify({error:"PORTFOLIO_UNAVAILABLE",message:error instanceof Error?error.message:String(error)})); } return;
        }
        const mediaMatch=request.url?.match(/^\/api\/media\/([0-9a-f-]{36})\/(original|thumbnail|preview)$/i);
        if(request.method==="GET"&&mediaMatch){try{const file=await media.file(mediaMatch[1]!,mediaMatch[2]!);response.writeHead(200,{...cors,"content-type":file.mimeType,"cache-control":"public, max-age=31536000, immutable","x-content-type-options":"nosniff"});response.end(file.bytes);}catch(error){response.writeHead(error instanceof AtlasError&&error.code==="NOT_FOUND"?404:500,{...cors,"content-type":"application/json"});response.end(JSON.stringify({error:"NOT_FOUND",message:error instanceof Error?error.message:String(error)}));}return;}
        const standaloneUrl = new URL(request.url??"/","http://atlas.local");
        const standaloneMatch=standaloneUrl.pathname.match(/^\/projects\/([0-9a-f-]{36})\/views\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
        if(request.method==="GET"&&standaloneMatch){
            try{const rendered=await timed('view.standalone', () => services.views.renderStandalone(standaloneMatch[1]!,standaloneMatch[2]!,Object.fromEntries(standaloneUrl.searchParams)));
                response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-frame-options":"DENY"});response.end(standaloneViewPage(rendered));
            }catch(error){response.writeHead(error instanceof AtlasError&&error.code==="NOT_FOUND"?404:400,{"content-type":"text/plain; charset=utf-8"});response.end(error instanceof Error?error.message:"View unavailable.")}return;
        }
        const toolMatch = request.url?.match(/^\/api\/tools\/([a-z_]+)$/);
        if (request.method === "POST" && toolMatch) {
            try {
                const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { bytes += chunk.length; if (workspaceRoute && bytes > 2 * 1024 * 1024) throw new AtlasError("Workspace request exceeds 2 MiB."); chunks.push(Buffer.from(chunk)); }
                const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
                // Monitoring queries use "client" strictly as a user-specified filter;
                // never turn the transport's x-atlas-client attribution into an
                // implicit filter that hides other agents' audit history.
                // Other read-only diagnostics expose strict input schemas.
                if (!Object.hasOwn(nodeSchemas,toolMatch[1]!) && toolMatch[1]!=="execute_view_action" && toolMatch[1]!=="read_server_diagnostics" && toolMatch[1]!=="get_monitoring_health" && toolMatch[1]!=="query_monitoring_activity" && (!Object.hasOwn(workspaceSchemas,toolMatch[1]!) || "client" in workspaceSchemas[toolMatch[1] as WorkspaceToolName].shape) && !input.client && request.headers["x-atlas-client"]) input.client = String(request.headers["x-atlas-client"]);
                const value = await services.dispatch(toolMatch[1]!, input, 'atlas-http');
                response.writeHead(200, { ...cors, "content-type": "application/json" }); response.end(JSON.stringify(value));
            } catch (error) {
                const known = error instanceof AtlasError; response.writeHead(known && error.code === "NOT_FOUND" ? 404 : 400, { ...cors, "content-type": "application/json" });
                response.end(JSON.stringify({ error: known ? error.code : "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error) }));
            }
            return;
        }
        if (request.method === "GET" && request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(await catalog.status())); return; }
        if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(404, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Not found" })); return; }
        // Keep this trace free of credentials, request bodies and tool arguments. It
        // identifies which stage an authenticated request reached if a client gives up.
        const traceId = randomUUID();
        const started = performance.now();
        let stage = 'received';
        let finished = false;
        const trace = (event: string, extra: Record<string, unknown> = {}) => {
            if (config.mcpDiagnostics) console.info(JSON.stringify({ component: 'mcp-http', traceId, event, stage,
                elapsedMs: Math.round(performance.now() - started), ...extra }));
        };
        trace('stage');
        request.once('end', () => trace('request_body_complete'));
        response.once('finish', () => { finished = true; trace('response_finished', { status: response.statusCode }); });
        response.once('close', () => {
            if (!finished) trace('client_disconnected', { status: response.statusCode,
                headersSent: response.headersSent, requestComplete: request.complete });
        });
        // Public ingress MUST fail closed unless OAuth is configured. Local
        // loopback development retains its existing direct MCP behavior.
        if (config.mcpAuth.trustedIngress && !config.mcpAuth.enabled && !config.mcpAuth.relayTokenHash) {
            response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ error: 'MCP_OAUTH_NOT_CONFIGURED' }));
            return;
        }
        // Relay uses a separately configured, high-entropy service token. Human
        // ChatGPT callers continue to use exactly the existing Auth0 OAuth flow.
        const relayAuthenticated = verifyRelayServiceToken(request.headers.authorization, config.mcpAuth.relayTokenHash);
        if (config.mcpAuth.enabled || config.mcpAuth.relayTokenHash) {
            let authenticated = relayAuthenticated;
            stage = 'authenticating'; trace('stage');
            if (!authenticated && config.mcpAuth.enabled) {
                try { authenticated = await mcpVerifier.authenticate(request.headers.authorization); }
                catch {
                    stage = 'auth_provider_unavailable'; trace('stage');
                    response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                    response.end(JSON.stringify({ error: 'MCP_AUTH_PROVIDER_UNAVAILABLE' }));
                    return;
                }
            }
            if (!authenticated) {
                stage = 'auth_rejected'; trace('stage');
                response.writeHead(401, {
                    'content-type': 'application/json', 'cache-control': 'no-store',
                    'www-authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', config.mcpAuth.resource).toString()}", scope="${config.mcpAuth.scope}"`
                });
                response.end(JSON.stringify({ error: 'MCP_UNAUTHORIZED' }));
                return;
            }
            stage = 'authenticated'; trace('stage');
        }
        let server: ReturnType<typeof createMcpTransport> | undefined;
        try {
            stage = 'creating_transport'; trace('stage');
            server = createMcpTransport(services,
                relayAuthenticated ? undefined : config.mcpAuth.enabled ? config.mcpAuth.scope : undefined,
                !relayAuthenticated && config.mcpAuth.enabled ? { kind: 'mcp-oauth', subject: config.mcpAuth.subject, issuer: config.mcpAuth.issuer } : undefined,
                relayAuthenticated ? RELAY_READ_TOOLS : undefined);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            const connectedServer = server;
            response.once('close', () => { void connectedServer.close().catch(() => trace('cleanup_failed')); });
            stage = 'connecting'; trace('stage');
            await server.connect(transport);
            stage = 'handling_request'; trace('stage');
            await transport.handleRequest(request, response);
            stage = 'request_handled'; trace('stage');
        } catch (error) {
            stage = 'request_failed';
            trace('stage', { error: error instanceof Error ? error.name : 'unknown' });
            if (!response.headersSent) {
                response.writeHead(500, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'MCP_REQUEST_FAILED' }));
            } else if (!response.writableEnded) response.end();
            if (server) void server.close().catch(() => trace('cleanup_failed'));
        }
    });
    services.nodeGateway?.attach(http);
    http.on("close", () => { void lifecycle.close().catch(() => console.error("Atlas Server shutdown failed.")); });
    return http;
}
