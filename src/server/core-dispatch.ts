import { AuditService } from "../core/audit.js";
import { ActivityService } from "../activity/service.js";
import { workspaceSchemas, type WorkspaceToolName } from "../workspaces/contracts.js";
import type { WorkspaceService } from "../workspaces/application.js";
import type { ViewService } from "../views/service.js";
import type { CoreService } from "../core/service.js";
import { AtlasError } from "../shared/errors.js";

export const atlasToolNames = [
    "list_nodes", "get_node",
    ...Object.keys(workspaceSchemas) as WorkspaceToolName[],
    "get_atlas_status", "list_projects", "get_project", "create_project", "update_project", "archive_project",
    "list_stores", "get_store", "create_store", "update_store", "update_store_schema", "archive_store",
    "create_record", "get_record", "update_record", "archive_record", "bulk_records", "list_records", "query_records",
    "list_views", "get_view", "create_view", "update_view", "archive_view", "render_view", "preview_view", "get_view_history", "execute_view_action",
    "get_audit_history", "get_recent_activity",
] as const;

export type AtlasToolName = typeof atlasToolNames[number];

/** Shared application operations; transport-independent. */
export async function callCoreTool(catalog: CoreService, views: ViewService, workspaces: Pick<WorkspaceService, "call">, name: string, input: any = {}): Promise<unknown> {
    if (Object.hasOwn(workspaceSchemas, name)) return workspaces.call(name as WorkspaceToolName, input);
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
        case "list_views": return views.listViews(input.projectId, input.includeArchived);
        case "get_view": return views.getView(input.projectId, input.viewId, input.includeArchived);
        case "create_view": return views.createView(input);
        case "update_view": return views.updateView(input);
        case "archive_view": return views.archiveView(input.projectId, input.viewId, input.client);
        case "render_view": return views.renderView(input.projectId, input.viewId, input.params);
        case "preview_view": return views.previewView(input);
        case "execute_view_action": return views.executeViewAction(input);
        case "get_view_history": return views.viewHistory(input.projectId,input.viewId);
        case "get_audit_history": return catalog.auditHistory(input);
        case "get_recent_activity": return new ActivityService(new AuditService(catalog.store)).recent(input);
        default: throw new AtlasError(`Unknown Atlas tool '${name}'.`, "NOT_FOUND");
    }
}
