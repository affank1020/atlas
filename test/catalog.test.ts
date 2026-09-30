import assert from "node:assert/strict";
import test, { after } from "node:test";
import { AtlasError } from "../src/catalog.js";
import { cleanupDatabases, databaseFixture } from "./database.js";

const fixture = databaseFixture;
after(cleanupDatabases);
const fields = [
    { name: "company", type: "string" as const, required: true },
    { name: "status", type: "enum" as const, enumValues: ["pending", "submitted", "rejected"], default: "pending" },
    { name: "score", type: "number" as const },
];

test("structured lifecycle preserves IDs, validates, queries, audits, and persists", async () => {
    const { catalog, store: repository } = await fixture();
    const project = await catalog.createProject({ name: "Launchpad", client: "test" });
    const store = await catalog.createStore({ projectId: project.id, name: "Graduate Applications", fields, client: "test" });
    const lseg = await catalog.createRecord({ projectId: project.id, storeId: store.id, data: { company: "LSEG", score: 8 }, client: "test" });
    await catalog.createRecord({ projectId: project.id, storeId: store.id, data: { company: "Macquarie", status: "submitted", score: 7 }, client: "test" });
    assert.equal((await catalog.queryRecords({ projectId: project.id, storeId: store.id, filters: [{ field: "status", operator: "eq", value: "pending" }] })).items[0]?.id, lseg.id);
    const updated = await catalog.updateRecord({ projectId: project.id, storeId: store.id, recordId: lseg.id, data: { status: "submitted" }, client: "test" });
    assert.equal(updated.id, lseg.id); assert.equal(updated.data.company, "LSEG");
    await assert.rejects(() => catalog.createRecord({ projectId: project.id, storeId: store.id, data: { company: "Bad", status: "unknown" }, client: "test" }), AtlasError);
    const audit = await catalog.auditHistory({ recordId: lseg.id }); assert.deepEqual(audit.map((x) => x.operation), ["record.updated", "record.created"]);
    assert.equal((await catalog.getRecord(project.id, store.id, lseg.id)).data.status, "submitted");
    await repository.close();
});

test("schema evolution is atomic and requires explicit removal", async () => {
    const { catalog } = await fixture(); const project = await catalog.createProject({ name: "P" }); const store = await catalog.createStore({ projectId: project.id, name: "S", fields });
    await catalog.createRecord({ projectId: project.id, storeId: store.id, data: { company: "LSEG" } });
    await assert.rejects(() => catalog.updateSchema({ projectId: project.id, storeId: store.id, fields: fields.filter((x) => x.name !== "company") }), /removes field/);
    assert.equal((await catalog.getStore(project.id, store.id)).schema.version, 1);
    const evolved = await catalog.updateSchema({ projectId: project.id, storeId: store.id, fields: [...fields, { name: "owner", type: "string", default: "unassigned" }] });
    assert.equal(evolved.schema.version, 2); assert.equal((await catalog.queryRecords({ projectId: project.id, storeId: store.id })).items[0]?.data.owner, "unassigned");
});

test("project ownership boundaries reject cross-project store access", async () => {
    const { catalog } = await fixture(); const one = await catalog.createProject({ name: "One" }); const two = await catalog.createProject({ name: "Two" }); const store = await catalog.createStore({ projectId: one.id, name: "S", fields });
    await assert.rejects(() => catalog.getStore(two.id, store.id), /not found in project/);
});

test("project and store updates and archives obey active visibility", async () => {
    const { catalog } = await fixture(); const project = await catalog.createProject({ name: "Original" }); const renamed = await catalog.updateProject({ projectId: project.id, name: "Renamed" }); assert.equal(renamed.id, project.id);
    const store = await catalog.createStore({ projectId: project.id, name: "Original store", fields }); const updated = await catalog.updateStore({ projectId: project.id, storeId: store.id, name: "Updated store" }); assert.equal(updated.id, store.id);
    const record = await catalog.createRecord({ projectId: project.id, storeId: store.id, data: { company: "A" } }); await catalog.archiveRecord(project.id, store.id, record.id); assert.equal((await catalog.queryRecords({ projectId: project.id, storeId: store.id })).total, 0); assert.equal((await catalog.queryRecords({ projectId: project.id, storeId: store.id, includeArchived: true })).total, 1);
    await catalog.archiveStore(project.id, store.id); assert.equal((await catalog.listStores(project.id)).length, 0); assert.equal((await catalog.listStores(project.id, true)).length, 1);
    await catalog.archiveProject(project.id); assert.equal((await catalog.listProjects()).length, 0); assert.equal((await catalog.listProjects(true)).length, 1);
});

