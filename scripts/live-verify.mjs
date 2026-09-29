import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "atlas-live-verifier", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3000/mcp")));
const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError) throw new Error(`${name}: ${response.content?.[0]?.text}`);
    return response.structuredContent.result;
};
for (const existing of await call("list_projects")) if (existing.name === "Launchpad") await call("archive_project", { projectId: existing.id, client: "live-verifier" });
const project = await call("create_project", { name: "Launchpad", description: "Career launch workspace", client: "live-verifier" });
const store = await call("create_store", { projectId: project.id, name: "Graduate Applications", client: "live-verifier", fields: [
    { name: "company", type: "string", required: true },
    { name: "role", type: "string", required: true },
    { name: "status", type: "enum", required: true, enumValues: ["active", "rejected", "withdrawn"] },
    { name: "stage", type: "string", required: true },
    { name: "appliedAt", type: "date", required: true },
    { name: "oaStatus", type: "enum", required: true, enumValues: ["not_required", "pending", "completed"] },
    { name: "oaCompletedAt", type: "date" },
    { name: "notes", type: "string" }
] });
const lseg = await call("create_record", { projectId: project.id, storeId: store.id, client: "live-verifier", data: { company: "LSEG", role: "Graduate Software Engineer", status: "active", stage: "online assessment", appliedAt: "2026-09-20", oaStatus: "pending" } });
const macquarie = await call("create_record", { projectId: project.id, storeId: store.id, client: "live-verifier", data: { company: "Macquarie", role: "Technology Graduate", status: "active", stage: "application", appliedAt: "2026-09-22", oaStatus: "not_required" } });
const allRecords = await call("list_records", { projectId: project.id, storeId: store.id });
const pending = await call("query_records", { projectId: project.id, storeId: store.id, filters: [{ field: "oaStatus", operator: "eq", value: "pending" }], sort: [{ field: "company", direction: "asc" }] });
const updated = await call("update_record", { projectId: project.id, storeId: store.id, recordId: lseg.id, client: "live-verifier", data: { oaStatus: "completed", oaCompletedAt: "2026-09-29" } });
const audit = await call("get_audit_history", { recordId: lseg.id });
console.log(JSON.stringify({ project, store, lsegCreated: lseg, macquarie, allRecords, pending, lsegUpdated: updated, stableId: lseg.id === updated.id, audit }, null, 2));
await client.close();
