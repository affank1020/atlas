import { nodeSchemas } from '../../nodes/contracts.js';
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { workspaceSchemas, type WorkspaceToolName } from "../../workspaces/contracts.js";
import { AtlasError } from "../../shared/errors.js";
import { standaloneViewPage } from "../../view-standalone.js";
import { verifyContentfulWebhook } from "../../integrations/contentful.js";
import type { ServerServices } from "../../server/composition.js";
import { createMcpTransport } from "../mcp/index.js";
export function createHttpTransport(services: ServerServices) {
    const { catalog, askPortfolio, contentful, portfolio, media, lifecycle, config } = services;
    const http = createServer(async (request: IncomingMessage, response: ServerResponse) => {
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-atlas-client", "access-control-allow-methods": "GET,POST,OPTIONS" };
        // Opaque-origin View frames must never invoke privileged HTTP/MCP endpoints,
        // even if a future browser/runtime regression bypasses their connect-src policy.
        if(request.method === "POST" && request.headers.origin === "null") {
            response.writeHead(403,{"content-type":"application/json"}); response.end(JSON.stringify({error:"VIEW_ORIGIN_DENIED",message:"Sandboxed Views cannot call Atlas APIs."})); return;
        }
        // Workspace access must not be callable by arbitrary web origins. Native MCP
        // clients omit Origin; Observatory uses an explicitly trusted local origin.
        const workspaceRoute = /^\/api\/tools\/(?:.*workspace.*|unity_.*|list_nodes|get_node)$/.test(request.url ?? "");
        if ((workspaceRoute || request.url === "/mcp") && request.headers.origin && request.headers.origin !== "null") {
            const allowedOrigins = config.workspace.origins;
            if (!allowedOrigins.includes(request.headers.origin)) { response.writeHead(403,{"content-type":"application/json"}); response.end(JSON.stringify({error:"ORIGIN_DENIED",message:"Origin is not approved for workspace access."})); return; }
        }
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
            try{const view=await services.views.getViewBySlug(standaloneMatch[1]!,standaloneMatch[2]!);const rendered=await services.views.renderView(view.projectId,view.id,Object.fromEntries(standaloneUrl.searchParams));
                response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-frame-options":"DENY"});response.end(standaloneViewPage(rendered));
            }catch(error){response.writeHead(error instanceof AtlasError&&error.code==="NOT_FOUND"?404:400,{"content-type":"text/plain; charset=utf-8"});response.end(error instanceof Error?error.message:"View unavailable.")}return;
        }
        const toolMatch = request.url?.match(/^\/api\/tools\/([a-z_]+)$/);
        if (request.method === "POST" && toolMatch) {
            try {
                const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { bytes += chunk.length; if (workspaceRoute && bytes > 2 * 1024 * 1024) throw new AtlasError("Workspace request exceeds 2 MiB."); chunks.push(Buffer.from(chunk)); }
                const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
                if (!Object.hasOwn(nodeSchemas,toolMatch[1]!) && toolMatch[1]!=="execute_view_action" && (!Object.hasOwn(workspaceSchemas,toolMatch[1]!) || "client" in workspaceSchemas[toolMatch[1] as WorkspaceToolName].shape) && !input.client && request.headers["x-atlas-client"]) input.client = String(request.headers["x-atlas-client"]);
                const value = await services.dispatch(toolMatch[1]!, input);
                response.writeHead(200, { ...cors, "content-type": "application/json" }); response.end(JSON.stringify(value));
            } catch (error) {
                const known = error instanceof AtlasError; response.writeHead(known && error.code === "NOT_FOUND" ? 404 : 400, { ...cors, "content-type": "application/json" });
                response.end(JSON.stringify({ error: known ? error.code : "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error) }));
            }
            return;
        }
        if (request.method === "GET" && request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(await catalog.status())); return; }
        if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(404, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Not found" })); return; }
        const server = createMcpTransport(services); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on("close", () => { void transport.close(); void server.close(); });
        try { await server.connect(transport); await transport.handleRequest(request, response); }
        catch (error) { if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" }); if (!response.writableEnded) response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
    });
    http.on("close", () => { void lifecycle.close().catch(() => console.error("Atlas Server shutdown failed.")); });
    return http;
}
