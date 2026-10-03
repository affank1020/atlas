import assert from "node:assert/strict";
import test, { after } from "node:test";
import { AtlasCatalog, AtlasError } from "../src/catalog.js";
import { cleanupDatabases, databaseFixture } from "./database.js";

after(cleanupDatabases);
const fields = [
    { name: "company", type: "string" as const, required: true },
    { name: "role", type: "string" as const, required: true },
    { name: "status", type: "enum" as const, enumValues: ["draft", "submitted", "interview"] },
    { name: "score", type: "number" as const },
    { name: "active", type: "boolean" as const },
];

test("View lifecycle persists stable IDs, renders loops and conditionals, and audits mutations", async () => {
    const { catalog, store } = await databaseFixture();
    const project = await catalog.createProject({ name: "Launchpad" });
    const applications = await catalog.createStore({ projectId: project.id, name: "Applications", fields });
    const first = await catalog.createRecord({ projectId: project.id, storeId: applications.id, data: { company: "LSEG", role: "Analyst", status: "submitted", score: 8, active: true } });
    const view = await catalog.createView({ projectId: project.id, name: "Graduate Applications Dashboard", slug: "graduate-applications", description: "Current application pipeline", queries: [{ name: "applications", storeId: applications.id, filters: [{ field: "score", operator: "gte", value: 7 }], sort: [{ field: "company", direction: "asc" }] }], html: "<h1>Applications</h1><p>Total: {{applications.length}}</p>{{#if applications}}<ul>{{#each applications}}<li>{{company}} — {{role}} — {{status}}</li>{{/each}}</ul>{{/if}}", css: "body { padding: 2rem; }", client: "Claude" });
    assert.equal((await catalog.listViews(project.id))[0]?.id, view.id);
    assert.equal((await catalog.getView(project.id, view.id)).slug, "graduate-applications");
    const rendered = await catalog.renderView(project.id, view.id);
    assert.match(rendered.renderedHtml, /Total: 1/); assert.match(rendered.renderedHtml, /LSEG — Analyst — submitted/); assert.equal(rendered.diagnostics.queries[0]?.returned, 1);
    const updated = await catalog.updateView({ projectId: project.id, viewId: view.id, html: "{{#each applications}}<article>{{company}}: {{status}}</article>{{/each}}", client: "ChatGPT" });
    assert.equal(updated.id, view.id);
    await catalog.updateRecord({ projectId: project.id, storeId: applications.id, recordId: first.id, data: { status: "interview" } });
    assert.match((await catalog.renderView(project.id, view.id)).renderedHtml, /LSEG: interview/);
    const independentClient = new AtlasCatalog(store);
    assert.equal((await independentClient.getView(project.id, view.id)).id, view.id);
    assert.deepEqual((await catalog.auditHistory({ projectId: project.id })).filter(x => x.operation.startsWith("view.")).map(x => x.operation), ["view.updated", "view.created"]);
    await catalog.archiveView(project.id, view.id, "CLI");
    assert.equal((await catalog.listViews(project.id)).length, 0); assert.equal((await catalog.listViews(project.id, true))[0]?.id, view.id);
});

test("View definitions enforce project, schema, operator, binding, template, and presentation boundaries", async () => {
    const { catalog } = await databaseFixture(); const one=await catalog.createProject({name:"One"}); const two=await catalog.createProject({name:"Two"});
    const own=await catalog.createStore({projectId:one.id,name:"Own",fields}); const foreign=await catalog.createStore({projectId:two.id,name:"Foreign",fields});
    const create=(overrides:Record<string,unknown>)=>catalog.createView({projectId:one.id,name:`View ${Math.random()}`,queries:[{name:"items",storeId:own.id}],html:"{{#each items}}{{company}}{{/each}}",css:"",...overrides} as any);
    await assert.rejects(()=>create({queries:[{name:"items",storeId:foreign.id}]}),/not found in the View's project/);
    await assert.rejects(()=>create({queries:[{name:"items",storeId:own.id,filters:[{field:"missing",operator:"eq",value:1}]}]}),/Unknown filter field/);
    await assert.rejects(()=>create({queries:[{name:"items",storeId:own.id,filters:[{field:"active",operator:"gt",value:true}]}]}),/not compatible/);
    await assert.rejects(()=>create({queries:[{name:"items",storeId:own.id},{name:"items",storeId:own.id}]}),/Duplicate query binding/);
    await assert.rejects(()=>create({html:"{{#each items}}"}),/Invalid Handlebars/);
    await assert.rejects(()=>create({html:"<script>alert(1)</script>"}),/unsafe mechanism/);
    await assert.rejects(()=>create({html:"<img src={{#each items}}{{company}}{{\/each}}>"}),AtlasError);
    await assert.rejects(()=>create({css:"@import url(https://evil.invalid/x.css)"}),/cannot import/);
});

test("Core projects, stores, and records remain independently usable without Views", async()=>{
    const {catalog}=await databaseFixture();const project=await catalog.createProject({name:"Core only"});const store=await catalog.createStore({projectId:project.id,name:"Data",fields});const record=await catalog.createRecord({projectId:project.id,storeId:store.id,data:{company:"Atlas",role:"Core"}});assert.equal((await catalog.getRecord(project.id,store.id,record.id)).data.company,"Atlas");assert.deepEqual(await catalog.listViews(project.id),[]);
});
