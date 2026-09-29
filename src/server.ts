import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AtlasCatalog, AtlasError } from "./catalog.js";
import { AtlasStore, requireDatabaseUrl } from "./store.js";
import { atlasStatus } from "./status.js";
import { callAtlasTool } from "./tools.js";

const field = z.object({ name: z.string(), type: z.enum(["string", "number", "boolean", "date", "datetime", "enum", "array", "object"]), required: z.boolean().optional(), enumValues: z.array(z.string()).optional(), default: z.unknown().optional(), description: z.string().optional() });
const scope = { projectId: z.string().uuid(), storeId: z.string().uuid() };
const client = { client: z.string().optional() };
const include = { includeArchived: z.boolean().optional() };
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } });

export function createAtlasMcpServer(catalog: AtlasCatalog) {
    const server = new McpServer({ name: atlasStatus.name, version: atlasStatus.version });
    const tool = (name: string, description: string, inputSchema: Record<string, z.ZodType>, handler: (input: any) => Promise<unknown>) => server.registerTool(name, { description, inputSchema }, async (input) => { try { return result(await handler(input)); } catch (error) { const known = error instanceof AtlasError; return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: known ? error.code : "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) }, null, 2) }] }; } });

    tool("get_atlas_status", "Report Atlas availability and structured-data counts.", {}, (x) => callAtlasTool(catalog, "get_atlas_status", x));
    tool("list_projects", "List active projects, optionally including archived projects.", include, (x) => callAtlasTool(catalog, "list_projects", x));
    tool("get_project", "Get one project by stable ID.", { projectId: z.string().uuid(), ...include }, (x) => callAtlasTool(catalog, "get_project", x));
    tool("create_project", "Create a project, the top-level ownership boundary.", { name: z.string(), description: z.string().optional(), ...client }, (x) => callAtlasTool(catalog, "create_project", x));
    tool("update_project", "Update project metadata without changing its stable ID.", { projectId: z.string().uuid(), name: z.string().optional(), description: z.string().nullable().optional(), ...client }, (x) => callAtlasTool(catalog, "update_project", x));
    tool("archive_project", "Archive a project and its active stores and records.", { projectId: z.string().uuid(), ...client }, (x) => callAtlasTool(catalog, "archive_project", x));

    tool("list_stores", "List stores belonging to a project.", { projectId: z.string().uuid(), ...include }, (x) => catalog.listStores(x.projectId, x.includeArchived));
    tool("get_store", "Get one store by project and stable store ID.", { ...scope, ...include }, (x) => catalog.getStore(x.projectId, x.storeId, x.includeArchived));
    tool("create_store", "Create a typed store with an explicit schema.", { projectId: z.string().uuid(), name: z.string(), description: z.string().optional(), fields: z.array(field), ...client }, (x) => catalog.createStore(x));
    tool("update_store", "Update store metadata without changing schema or stable ID.", { ...scope, name: z.string().optional(), description: z.string().nullable().optional(), ...client }, (x) => catalog.updateStore(x));
    tool("update_store_schema", "Atomically replace a store schema; existing records must remain valid. Set dropRemovedFields only for intentional data removal.", { ...scope, fields: z.array(field), dropRemovedFields: z.boolean().optional(), ...client }, (x) => catalog.updateSchema(x));
    tool("archive_store", "Archive a store and its active records.", { ...scope, ...client }, (x) => catalog.archiveStore(x.projectId, x.storeId, x.client));

    tool("create_record", "Create a schema-validated record and return its stable ID.", { ...scope, data: z.record(z.string(), z.unknown()), ...client }, (x) => catalog.createRecord(x));
    tool("get_record", "Get a record by project, store, and stable record ID.", { ...scope, recordId: z.string().uuid(), ...include }, (x) => catalog.getRecord(x.projectId, x.storeId, x.recordId, x.includeArchived));
    tool("update_record", "Patch or replace a record while preserving its stable ID.", { ...scope, recordId: z.string().uuid(), data: z.record(z.string(), z.unknown()), replace: z.boolean().optional(), ...client }, (x) => catalog.updateRecord(x));
    tool("archive_record", "Archive one record by stable ID.", { ...scope, recordId: z.string().uuid(), ...client }, (x) => catalog.archiveRecord(x.projectId, x.storeId, x.recordId, x.client));
    tool("bulk_records", "Atomically create, update, or archive up to 100 records. Inspect the schema and existing records first; any invalid operation rolls back the whole batch.", { ...scope, operations: z.array(z.discriminatedUnion("action", [z.object({ action: z.literal("create"), data: z.record(z.string(), z.unknown()) }), z.object({ action: z.literal("update"), recordId: z.string().uuid(), data: z.record(z.string(), z.unknown()), replace: z.boolean().optional() }), z.object({ action: z.literal("archive"), recordId: z.string().uuid() })])).min(1).max(100), ...client }, (x) => catalog.bulkRecords(x));
    tool("list_records", "List records with deterministic pagination and optional archived records.", { ...scope, limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), ...include }, (x) => catalog.queryRecords(x));
    tool("query_records", "Query a store using typed filters, multi-field sorting, limit, and offset.", { ...scope, filters: z.array(z.object({ field: z.string(), operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"]), value: z.unknown() })).optional(), sort: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), ...include }, (x) => catalog.queryRecords(x));
    const auditInput = { projectId: z.string().uuid().optional(), storeId: z.string().uuid().optional(), recordId: z.string().uuid().optional(), operation: z.enum(["project.created", "project.updated", "project.archived", "store.created", "store.updated", "store.schema_updated", "store.archived", "record.created", "record.updated", "record.archived"]).optional(), limit: z.number().int().min(1).max(200).optional() };
    tool("get_audit_history", "Read immutable audit history filtered by ownership or operation.", auditInput, (x) => catalog.auditHistory(x));
    tool("get_recent_activity", "Read recent mutations across Atlas or within a project/store/record.", auditInput, (x) => catalog.auditHistory(x));
    return server;
}

export function createAtlasHttpServer(options: { databaseUrl?: string } = {}) {
    const repository = new AtlasStore(requireDatabaseUrl(options.databaseUrl));
    const catalog = new AtlasCatalog(repository);
    const http = createServer(async (request: IncomingMessage, response: ServerResponse) => {
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-atlas-client", "access-control-allow-methods": "GET,POST,OPTIONS" };
        if (request.method === "OPTIONS") { response.writeHead(204, cors); response.end(); return; }
        const toolMatch = request.url?.match(/^\/api\/tools\/([a-z_]+)$/);
        if (request.method === "POST" && toolMatch) {
            try {
                const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
                if (!input.client && request.headers["x-atlas-client"]) input.client = String(request.headers["x-atlas-client"]);
                const value = await callAtlasTool(catalog, toolMatch[1], input);
                response.writeHead(200, { ...cors, "content-type": "application/json" }); response.end(JSON.stringify(value));
            } catch (error) {
                const known = error instanceof AtlasError; response.writeHead(known && error.code === "NOT_FOUND" ? 404 : 400, { ...cors, "content-type": "application/json" });
                response.end(JSON.stringify({ error: known ? error.code : "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error) }));
            }
            return;
        }
        if (request.method === "GET" && request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(await catalog.status())); return; }
        if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(404, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Not found" })); return; }
        const server = createAtlasMcpServer(catalog); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on("close", () => { void transport.close(); void server.close(); });
        try { await server.connect(transport); await transport.handleRequest(request, response); }
        catch (error) { if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" }); if (!response.writableEnded) response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
    });
    http.on("close", () => { void repository.close(); });
    return http;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const host = process.env.ATLAS_HOST ?? "127.0.0.1"; const port = Number(process.env.ATLAS_PORT ?? 3000);
    const databaseUrl=requireDatabaseUrl(); const probe=new AtlasStore(databaseUrl);
    try { await probe.snapshot(); } catch(error) { console.error(`Atlas cannot connect to its migrated PostgreSQL database: ${error instanceof Error?error.message:String(error)}`); process.exit(1); } finally { await probe.close(); }
    createAtlasHttpServer({ databaseUrl }).listen(port, host, () => console.log(`Atlas PostgreSQL MCP listening on http://${host}:${port}/mcp`));
}
