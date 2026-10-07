import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createFabric } from "../apps/server/src/fabric/index.js";
import { retrievalTerms } from "../apps/server/src/fabric/relevance.js";
import { cleanupDatabases, databaseFixture } from "./database.js";
after(cleanupDatabases);

test("conversation terms preserve names, acronyms, and negation", () => {
    assert.deepEqual(retrievalTerms("Can you please tell me what happened with my Capital One application?"), ["capital", "one", "application"]);
    assert.deepEqual(retrievalTerms("Which OA is not completed?"), ["oa", "not", "completed"]);
});

test("natural questions retrieve named records without an embedding model; similar rows remain distinct", async () => {
    const fixture = await databaseFixture();
    const fabric = createFabric(fixture.databaseUrl, null);
    try {
        const project = await fixture.catalog.createProject({ name: "Career" });
        const store = await fixture.catalog.createStore({ projectId: project.id, name: "Applications", fields: [{ name: "company", type: "string" }, { name: "role", type: "string" }, { name: "status", type: "string" }, { name: "notes", type: "string" }] });
        const create = (company: string, status = "Applied") => fixture.catalog.createRecord({ projectId: project.id, storeId: store.id, data: { company, role: "Graduate Software Engineer London", status, notes: "Application submitted for the graduate recruitment programme" } });
        const lseg = await create("LSEG"); const capital = await create("Capital One"); const morgan = await create("J.P. Morgan");
        const lsegOther = await create("LSEG", "Interview");
        for (const [question, expected] of [["Can you tell me what happened with my LSEG application?", lseg.id], ["What do you know about Capital One?", capital.id], ["What is happening with J.P. Morgan?", morgan.id]] as const) {
            const result = await fabric.context.request({ query: question });
            assert.ok(result.selections.some(item => item.record.id === expected), question);
        }
        const lsegContext = await fabric.context.request({ query: "What happened with LSEG?" });
        assert.ok(lsegContext.selections.some(item => item.record.id === lseg.id));
        assert.ok(lsegContext.selections.some(item => item.record.id === lsegOther.id), "different statuses must not be deduplicated");
        const list = await fabric.context.request({ query: "graduate applications", maxRecords: 10 });
        assert.equal(list.selections.length, 4, "template-like records for different companies are separate facts");
        const bounded = await fabric.context.request({ query: "graduate applications", maxRecords: 2 });
        assert.equal(bounded.selections.length, 2); assert.equal(bounded.diagnostics.truncated, true);
        assert.equal((await fabric.context.request({ query: "quasar volcano" })).selections.length, 0);
        const otherProject = await fixture.catalog.createProject({ name: "Unrelated" });
        assert.equal((await fabric.context.request({ query: "LSEG", projectIds: [otherProject.id] })).selections.length, 0);
    } finally { await fabric.repository.close(); }
});

test("rare named subjects outrank repeated generic terms before the candidate limit", async () => {
    const fixture = await databaseFixture(); const fabric = createFabric(fixture.databaseUrl, null);
    try {
        const project = await fixture.catalog.createProject({ name: "Career" });
        const store = await fixture.catalog.createStore({ projectId: project.id, name: "Applications", fields: [{ name: "company", type: "string" }, { name: "notes", type: "string" }] });
        const target = await fixture.catalog.createRecord({ projectId: project.id, storeId: store.id, data: { company: "UniqueCo", notes: "Applied" } });
        await fixture.catalog.bulkRecords({ projectId: project.id, storeId: store.id, operations: Array.from({ length: 20 }, (_, i) => ({ action: "create", data: { company: `Other ${i}`, notes: "application ".repeat(30) } })) });
        const result = await fabric.search.search({ query: "What happened with my UniqueCo application?", mode: "lexical", limit: 1 });
        assert.equal(result.results[0]?.record.id, target.id);
    } finally { await fabric.repository.close(); }
});
