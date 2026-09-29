import { AtlasCatalog, AtlasError } from "./catalog.js";

export const atlasToolNames = [
    "get_atlas_status", "list_projects", "get_project", "create_project", "update_project", "archive_project",
    "list_stores", "get_store", "create_store", "update_store", "update_store_schema", "archive_store",
    "create_record", "get_record", "update_record", "archive_record", "bulk_records", "list_records", "query_records",
    "get_audit_history", "get_recent_activity",
] as const;

export type AtlasToolName = typeof atlasToolNames[number];

/** Shared dispatch for MCP and the Observatory's HTTP bridge. */
export async function callAtlasTool(catalog: AtlasCatalog, name: string, input: any = {}): Promise<unknown> {
    switch (name as AtlasToolName) {
        case "get_atlas_status": return catalog.status();
        case "list_projects": return catalog.listProjects(input.includeArchived);
        case "get_project": return catalog.getProject(input.projectId, input.includeArchived);
        case "create_project": return catalog.createProject(input);
        case "update_project": return catalog.updateProject(input);
        case "archive_project": return catalog.archiveProject(input.projectId, input.client);
        case "list_stores": return catalog.listStores(input.projectId, input.includeArchived);
        case "get_store": return catalog.getStore(input.projectId, input.storeId, input.includeArchived);
        case "create_store": return catalog.createStore(input);
        case "update_store": return catalog.updateStore(input);
        case "update_store_schema": return catalog.updateSchema(input);
        case "archive_store": return catalog.archiveStore(input.projectId, input.storeId, input.client);
        case "create_record": return catalog.createRecord(input);
        case "get_record": return catalog.getRecord(input.projectId, input.storeId, input.recordId, input.includeArchived);
        case "update_record": return catalog.updateRecord(input);
        case "archive_record": return catalog.archiveRecord(input.projectId, input.storeId, input.recordId, input.client);
        case "bulk_records": return catalog.bulkRecords(input);
        case "list_records": return catalog.queryRecords(input);
        case "query_records": return catalog.queryRecords(input);
        case "get_audit_history": return catalog.auditHistory(input);
        case "get_recent_activity": return catalog.auditHistory(input);
        default: throw new AtlasError(`Unknown Atlas tool '${name}'.`, "NOT_FOUND");
    }
}
