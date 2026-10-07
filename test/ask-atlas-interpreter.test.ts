import test from "node:test";
import assert from "node:assert/strict";
import { AskAtlasService } from "../apps/server/src/apps/ask-atlas/index.js";
import { AskAtlasInterpreter, type InterpretationProvider } from "../apps/server/src/apps/ask-atlas/interpreter.js";
import { AskAtlasRetrievalExecutor } from "../apps/server/src/apps/ask-atlas/retrieval-executor.js";
import { parseRetrievalPlan } from "../apps/server/src/apps/ask-atlas/retrieval-plan.js";
import type { AnswerGenerationProvider, GenerationRequest } from "../apps/server/src/apps/ask-atlas/types.js";
import type { ContextResponse } from "../apps/server/src/fabric/types.js";
import type { AtlasRecord, Project, Store } from "../apps/server/src/types.js";

const project: Project = { id: "11111111-1111-4111-8111-111111111111", name: "Launchpad", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const store: Store = { id: "22222222-2222-4222-8222-222222222222", projectId: project.id, name: "Graduate Applications", schema: { version: 1, fields: [{ name: "company", type: "string" }, { name: "status", type: "string" }, { name: "oaStatus", type: "string" }] }, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const records: AtlasRecord[] = [
    { id: "33333333-3333-4333-8333-333333333333", projectId: project.id, storeId: store.id, data: { company: "LSEG", status: "active", oaStatus: "completed" }, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    { id: "44444444-4444-4444-8444-444444444444", projectId: project.id, storeId: store.id, data: { company: "Macquarie", status: "active", oaStatus: "pending" }, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
];
const emptyContext = (query: string): ContextResponse => ({ query, selections: [], diagnostics: { searchedProjects: 1, searchedStores: 1, candidateCount: 0, selectedCount: 0, maxRecords: 10, relevanceFloorRejected: 0, authorityStatus: "ready", authorityDecisions: [], authoritySuppressed: 0, unresolvedConflicts: 0, redundancyRejected: 0, diversification: [] } });
class Planner implements InterpretationProvider { readonly name = "fake-interpreter"; constructor(readonly value: unknown, readonly failure?: Error) {} async interpret() { if (this.failure) throw this.failure; return this.value; } }
class Generator implements AnswerGenerationProvider { readonly name = "fake"; readonly model = "qwen3:4b" as const; calls: GenerationRequest[] = []; constructor(readonly answer: string) {} async generate(request: GenerationRequest) { this.calls.push(request); return this.answer; } }
const catalog = {
    async listProjects() { return [project]; }, async listStores() { return [store]; },
    async queryRecords(input: { filters?: Array<{ field: string; operator: string; value: unknown }>; limit?: number; offset?: number }) {
        const items = records.filter(record => (input.filters ?? []).every(filter => filter.operator === "eq" ? record.data[filter.field] === filter.value : true));
        return { items: items.slice(0, input.limit ?? 100), total: items.length, limit: input.limit ?? 100, offset: input.offset ?? 0 };
    },
};

test("retrieval-plan parser rejects unsupported operations", () => {
    assert.throws(() => parseRetrievalPlan({ intent: "delete_records" }), /unsupported intent/);
    assert.throws(() => parseRetrievalPlan({ intent: "structured_query", structuredQueries: [{ project: "Launchpad", store: "Graduate Applications", filters: [{ field: "status", operator: "sql", value: "x" }] }] }), /Invalid structured filter/);
});

test("executor rejects nonexistent projects, stores, and fields", async () => {
    const executor = new AskAtlasRetrievalExecutor({ request: async input => emptyContext(input.query) }, catalog as never);
    await assert.rejects(executor.execute({ intent: "structured_query", structuredQueries: [{ project: "Invented", store: store.name }] }, { projects: [project], stores: [store] }, { question: "x" }), /Unknown or disallowed project/);
    await assert.rejects(executor.execute({ intent: "structured_query", structuredQueries: [{ project: project.name, store: "Invented" }] }, { projects: [project], stores: [store] }, { question: "x" }), /Unknown store/);
    await assert.rejects(executor.execute({ intent: "structured_query", structuredQueries: [{ project: project.name, store: store.name, filters: [{ field: "invented", operator: "eq", value: true }] }] }, { projects: [project], stores: [store] }, { question: "x" }), /Unknown field/);
});

test("structured application list retrieves the complete bounded matching set", async () => {
    const plan = { intent: "structured_query", structuredQueries: [{ project: project.name, store: store.name, filters: [{ field: "status", operator: "eq", value: "active" }], limit: 100 }], desiredResultType: "list" };
    const interpreter = new AskAtlasInterpreter(new Planner(plan), catalog);
    const executor = new AskAtlasRetrievalExecutor({ request: async input => emptyContext(input.query) }, catalog as never);
    const generator = new Generator("LSEG [S1] and Macquarie [S2].");
    const result = await new AskAtlasService({ request: async input => emptyContext(input.query) }, generator, interpreter, executor).ask({ retrievalMode: "planned", question: "What companies have I applied to?", model: "qwen3:4b" });
    assert.equal(result.diagnostics.interpreter?.intent, "structured_query"); assert.equal(result.diagnostics.retrieval?.strategy, "structured");
    assert.equal(result.diagnostics.retrieval?.operations[0]?.total, 2); assert.deepEqual(result.sources.map(source => source.label), ["S1", "S2"]);
});

test("structured list safely normalizes repeated store identity and an empty placeholder", async () => {
    const executor = new AskAtlasRetrievalExecutor({ request: async input => emptyContext(input.query) }, catalog as never);
    const result = await executor.execute({ intent: "structured_query", structuredQueries: [{ project: store.name, store: store.id, filters: [{ field: "company", operator: "eq", value: {} }] }], desiredResultType: "list" }, { projects: [project], stores: [store] }, { question: "List every application" });
    assert.equal(result.context.selections.length, 2);
    assert.deepEqual(result.operations[0]?.filters, []);
});

test("entity lookup plan queries the validated store", async () => {
    const plan = { intent: "entity_lookup", structuredQueries: [{ project: project.name, store: store.name, filters: [{ field: "company", operator: "eq", value: "LSEG" }] }], desiredResultType: "single" };
    const interpreter = new AskAtlasInterpreter(new Planner(plan), catalog); const executor = new AskAtlasRetrievalExecutor({ request: async input => emptyContext(input.query) }, catalog as never);
    const result = await new AskAtlasService({ request: async input => emptyContext(input.query) }, new Generator("LSEG is active [S1]."), interpreter, executor).ask({ retrievalMode: "planned", question: "What is my LSEG status?" });
    assert.equal(result.sources.length, 1); assert.equal(result.sources[0]?.recordId, records[0]?.id);
});

test("semantic plans route broad questions through Fabric", async () => {
    const calls: string[] = []; const context = { request: async (input: { query: string }) => { calls.push(input.query); return emptyContext(input.query); } };
    const interpreter = new AskAtlasInterpreter(new Planner({ intent: "semantic_search", semanticQueries: ["recent focus priorities"], desiredResultType: "summary" }), catalog);
    const executor = new AskAtlasRetrievalExecutor(context as never, catalog as never);
    const result = await new AskAtlasService(context as never, new Generator("unused"), interpreter, executor).ask({ retrievalMode: "planned", question: "What have I been focusing on recently?" });
    assert.deepEqual(calls, ["recent focus priorities", "What have I been focusing on recently?"]); assert.equal(result.diagnostics.retrieval?.strategy, "fabric");
});

test("interpreter failure falls back once to the original Fabric question", async () => {
    const calls: string[] = []; const context = { request: async (input: { query: string }) => { calls.push(input.query); return emptyContext(input.query); } };
    const interpreter = new AskAtlasInterpreter(new Planner({}, new Error("planner down")), catalog); const executor = new AskAtlasRetrievalExecutor(context as never, catalog as never);
    const result = await new AskAtlasService(context as never, new Generator("unused"), interpreter, executor).ask({ retrievalMode: "planned", question: "Unknown topic" });
    assert.deepEqual(calls, ["Unknown topic"]); assert.equal(result.diagnostics.interpreter?.validationStatus, "invalid"); assert.match(result.diagnostics.interpreter?.error ?? "", /planner down/);
});

test("unknown interpreter intent fails closed to one Fabric request", async () => {
    const calls: string[] = []; const context = { request: async (input: { query: string }) => { calls.push(input.query); return emptyContext(input.query); } };
    const executor = new AskAtlasRetrievalExecutor(context as never, catalog as never);
    const result = await executor.execute({ intent: "unknown", structuredQueries: [{ project: project.name, store: store.name }] }, { projects: [project], stores: [store] }, { question: "ambiguous request" });
    assert.deepEqual(calls, ["ambiguous request"]); assert.equal(result.strategy, "fabric");
});

test("auto retrieval uses one answer LLM and skips the planner for a successful ordinary search", async () => {
    const executor = new AskAtlasRetrievalExecutor({ request: async input => emptyContext(input.query) }, catalog as never);
    const evidence = (await executor.execute({ intent: "structured_query", structuredQueries: [{ project: project.name, store: store.name }] }, { projects: [project], stores: [store] }, { question: "LSEG" })).context;
    const interpreter = new AskAtlasInterpreter(new Planner({}, new Error("must not plan")), catalog);
    const result = await new AskAtlasService({ request: async () => evidence }, new Generator("LSEG is active [S1]."), interpreter, executor).ask({ question: "What happened with LSEG?" });
    assert.equal(result.diagnostics.interpreter, undefined);
    assert.equal(result.diagnostics.retrieval?.strategy, "fabric");
});

test("structured execution enforces the shared context budget and exposes truncation", async () => {
    const executor = new AskAtlasRetrievalExecutor({ request: async input => emptyContext(input.query) }, catalog as never);
    const result = await executor.execute({ intent: "structured_query", structuredQueries: [{ project: project.name, store: store.name }] }, { projects: [project], stores: [store] }, { question: "List applications", maxRecords: 1 });
    assert.equal(result.context.selections.length, 1); assert.equal(result.context.diagnostics.truncated, true);
    assert.equal(result.operations[0]?.total, 2);
});

test("planner gets bounded conversation for reference resolution", async () => {
    let prompt = "";
    const interpreter = new AskAtlasInterpreter({ name: "capture", interpret: async input => { prompt = input.prompt; return { intent: "semantic_search", semanticQueries: ["LSEG assessment date"] }; } }, catalog);
    await interpreter.interpret("When was that?", undefined, [{ role: "user", content: "LSEG assessment" }]);
    assert.match(prompt, /LSEG assessment/); assert.match(prompt, /reference resolution only/);
});
