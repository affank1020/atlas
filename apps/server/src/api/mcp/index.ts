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
import { globalSearchInput } from "../../server/global-search.js";
import type { TransportServices } from "../../server/dispatch.js";
const field = z.object({ name: z.string(), type: z.enum(["string", "number", "boolean", "date", "datetime", "enum", "array", "object"]), required: z.boolean().optional(), enumValues: z.array(z.string()).optional(), default: z.unknown().optional(), description: z.string().optional() });
const scope = { projectId: z.string().uuid(), storeId: z.string().uuid() };
const client = { client: z.string().optional() };
const include = { includeArchived: z.boolean().optional() };
const viewQuery = z.object({ name: z.string(), storeId: z.string().uuid(), filters: z.array(z.object({ field: z.string(), operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"]), value: z.unknown() })).optional(), sort: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(), limit: z.number().int().min(1).max(100).optional() });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } });

export function createMcpTransport(services: TransportServices, oauthScope?: string) {
    const server = new McpServer({ name: atlasStatus.name, version: atlasStatus.version });
    const tool = (name: string, description: string, inputSchema: Record<string, z.ZodType>) => server.registerTool(name,
      { description, inputSchema, ...(oauthScope ? { securitySchemes: [{ type: 'oauth2' as const, scopes: [oauthScope] }] } : {}) },
      async (input) => { try { return result(await services.dispatch(name, Object.hasOwn(workspaceSchemas, name) && "client" in workspaceSchemas[name as WorkspaceToolName].shape ? { ...input, client: input.client ?? server.server.getClientVersion()?.name ?? "mcp-client" } : input, 'atlas-mcp')); } catch (error) { const known = error instanceof AtlasError; return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: known ? error.code : "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) }, null, 2) }] }; } });

    // ChatGPT connectors may expose only a bounded prefix of the MCP tool catalogue.
    // Register the active generalist evaluation flow first, without bypassing the
    // existing Application input validation, project/Node routing or audit trail.
    // These are the SAME registry tools, not a second execution path.
    const appTools = services.applications.tools();
    const priorityNames = [
        'football_generalist_evaluate',
        'football_generalist_baseline',
        'football_generalist_status',
        'football_generalist_evaluation_detail',
        'football_generalist_policies',
        'football_generalist_assessments',
    ];
    const prioritized = new Set(priorityNames);
    for (const name of priorityNames) {
        const definition = appTools.find(candidate => candidate.name === name);
        if (!definition) throw new Error(`Required generalist MCP tool missing from Application registry: ${name}`);
        tool(definition.name, definition.description, definition.inputSchema);
    }

    for (const name of Object.keys(workspaceSchemas) as WorkspaceToolName[]) tool(name, workspaceDescriptions[name], workspaceSchemas[name].shape);

    const nodeDescriptions: Record<NodeToolName, string> = {
        list_nodes: 'List persistent Nodes with live status, capabilities, credential state and Workspace counts.',
        list_node_share_approvals: 'List approved directional text-sharing pairs; environment grants are read-only.',
        update_node_share_approval: 'Approve or revoke directional Node text sharing, requiring active credentials on approval.',
        list_node_releases: 'Discover verified, published macOS and Linux Node releases; no deployment is performed.',
        plan_node_update: 'Read-only compatibility and provenance preflight for one Linux Node. NEVER installs, restarts or authorises a Node update.',
        prepare_node_update: 'Record an expiring, NON-EXECUTABLE Linux Node update request after a fresh immutable-release preflight. Does not approve, install or restart any Node.',
        list_node_update_intents: 'Read pending and historical Linux Node update intentions. These are not executable jobs or privileged approvals.',
        cancel_node_update_intent: 'Cancel a pending Linux Node update request. No update operation is started.',
        get_node: 'Inspect one Node, its assigned Workspaces and recent activity without exposing credentials.',
        read_node_logs: 'Read a bounded, redacted tail from a connected Node: macOS stdout/stderr or the fixed Linux atlas-node.service journal. Defaults follow the selected Node platform. No paths or shell commands.',
        create_node_enrolment: 'Issue a one-use Node enrolment token valid for ten minutes.',
        update_node: 'Rename a persistent Node.',
        rotate_node_credential: 'Invalidate a Node credential and issue a one-use reenrolment token. Disconnects the Node.',
        revoke_node: 'Revoke a Node credential and disconnect it. Assigned Workspaces stay placed.',
        assign_workspace_node: 'Move an active Workspace to an enrolled Node if its current placement matches expectedNodeId.',
    };
    for (const name of Object.keys(nodeSchemas) as NodeToolName[]) tool(name, nodeDescriptions[name], nodeSchemas[name].shape);

    tool("get_monitoring_health", "Read a bounded live Atlas Server database probe and Node connectivity/heartbeat health snapshot. No CPU, disk or external-service monitoring; no credentials or logs.", {});
    tool("read_server_diagnostics", "Read bounded, non-sensitive Atlas Server process diagnostics since the current restart, not Docker stdout/stderr or retained container logs.", {
        limit: z.number().int().min(1).max(100).default(30),
    });
    tool("get_atlas_status", "Report Atlas availability and structured-data counts.", {});
    tool("get_storage_usage", "Read PostgreSQL storage sizes and Cloudflare R2 analytics without credentials.", { refresh: z.boolean().optional() });
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
    tool("query_monitoring_activity", "Read immutable Atlas audit activity with server-side filters. Opt in to correlation-aware operation pagination; a grouped page returns bounded representative request/result/failure audit events.", {
        projectId: z.string().uuid().optional(), workspaceId: z.string().uuid().optional(), checkoutId: z.string().uuid().optional(),
        storeId: z.string().uuid().optional(), recordId: z.string().uuid().optional(), nodeId: z.string().uuid().optional(),
        operation: z.string().max(120).optional(), category: z.enum(['core','view','node','workspace','files','git','dev','unity']).optional(),
        client: z.string().max(200).optional(), outcome: z.enum(['completed','pending','failed']).optional(),
        search: z.string().max(200).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).max(10000).default(0),
        groupOperations: z.boolean().optional(),
        safeDetails: z.boolean().optional(),
    });
    tool("search_atlas", "Search active Atlas records using lexical, semantic, or hybrid retrieval.", fabricSearchSchema.shape);
    tool("search_everything", "Search active Atlas projects, applications, views, stores, record contents, nodes and workspaces. Read-only, with links and partial-coverage diagnostics.", globalSearchInput.shape);
    tool("request_context", "Retrieve a bounded, authority-aware Atlas evidence pack.", fabricContextSchema.shape);
    tool("ask_atlas", "Chat about Atlas records using fresh evidence and optional conversation history.", askAtlasInputSchema.shape);
    tool('list_applications', 'List launchable first-party Applications in a Project.', { projectId: z.string().uuid() });
    tool('list_all_applications', 'List launchable first-party Applications across Atlas, including standalone Applications.', {});
    tool('get_application', 'Get a registered Application manifest by its optional Project and slug.', { projectId: z.string().uuid().optional(), slug: z.string() });
    for (const definition of appTools) {
        if (!prioritized.has(definition.name)) tool(definition.name, definition.description, definition.inputSchema);
    }
    return server;
}