test("status distinguishes active, archived, and total canonical counts",async()=>{const {catalog}=await fixture();const project=await catalog.createProject({name:"Counts"});const store=await catalog.createStore({projectId:project.id,name:"Records",fields});const first=await catalog.createRecord({projectId:project.id,storeId:store.id,data:{company:"Active"}});const second=await catalog.createRecord({projectId:project.id,storeId:store.id,data:{company:"Archived"}});await catalog.archiveRecord(project.id,store.id,second.id);const status=await catalog.status();assert.equal(status.records,1);assert.deepEqual(status.counts.records,{active:1,archived:1,total:2});assert.equal((await catalog.getRecord(project.id,store.id,first.id)).id,first.id);});

test("sorting, pagination, invalid IDs, and atomic bulk operations are deterministic", async () => {
    const { catalog } = await fixture(); const project = await catalog.createProject({ name: "P" }); const store = await catalog.createStore({ projectId: project.id, name: "S", fields });
    const bulk = await catalog.bulkRecords({ projectId: project.id, storeId: store.id, operations: [{ action: "create", data: { company: "C", score: 3 } }, { action: "create", data: { company: "A", score: 1 } }, { action: "create", data: { company: "B", score: 2 } }] }); assert.equal(bulk.results.length, 3);
    const page = await catalog.queryRecords({ projectId: project.id, storeId: store.id, sort: [{ field: "score", direction: "desc" }], limit: 1, offset: 1 }); assert.equal(page.total, 3); assert.equal(page.items[0]?.data.company, "B");
    await assert.rejects(() => catalog.getRecord(project.id, store.id, "not-an-id"), /not found/);
    await assert.rejects(() => catalog.bulkRecords({ projectId: project.id, storeId: store.id, operations: [{ action: "update", recordId: bulk.results[0]!.id, data: { score: 4 } }, { action: "create", data: { company: "Invalid", score: "bad" } }] }), /must be a valid number/);
    assert.equal((await catalog.getRecord(project.id, store.id, bulk.results[0]!.id)).data.score, 3);
});

test("all query operators preserve typed behavior and reject field injection", async () => {
    const { catalog } = await fixture(); const project=await catalog.createProject({name:"Queries"}); const store=await catalog.createStore({projectId:project.id,name:"Items",fields:[...fields,{name:"tags",type:"array"},{name:"due",type:"date"}]});
    await catalog.bulkRecords({projectId:project.id,storeId:store.id,operations:[
        {action:"create",data:{company:"Alpha",score:1,status:"pending",tags:["red"],due:"2026-01-01"}},
        {action:"create",data:{company:"Beta",score:2,status:"submitted",tags:["blue","red"],due:"2026-02-01"}},
        {action:"create",data:{company:"Gamma",score:3,status:"rejected",tags:[],due:"2026-03-01"}},
    ]});
    const count=async(operator:any,value:unknown,field="score")=>(await catalog.queryRecords({projectId:project.id,storeId:store.id,filters:[{field,operator,value}]})).total;
    assert.equal(await count("eq",2),1); assert.equal(await count("neq",2),2); assert.equal(await count("gt",1),2); assert.equal(await count("gte",2),2); assert.equal(await count("lt",3),2); assert.equal(await count("lte",2),2); assert.equal(await count("in",[1,3]),2); assert.equal(await count("contains","red","tags"),2); assert.equal(await count("gt","2026-01-15","due"),2);
    await assert.rejects(()=>catalog.queryRecords({projectId:project.id,storeId:store.id,filters:[{field:"company') OR true --",operator:"eq",value:"Alpha"}]}),/Unknown filter field/);
});

test("failed bulk writes neither partial records nor audit events", async()=>{
    const {catalog}=await fixture(); const project=await catalog.createProject({name:"Atomic"}); const store=await catalog.createStore({projectId:project.id,name:"Items",fields}); const before=(await catalog.auditHistory({storeId:store.id})).length;
    await assert.rejects(()=>catalog.bulkRecords({projectId:project.id,storeId:store.id,operations:[{action:"create",data:{company:"Good"}},{action:"create",data:{company:"Bad",score:"invalid"}}],client:"rollback-test"}));
    assert.equal((await catalog.queryRecords({projectId:project.id,storeId:store.id})).total,0); assert.equal((await catalog.auditHistory({storeId:store.id})).length,before);
});
