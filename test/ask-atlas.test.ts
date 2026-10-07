import test from "node:test";
import assert from "node:assert/strict";
import { AskAtlasService, ASK_ATLAS_ABSTENTION } from "../apps/server/src/apps/ask-atlas/index.js";
import type { AnswerGenerationProvider, AskAtlasModel, GenerationRequest } from "../apps/server/src/apps/ask-atlas/types.js";
import type { ContextResponse } from "../apps/server/src/fabric/types.js";

const selection = (recordId: string, data: Record<string, unknown> = { company: "Example", status: "OA completed" }) => ({
    project: { id: "11111111-1111-4111-8111-111111111111", name: "Applications" },
    store: { id: "22222222-2222-4222-8222-222222222222", name: "Graduate Applications" },
    record: { id: recordId, projectId: "11111111-1111-4111-8111-111111111111", storeId: "22222222-2222-4222-8222-222222222222", data, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
    score: 0.9, matchedFields: ["company"], snippet: "company: Example · status: OA completed", reasons: [], projection: { searchableFields: [], displayOnlyFields: [] }, ranking: {},
});

const contextResponse = (selections: ReturnType<typeof selection>[], unresolved = false): ContextResponse => ({
    query: "question",
    selections: selections as unknown as ContextResponse["selections"],
    diagnostics: {
        searchedProjects: 1, searchedStores: 1, candidateCount: selections.length, selectedCount: selections.length, maxRecords: 10,
        relevanceFloorRejected: 0, authorityStatus: "ready", authoritySuppressed: 0, unresolvedConflicts: unresolved ? 1 : 0, redundancyRejected: 0, diversification: [],
        authorityDecisions: unresolved ? [{ equivalenceGroupId: "g1", equivalenceKind: "same_entity", identity: ["Example"], records: selections.map((item, index) => ({ recordId: item.record.id, authorityRole: "primary", relation: "primary", currentness: "current", effectiveAt: null, conflictsWith: [selections[1 - index]?.record.id].filter(Boolean) })), suppressedRecordIds: [], reason: "equal authority conflicting claims", contradictionStatus: "unresolved", unresolvedAmbiguity: true }] : [],
    },
});

class FakeGenerator implements AnswerGenerationProvider {
    readonly name = "fake"; calls: GenerationRequest[] = [];
    constructor(readonly answer = "The OA was completed [S1].", readonly model: AskAtlasModel = "qwen3:1.7b") {}
    async generate(request: GenerationRequest) { this.calls.push(request); return this.answer; }
}

test("Ask Atlas makes one Fabric context request and propagates project scope", async () => {
    const calls: unknown[] = []; const generator = new FakeGenerator();
    const service = new AskAtlasService({ request: async input => { calls.push(input); return contextResponse([selection("33333333-3333-4333-8333-333333333333")]); } }, generator);
    await service.ask({ question: "What happened?", projectIds: ["11111111-1111-4111-8111-111111111111"], maxRecords: 4 });
    assert.deepEqual(calls, [{ query: "What happened?", projectIds: ["11111111-1111-4111-8111-111111111111"], maxRecords: 4 }]);
    assert.equal(generator.calls.length, 1);
});

test("model omission defaults to qwen3:4b and diagnostics report it", async () => {
    const generator = new FakeGenerator("The OA was completed [S1].", "qwen3:1.7b");
    const result = await new AskAtlasService({ request: async () => contextResponse([selection("33333333-3333-4333-8333-333333333333")]) }, generator).ask({ question: "Status?" });
    assert.equal(generator.calls[0]!.model, "qwen3:4b"); assert.equal(result.diagnostics.model, "qwen3:4b");
});

test("explicit qwen3:1.7b is passed to the provider", async () => {
    const generator = new FakeGenerator();
    const result = await new AskAtlasService({ request: async () => contextResponse([selection("33333333-3333-4333-8333-333333333333")]) }, generator).ask({ question: "Status?", model: "qwen3:1.7b" });
    assert.equal(generator.calls[0]!.model, "qwen3:1.7b"); assert.equal(result.diagnostics.model, "qwen3:1.7b");
});

test("explicit qwen3:4b is passed to the same provider and reported", async () => {
    const generator = new FakeGenerator();
    const result = await new AskAtlasService({ request: async () => contextResponse([selection("33333333-3333-4333-8333-333333333333")]) }, generator).ask({ question: "Status?", model: "qwen3:4b" });
    assert.equal(generator.calls[0]!.model, "qwen3:4b"); assert.equal(result.diagnostics.model, "qwen3:4b");
});

test("unsupported models are rejected before Fabric or generation", async () => {
    let contextCalls = 0; const generator = new FakeGenerator();
    const service = new AskAtlasService({ request: async () => { contextCalls++; return contextResponse([]); } }, generator);
    await assert.rejects(service.ask({ question: "Status?", model: "qwen3:8b" as never }), /Unsupported Ask Atlas model/);
    assert.equal(contextCalls, 0); assert.equal(generator.calls.length, 0);
});

test("selected records reach the generator and provenance is deterministic", async () => {
    const generator = new FakeGenerator(); const item = selection("33333333-3333-4333-8333-333333333333");
    const result = await new AskAtlasService({ request: async () => contextResponse([item]) }, generator).ask({ question: "Status?" });
    assert.match(generator.calls[0]!.evidence, /OA completed/);
    assert.deepEqual(result.sources, [{ label: "S1", projectId: item.project.id, projectName: item.project.name, storeId: item.store.id, storeName: item.store.name, recordId: item.record.id, snippet: item.snippet }]);
});

test("no context abstains without calling the provider", async () => {
    const generator = new FakeGenerator();
    const result = await new AskAtlasService({ request: async () => contextResponse([]) }, generator).ask({ question: "Unknown?" });
    assert.equal(result.answer, ASK_ATLAS_ABSTENTION); assert.deepEqual(result.sources, []); assert.equal(generator.calls.length, 0);
});

test("provider failure is isolated to Ask Atlas", async () => {
    const expected = new Error("provider down"); const context = { request: async () => contextResponse([selection("33333333-3333-4333-8333-333333333333")]) };
    const provider: AnswerGenerationProvider = { name: "fake", model: "qwen3:1.7b", generate: async () => { throw expected; } };
    await assert.rejects(new AskAtlasService(context, provider).ask({ question: "Status?" }), expected);
    assert.equal((await context.request()).selections.length, 1);
});

test("unresolved contradictions are preserved in generation input and diagnostics", async () => {
    const generator = new FakeGenerator("Because you said my application, choose the first one [S1].");
    const items = [selection("33333333-3333-4333-8333-333333333333", { role: "Software Engineer", status: "Application Submitted" }), selection("44444444-4444-4444-8444-444444444444", { role: "Data & AI", status: "Not Applied" })];
    const result = await new AskAtlasService({ request: async () => contextResponse(items, true) }, generator).ask({ question: "Status?" });
    assert.equal(generator.calls.length, 0);
    assert.match(result.answer, /Software Engineer — Application Submitted \[S1\]/); assert.match(result.answer, /Data & AI — Not Applied \[S2\]/);
    assert.match(result.answer, /does not currently have enough authority information/);
    assert.equal(result.diagnostics.unresolvedConflicts, 1); assert.equal(result.diagnostics.authorityDecisions[0]?.unresolvedAmbiguity, true);
});

test("sources can only come from Fabric selections, never generator output", async () => {
    const generator = new FakeGenerator("Unsupported [S99]."); const item = selection("33333333-3333-4333-8333-333333333333");
    const result = await new AskAtlasService({ request: async () => contextResponse([item]) }, generator).ask({ question: "Status?" });
    assert.equal(result.answer, ASK_ATLAS_ABSTENTION); assert.deepEqual(result.sources, []);
});

test("unsupported OA expansion fails closed", async () => {
    const generator = new FakeGenerator("The status is OA Received (Offer Acknowledgement Received) [S1].");
    const item = selection("33333333-3333-4333-8333-333333333333", { status: "OA Received" });
    const result = await new AskAtlasService({ request: async () => contextResponse([item]) }, generator).ask({ question: "Status?" });
    assert.equal(result.answer, ASK_ATLAS_ABSTENTION); assert.deepEqual(result.sources, []);
});

test("arbitrary acronym expansion receives the same protection", async () => {
    const generator = new FakeGenerator("The status is XYZ (Xylophone Yield Zone) [S1].");
    const item = selection("33333333-3333-4333-8333-333333333333", { status: "XYZ" });
    const result = await new AskAtlasService({ request: async () => contextResponse([item]) }, generator).ask({ question: "Status?" });
    assert.equal(result.answer, ASK_ATLAS_ABSTENTION); assert.deepEqual(result.sources, []);
});

test("an acronym expansion explicitly present in context is allowed", async () => {
    const generator = new FakeGenerator("The status is OA (Online Assessment) Received [S1].");
    const item = selection("33333333-3333-4333-8333-333333333333", { status: "OA Received", glossary: "OA means Online Assessment" });
    const result = await new AskAtlasService({ request: async () => contextResponse([item]) }, generator).ask({ question: "Status?" });
    assert.equal(result.answer, "The status is OA (Online Assessment) Received [S1]."); assert.equal(result.sources.length, 1);
});

test("sources contain only valid labels actually cited by the answer", async () => {
    const items = [selection("33333333-3333-4333-8333-333333333333"), selection("44444444-4444-4444-8444-444444444444", { company: "Other", status: "Applied" })];
    const result = await new AskAtlasService({ request: async () => contextResponse(items) }, new FakeGenerator("Only the second record supports this [S2].")).ask({ question: "Status?" });
    assert.deepEqual(result.sources.map(source => source.label), ["S2"]); assert.deepEqual(result.sources.map(source => source.recordId), [items[1]!.record.id]);
});

test("a factual answer without a valid citation fails closed", async () => {
    const item = selection("33333333-3333-4333-8333-333333333333");
    const result = await new AskAtlasService({ request: async () => contextResponse([item]) }, new FakeGenerator("The application is complete.")).ask({ question: "Status?" });
    assert.equal(result.answer, ASK_ATLAS_ABSTENTION); assert.deepEqual(result.sources, []);
});

test("a Fabric-resolved conflict may use its preferred selected record", async () => {
    const preferred = selection("33333333-3333-4333-8333-333333333333", { status: "OA Received" });
    const response = contextResponse([preferred]);
    response.diagnostics.authorityDecisions = [{ equivalenceGroupId: "g1", equivalenceKind: "same_entity", identity: ["Example"], records: [{ recordId: preferred.record.id, authorityRole: "primary", relation: "primary", currentness: "current", effectiveAt: null, conflictsWith: ["44444444-4444-4444-8444-444444444444"] }], preferredRecordId: preferred.record.id, suppressedRecordIds: ["44444444-4444-4444-8444-444444444444"], reason: "Fabric chose the current primary record", contradictionStatus: "resolved", unresolvedAmbiguity: false }];
    const generator = new FakeGenerator("The status is OA Received [S1].");
    const result = await new AskAtlasService({ request: async () => response }, generator).ask({ question: "Status?" });
    assert.equal(generator.calls.length, 1); assert.equal(result.answer, "The status is OA Received [S1]."); assert.deepEqual(result.sources.map(source => source.label), ["S1"]);
});

test("live-style J.P. Morgan alternatives cannot be collapsed by 'my application' wording", async () => {
    const items = [
        selection("33333333-3333-4333-8333-333333333333", { company: "J.P. Morgan", role: "2027 Data & AI - Full Time Analyst", status: "Not Applied" }),
        selection("44444444-4444-4444-8444-444444444444", { company: "J.P. Morgan", role: "2027 Software Engineer Program", status: "Application Submitted" }),
    ];
    const generator = new FakeGenerator("Your application is the Software Engineer Program [S2].");
    const result = await new AskAtlasService({ request: async () => contextResponse(items, true) }, generator).ask({ question: "What is happening with my J.P. Morgan application?" });
    assert.equal(generator.calls.length, 0); assert.match(result.answer, /Data & AI.*Not Applied/); assert.match(result.answer, /Software Engineer Program.*Application Submitted/); assert.equal(result.sources.length, 2);
});

const authorityRecord = (recordId: string, conflictsWith: string[] = []) => ({ recordId, authorityRole: "mirror" as const, relation: "mirror" as const, currentness: "current" as const, effectiveAt: null, conflictsWith });

test("Marshall Wace answer ignores an unrelated unresolved SIG conflict", async () => {
    const marshall = selection("33333333-3333-4333-8333-333333333333", { company: "Marshall Wace", role: "Graduate Engineer", status: "OA Received" });
    const sigOne = selection("44444444-4444-4444-8444-444444444444", { company: "Susquehanna (SIG)", role: "Technology", status: "Applied" });
    const sigTwo = selection("55555555-5555-4555-8555-555555555555", { company: "Susquehanna (SIG)", role: "Quant", status: "Not Applied" });
    const response = contextResponse([marshall, sigOne, sigTwo]); response.diagnostics.unresolvedConflicts = 1;
    response.diagnostics.authorityDecisions = [
        { equivalenceGroupId: "mw", equivalenceKind: "same_fact", identity: ["marshall wace"], records: [authorityRecord(marshall.record.id)], preferredRecordId: marshall.record.id, suppressedRecordIds: [], reason: "resolved", contradictionStatus: "resolved", unresolvedAmbiguity: false },
        { equivalenceGroupId: "sig", equivalenceKind: "same_fact", identity: ["susquehanna (sig)"], records: [authorityRecord(sigOne.record.id, [sigTwo.record.id]), authorityRecord(sigTwo.record.id, [sigOne.record.id])], suppressedRecordIds: [], reason: "equal authority", contradictionStatus: "unresolved", unresolvedAmbiguity: true },
    ];
    const generator = new FakeGenerator("Marshall Wace is OA Received [S1].");
    const result = await new AskAtlasService({ request: async () => response }, generator).ask({ question: "What is the latest status of my Marshall Wace application? Expand every acronym you see." });
    assert.equal(generator.calls.length, 1); assert.equal(result.answer, "Marshall Wace is OA Received [S1]."); assert.deepEqual(result.sources.map(source => source.label), ["S1"]);
    assert.equal(result.diagnostics.unresolvedConflicts, 1); assert.equal(result.diagnostics.relevantUnresolvedConflicts, 0);
});

test("LSEG answer ignores an unrelated unresolved conflict", async () => {
    const lseg = selection("33333333-3333-4333-8333-333333333333", { company: "LSEG", status: "active", oaStatus: "completed" });
    const janeOne = selection("44444444-4444-4444-8444-444444444444", { company: "Jane Street", status: "Applied" });
    const janeTwo = selection("55555555-5555-4555-8555-555555555555", { company: "Jane Street", status: "Not Applied" });
    const response = contextResponse([lseg, janeOne, janeTwo]); response.diagnostics.unresolvedConflicts = 1;
    response.diagnostics.authorityDecisions = [
        { equivalenceGroupId: "lseg", equivalenceKind: "same_fact", identity: ["lseg"], records: [authorityRecord(lseg.record.id)], preferredRecordId: lseg.record.id, suppressedRecordIds: [], reason: "resolved", contradictionStatus: "resolved", unresolvedAmbiguity: false },
        { equivalenceGroupId: "jane", equivalenceKind: "same_fact", identity: ["jane street"], records: [authorityRecord(janeOne.record.id, [janeTwo.record.id]), authorityRecord(janeTwo.record.id, [janeOne.record.id])], suppressedRecordIds: [], reason: "equal authority", contradictionStatus: "unresolved", unresolvedAmbiguity: true },
    ];
    const generator = new FakeGenerator("LSEG is active and its OA is completed [S1].");
    const result = await new AskAtlasService({ request: async () => response }, generator).ask({ question: "What is my LSEG status?" });
    assert.equal(generator.calls.length, 1); assert.match(result.answer, /LSEG is active/); assert.equal(result.diagnostics.relevantUnresolvedConflicts, 0);
});

test("natural-language pending-assessment questions use bounded deterministic retrieval augmentation", async () => {
    const calls: unknown[] = [];
    const items = [selection("33333333-3333-4333-8333-333333333333", { company: "Softwire", status: "OA Received" }), selection("44444444-4444-4444-8444-444444444444", { company: "Marshall Wace", status: "OA Received" })];
    const generator = new FakeGenerator("Softwire [S1] and Marshall Wace [S2] have OA Received.");
    const question = "Which online assessments do I currently still need to complete?";
    const result = await new AskAtlasService({ request: async input => { calls.push(input); return contextResponse(items); } }, generator).ask({ question, maxRecords: 10 });
    assert.deepEqual(calls, [{ query: "status OA Received", projectIds: undefined, maxRecords: 10 }]);
    assert.equal(generator.calls[0]!.question, question); assert.match(result.answer, /may be incomplete/); assert.deepEqual(result.sources.map(source => source.label), ["S1", "S2"]);
    assert.equal(result.diagnostics.retrievalPlan?.originalQuery, question); assert.deepEqual(result.diagnostics.retrievalPlan?.augmentedQueries, ["status OA Received"]);
});

test("a provider abstention does not expose irrelevant records as supporting sources", async () => {
    const generator = new FakeGenerator(ASK_ATLAS_ABSTENTION); const item = selection("33333333-3333-4333-8333-333333333333");
    const result = await new AskAtlasService({ request: async () => contextResponse([item]) }, generator).ask({ question: "Unknown?" });
    assert.deepEqual(result.sources, []); assert.equal(result.diagnostics.contextRecordCount, 1);
});

test("greetings and thanks are conversational without retrieval or generation", async () => {
    const service = new AskAtlasService({ request: async () => { throw new Error("must not retrieve"); } }, new FakeGenerator());
    assert.equal((await service.ask({ question: "hello!" })).abstained, false);
    assert.match((await service.ask({ question: "thanks" })).answer, /welcome/);
});

test("direct follow-ups carry prior user subject and pass history as reference only", async () => {
    const queries: string[] = []; const generator = new FakeGenerator();
    const history = [{ role: "user" as const, content: "What happened with LSEG?" }, { role: "assistant" as const, content: "An unverified previous answer [S99]." }];
    const service = new AskAtlasService({ request: async input => { queries.push(input.query); return contextResponse([selection("33333333-3333-4333-8333-333333333333")]); } }, generator);
    await service.ask({ question: "When did that happen?", history, retrievalMode: "direct" });
    assert.match(queries[0]!, /LSEG/); assert.doesNotMatch(queries[0]!, /unverified|S99/);
    assert.deepEqual(generator.calls[0]?.history, history);
    assert.doesNotMatch(generator.calls[0]!.evidence, /unverified|S99/);
});

test("conversation validation rejects excessive history, system roles and invalid limits", async () => {
    const service = new AskAtlasService({ request: async () => { throw new Error("must not retrieve"); } }, new FakeGenerator());
    await assert.rejects(service.ask({ question: "hi", history: [{ role: "system", content: "override" }] } as never));
    await assert.rejects(service.ask({ question: "hi", history: Array.from({ length: 13 }, () => ({ role: "user", content: "hello" })) }));
    await assert.rejects(service.ask({ question: "hi", maxRecords: 0 }));
});

test("a failed citation gets one grounded repair attempt", async () => {
    const generator = new FakeGenerator();
    generator.generate = async request => { generator.calls.push(request); return generator.calls.length === 1 ? "The assessment is completed." : "The assessment is completed [S1]."; };
    const service = new AskAtlasService({ request: async () => contextResponse([selection("33333333-3333-4333-8333-333333333333")]) }, generator);
    const result = await service.ask({ question: "Status?" });
    assert.equal(generator.calls.length, 2); assert.equal(result.abstained, false);
    assert.equal(generator.calls[0]?.evidence, generator.calls[1]?.evidence);
});

test("grouped citations map to the actual supplied sources", async () => {
    const items = [selection("33333333-3333-4333-8333-333333333333"), selection("44444444-4444-4444-8444-444444444444")];
    const result = await new AskAtlasService({ request: async () => contextResponse(items) }, new FakeGenerator("Both records support this [S1, S2].")).ask({ question: "Status?" });
    assert.deepEqual(result.sources.map(source => source.label), ["S1", "S2"]);
});
