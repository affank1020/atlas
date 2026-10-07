import { nodeSchemas, type NodeToolName } from '../../nodes/contracts.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { workspaceSchemas, workspaceDescriptions, type WorkspaceToolName } from "../../workspaces/contracts.js";
import { viewActionSchema, executeActionSchema } from "../../view-actions.js";
import { viewManifestSchema } from "../../views.js";
import { askAtlasInputSchema } from "../../ai/ask-atlas/input.js";
import { AtlasError } from "../../shared/errors.js";
import { atlasStatus } from "../../status.js";
import { fabricSearchSchema, fabricContextSchema } from "../../retrieval/input.js";
import { PORTFOLIO_CONTENT_TYPES } from "../../portfolio/index.js";
import type { TransportServices } from "../../server/dispatch.js";
const field = z.object({ name: z.string(), type: z.enum(["string", "number", "boolean", "date", "datetime", "enum", "array", "object"]), required: z.boolean().optional(), enumValues: z.array(z.string()).optional(), default: z.unknown().optional(), description: z.string().optional() });
const scope = { projectId: z.string().uuid(), storeId: z.string().uuid() };
const client = { client: z.string().optional() };
const include = { includeArchived: z.boolean().optional() };
const viewQuery = z.object({ name: z.string(), storeId: z.string().uuid(), filters: z.array(z.object({ field: z.string(), operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"]), value: z.unknown() })).optional(), sort: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(), limit: z.number().int().min(1).max(100).optional() });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } });

export function createMcpTransport(services: TransportServices) {
    const { portfolio, media } = services;
    const server = new McpServer({ name: atlasStatus.name, version: atlasStatus.version });
    const tool = (name: string, description: string, inputSchema: Record<string, z.ZodType>) => server.registerTool(name, { description, inputSchema }, async (input) => { try { return result(await services.dispatch(name, Object.hasOwn(workspaceSchemas, name) && "client" in workspaceSchemas[name as WorkspaceToolName].shape ? { ...input, client: input.client ?? server.server.getClientVersion()?.name ?? "mcp-client" } : input)); } catch (error) { const known = error instanceof AtlasError; return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: known ? error.code : "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) }, null, 2) }] }; } });

    for (const name of Object.keys(workspaceSchemas) as WorkspaceToolName[]) tool(name, workspaceDescriptions[name], workspaceSchemas[name].shape);

    const nodeDescriptions: Record<NodeToolName, string> = {
        list_nodes: 'List persistent Nodes with live status, capabilities, credential state and Workspace counts.',
        get_node: 'Inspect one Node, its assigned Workspaces and recent activity without exposing credentials.',
        create_node_enrolment: 'Issue a one-use Node enrolment token valid for ten minutes.',
        update_node: 'Rename a persistent Node.',
        rotate_node_credential: 'Invalidate a Node credential and issue a one-use reenrolment token. Disconnects the Node.',
        revoke_node: 'Revoke a Node credential and disconnect it. Assigned Workspaces stay placed.',
        assign_workspace_node: 'Move an active Workspace to an enrolled Node if its current placement matches expectedNodeId.',
    };
    for (const name of Object.keys(nodeSchemas) as NodeToolName[]) tool(name, nodeDescriptions[name], nodeSchemas[name].shape);

    tool("get_atlas_status", "Report Atlas availability and structured-data counts.", {});
    tool("list_projects", "List active projects, optionally including archived projects.", include);
    tool("get_project", "Get one project by stable ID.", { projectId: z.string().uuid(), ...include });
    tool("create_project", "Create a project, the top-level ownership boundary.", { name: z.string(), description: z.string().optional(), ...client });
    tool("update_project", "Update project metadata without changing its stable ID.", { projectId: z.string().uuid(), name: z.string().optional(), description: z.string().nullable().optional(), ...client });
    tool("archive_project", "Archive a project and its active stores and records.", { projectId: z.string().uuid(), ...client });

    tool("list_stores", "List stores belonging to a project.", { projectId: z.string().uuid(), ...include });
    tool("get_store", "Get one store by project and stable store ID.", { ...scope, ...include });
    tool("create_store", "Create a typed store with an explicit schema.", { projectId: z.string().uuid(), name: z.string(), description: z.string().optional(), fields: z.array(field), ...client });
    tool("update_store", "Update store metadata without changing schema or stable ID.", { ...scope, name: z.string().optional(), description: z.string().nullable().optional(), ...client });
    tool("update_store_schema", "Atomically replace a store schema; existing records must remain valid. Set dropRemovedFields only for intentional data removal.", { ...scope, fields: z.array(field), dropRemovedFields: z.boolean().optional(), ...client });
    tool("archive_store", "Archive a store and its active records.", { ...scope, ...client });

    tool("create_record", "Create a schema-validated record and return its stable ID.", { ...scope, data: z.record(z.string(), z.unknown()), ...client });
    tool("get_record", "Get a record by project, store, and stable record ID.", { ...scope, recordId: z.string().uuid(), ...include });
    tool("update_record", "Patch or replace a record while preserving its stable ID.", { ...scope, recordId: z.string().uuid(), data: z.record(z.string(), z.unknown()), replace: z.boolean().optional(), ...client });
    tool("archive_record", "Archive one record by stable ID.", { ...scope, recordId: z.string().uuid(), ...client });
    tool("bulk_records", "Atomically create, update, or archive up to 100 records. Inspect the schema and existing records first; any invalid operation rolls back the whole batch.", { ...scope, operations: z.array(z.discriminatedUnion("action", [z.object({ action: z.literal("create"), data: z.record(z.string(), z.unknown()) }), z.object({ action: z.literal("update"), recordId: z.string().uuid(), data: z.record(z.string(), z.unknown()), replace: z.boolean().optional() }), z.object({ action: z.literal("archive"), recordId: z.string().uuid() })])).min(1).max(100), ...client });
    tool("list_records", "List records with deterministic pagination and optional archived records.", { ...scope, limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), ...include });
    tool("query_records", "Query a store using typed filters, multi-field sorting, limit, and offset.", { ...scope, filters: z.array(z.object({ field: z.string(), operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"]), value: z.unknown() })).optional(), sort: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), ...include });
    const viewAuthoring = "Use Atlas View Kit v1 components where suitable and --atlas-* design tokens. Use semantic, responsive, accessible HTML and graceful empty/missing states. Prefer built-in atlas-table sorting/search and atlas-tabs; keep CSS and script specific to the View. Safe external links are supported as <a href=\"https://...\"> or <a href=\"http://...\">; Atlas opens them in a new tab with rel=\"noopener noreferrer\". No external assets, dependencies, direct network or arbitrary navigation. V3 supports only persisted declared record.update/record.create actions with record-actions capability; fields and fixedData are enforced by Core. Declare client-script for custom JS; declare url-params and a params map for bookmarkable state. Scripts use atlas.data, atlas.params, atlas.onReady, atlas.setParam, atlas.action(name,{recordId,data}) and atlas.refresh(). Query rows retain existing fields plus _atlas.id and _atlas.storeId. Refresh rerenders the same saved definition with fresh Core data. Active slugs have /projects/:projectId/views/:slug standalone URLs. Scripts run only in an isolated iframe. Use preview_view before saving. template is an alias for legacy html; existing callers remain supported.";
    const definition = {queries:z.array(viewQuery),html:z.string().optional(),template:z.string().optional(),css:z.string(),manifest:viewManifestSchema.optional(),script:z.string().optional(),actions:z.array(viewActionSchema).max(32).optional()};
    const params = z.record(z.string(),z.string()).optional();
    tool("list_views","List persistent Views belonging to a project.",{projectId:z.string().uuid(),...include});
    tool("get_view","Get a saved View definition including manifest, html template, CSS and script.",{projectId:z.string().uuid(),viewId:z.string().uuid(),...include});
    tool("create_view",`Create a persistent View. ${viewAuthoring}`,{projectId:z.string().uuid(),name:z.string(),slug:z.string().optional(),description:z.string().optional(),...definition,...client});
    tool("update_view",`Update a View while preserving its ID, URL and audit revisions. ${viewAuthoring}`,{projectId:z.string().uuid(),viewId:z.string().uuid(),name:z.string().optional(),slug:z.string().nullable().optional(),description:z.string().nullable().optional(),queries:z.array(viewQuery).optional(),html:z.string().optional(),template:z.string().optional(),css:z.string().optional(),manifest:viewManifestSchema.nullable().optional(),script:z.string().optional(),actions:z.array(viewActionSchema).max(32).optional(),expectedUpdatedAt:z.string().optional(),...client});
    tool("archive_view","Archive a View.",{projectId:z.string().uuid(),viewId:z.string().uuid(),...client});
    tool("render_view","Render a saved View against current Core records. Returns data, HTML, CSS and an isolated iframe document; never insert the document into a privileged DOM.",{projectId:z.string().uuid(),viewId:z.string().uuid(),params});
    tool("preview_view",`Validate and render an unsaved definition without writes. ${viewAuthoring}`,{projectId:z.string().uuid(),...definition,params});
    tool("get_view_history","Read saved View revisions from immutable audit before/after snapshots, including manifest and script.",{projectId:z.string().uuid(),viewId:z.string().uuid()});
    tool("execute_view_action","Execute only a persisted declared View action through Core schema validation and audit. No arbitrary Store/field overrides. Actions are durable before success is returned.",executeActionSchema.shape);
    const auditInput = { workspaceId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), storeId: z.string().uuid().optional(), recordId: z.string().uuid().optional(), operation: z.enum(["workspace.file_listed", "workspace.file_read", "workspace.files_searched", "workspace.git_status", "workspace.git_diff", "workspace.unity_status", "workspace.unity_commands", "workspace.created", "workspace.updated", "workspace.archived", "workspace.file_created", "workspace.file_patched", "workspace.file_deleted", "workspace.unity_invoked", "workspace.dev_invoked", "workspace.dev_tasks_listed", "workspace.dev_tasks_configured", "workspace.mutation_requested", "workspace.mutation_failed", "project.created", "project.updated", "project.archived", "store.created", "store.updated", "store.schema_updated", "store.archived", "record.created", "record.updated", "record.archived", "view.created", "view.updated", "view.archived"]).optional(), limit: z.number().int().min(1).max(200).optional() };
    tool("get_audit_history", "Read immutable audit history filtered by ownership or operation.", auditInput);
    tool("get_recent_activity", "Read recent Atlas activity, including workspace inspections and mutations, optionally scoped to a project, workspace, store or record.", auditInput);
    tool("search_atlas", "Search active Atlas records using lexical, semantic, or hybrid retrieval.", fabricSearchSchema.shape);
    tool("request_context", "Retrieve a bounded, authority-aware Atlas evidence pack.", fabricContextSchema.shape);
    tool("ask_atlas", "Chat about Atlas records using fresh evidence and optional conversation history.", askAtlasInputSchema.shape);
    tool("ask_portfolio", "Chat about the public portfolio corpus. Scope is fixed server-side and cannot be widened by callers.", askAtlasInputSchema.shape);
    tool("get_contentful_status", "Report the Contentful portfolio integration and derived Fabric corpus status.", {});
    tool("sync_portfolio", "Fully reconcile the published Contentful portfolio corpus into Fabric.", {});
    if (portfolio && media) {
        const contentType = z.enum(Object.keys(PORTFOLIO_CONTENT_TYPES) as [keyof typeof PORTFOLIO_CONTENT_TYPES, ...(keyof typeof PORTFOLIO_CONTENT_TYPES)[]]);
        tool("get_portfolio_dashboard", "Read Portfolio draft, publication, and media counts.", {});
        tool("get_portfolio_schemas", "List the canonical Portfolio content types and fields.", {});
        tool("list_portfolio_entries", "List Portfolio drafts and publication state.", { contentType: contentType.optional() });
        tool("get_portfolio_entry", "Read one Portfolio draft and its publication state.", { recordId: z.string().uuid() });
        tool("save_portfolio_draft", "Create or replace a Portfolio draft. This never publishes it.", { contentType, recordId: z.string().uuid().optional(), data: z.record(z.string(), z.unknown()), ...client });
        tool("publish_portfolio_entry", "Validate and explicitly publish an immutable Portfolio revision.", { recordId: z.string().uuid(), ...client });
        tool("unpublish_portfolio_entry", "Remove an entry from the public Portfolio corpus without deleting its draft.", { recordId: z.string().uuid() });
        tool("archive_portfolio_entry", "Archive a Portfolio draft and remove it from publication.", { recordId: z.string().uuid(), ...client });
        tool("list_portfolio_revisions", "List immutable publication revisions for a Portfolio entry.", { recordId: z.string().uuid() });
        tool("restore_portfolio_revision", "Copy an immutable revision back into the editable draft without publishing it.", { recordId: z.string().uuid(), revisionId: z.string().uuid(), ...client });
        tool("rebuild_portfolio_index", "Fully reconcile published Portfolio revisions into Fabric.", {});
        tool("list_portfolio_media", "List Portfolio media metadata and local delivery URLs.", {});
        tool("upload_portfolio_media", "Upload an image or PDF as base64; images receive thumbnail and preview variants.", { fileName: z.string().min(1), mimeType: z.string(), base64: z.string().min(1), altText: z.string().optional(), caption: z.string().optional(), ...client });
        tool("update_portfolio_media", "Update media alt text, caption, or archive state.", { assetId: z.string().uuid(), altText: z.string().nullable().optional(), caption: z.string().nullable().optional(), status: z.enum(["active","archived"]).optional() });
    }
    return server;
}

