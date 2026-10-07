import type { AuthorityProvider } from "../../retrieval/service.js";
import type { ContextProvider } from "../../retrieval/service.js";
import type { ContextResponse, FabricResult } from "../../retrieval/types.js";
import type { AtlasRecord, FieldDefinition, Page, Project, RecordFilter, Store } from "../../types.js";
import type { AskAtlasRetrievalPlan, StructuredRetrievalQuery } from "./retrieval-plan.js";

export type StructuredCatalog = {
    queryRecords(input: { projectId: string; storeId: string; filters?: RecordFilter[]; limit?: number; offset?: number }): Promise<Page<AtlasRecord>>;
};
export type RetrievalExecution = { context: ContextResponse; strategy: "structured" | "fabric" | "mixed"; operations: Array<Record<string, unknown>> };

const normalized = (value: string) => value.trim().toLocaleLowerCase();
const emptyRanking = (projectId: string, storeId: string, recordId: string): FabricResult["ranking"] => ({ textRank: 0, termCoverage: 0, exactPhrase: false, matchedTermCount: 0, lexicalFound: false, semanticFound: false, lexicalScore: 0, lexicalNormalized: 0, lexicalRank: null, lexicalContribution: 0, semanticSimilarity: null, semanticScore: 0, semanticRank: null, semanticContribution: 0, hybridScore: 0, tieBreak: { projectId, storeId, recordId } });
const resultOf = (project: Project, store: Store, record: AtlasRecord): FabricResult => ({ project: { id: project.id, name: project.name }, store: { id: store.id, name: store.name }, record, score: 1, matchedFields: [], snippet: store.schema.fields.map(field => `${field.name}: ${typeof record.data[field.name] === "object" ? JSON.stringify(record.data[field.name]) : String(record.data[field.name] ?? "")}`).join(" | ").slice(0, 500), reasons: ["validated structured Core query"], projection: { searchableFields: store.schema.fields.map(field => field.name), displayOnlyFields: [] }, ranking: emptyRanking(project.id, store.id, record.id) });

const validateOperator = (field: FieldDefinition, filter: RecordFilter) => {
    if (["gt", "gte", "lt", "lte"].includes(filter.operator) && !["number", "date", "datetime", "string"].includes(field.type)) throw new Error(`Operator '${filter.operator}' is invalid for ${field.type} field '${field.name}'.`);
    if (filter.operator === "contains" && !["string", "array"].includes(field.type)) throw new Error(`Operator 'contains' is invalid for ${field.type} field '${field.name}'.`);
    if (filter.operator === "in" && !Array.isArray(filter.value)) throw new Error(`Filter 'in' for '${field.name}' requires an array.`);
};
const isEmptyObject = (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0;

export class AskAtlasRetrievalExecutor {
    constructor(readonly context: ContextProvider, readonly catalog: StructuredCatalog, readonly authority?: AuthorityProvider) {}
    async execute(plan: AskAtlasRetrievalPlan, catalog: { projects: Project[]; stores: Store[] }, input: { question: string; projectIds?: string[]; maxRecords?: number }): Promise<RetrievalExecution> {
        if (plan.intent === "unknown") {
            const response = await this.context.request({ query: input.question, projectIds: input.projectIds, maxRecords: input.maxRecords });
            return { context: response, strategy: "fabric", operations: [{ type: "fabric_fallback", query: input.question, returned: response.selections.length, reason: "unknown_interpreter_intent" }] };
        }
        const operations: Array<Record<string, unknown>> = []; const structured: FabricResult[] = []; const fabric: ContextResponse[] = [];
        for (const query of plan.structuredQueries ?? []) {
            const { project, store } = this.resolve(query, catalog, input.projectIds);
            const filters = (query.filters ?? []).filter(filter => !(plan.desiredResultType === "list" && isEmptyObject(filter.value)));
            const fields = new Map(store.schema.fields.map(field => [field.name, field]));
            for (const filter of filters) { const definition = fields.get(filter.field); if (!definition) throw new Error(`Unknown field '${filter.field}' for store '${store.name}'.`); validateOperator(definition, filter); }
            const limit = Math.min(query.limit ?? 100, 100); const page = await this.catalog.queryRecords({ projectId: project.id, storeId: store.id, filters, limit, offset: 0 });
            structured.push(...page.items.map(record => resultOf(project, store, record))); operations.push({ type: "structured", projectId: project.id, projectName: project.name, storeId: store.id, storeName: store.name, filters, returned: page.items.length, total: page.total, limit });
        }
        for (const query of plan.semanticQueries ?? []) { const response = await this.context.request({ query, projectIds: input.projectIds, maxRecords: input.maxRecords }); fabric.push(response); operations.push({ type: "fabric", query, returned: response.selections.length }); }
        if ((!structured.length && !fabric.some(response => response.selections.length) && !(plan.semanticQueries ?? []).includes(input.question)) || (plan.intent === "entity_lookup" && !(plan.semanticQueries ?? []).includes(input.question))) { const response = await this.context.request({ query: input.question, projectIds: input.projectIds, maxRecords: input.maxRecords }); fabric.push(response); operations.push({ type: "fabric_fallback", query: input.question, returned: response.selections.length }); }
        const combined = [...structured, ...fabric.flatMap(response => response.selections)]; const deduped = [...new Map(combined.map(result => [result.record.id, result])).values()];
        let selections = deduped; let decisions = fabric.flatMap(response => response.diagnostics.authorityDecisions); let authorityStatus: ContextResponse["diagnostics"]["authorityStatus"] = "ready"; let authorityError: string | undefined;
        if (this.authority) try { const applied = await this.authority.apply(deduped); selections = applied.results; decisions = applied.decisions; } catch (error) { authorityStatus = "unavailable"; authorityError = error instanceof Error ? error.message : String(error); }
        const maxRecords = Math.min(Math.max(input.maxRecords ?? 10, 1), 50);
        const truncated = selections.length > maxRecords || operations.some(operation => operation.type === "structured" && Number(operation.total) > Number(operation.returned)) || fabric.some(response => response.diagnostics.truncated);
        selections = selections.slice(0, maxRecords);
        const base = fabric[0]?.diagnostics;
        if (fabric.some(response => response.diagnostics.authorityStatus === "unavailable")) {
            authorityStatus = "unavailable";
            authorityError ??= fabric.find(response => response.diagnostics.authorityError)?.diagnostics.authorityError;
        }
        const context: ContextResponse = { query: input.question, selections, diagnostics: { searchedProjects: base?.searchedProjects ?? catalog.projects.length, searchedStores: base?.searchedStores ?? catalog.stores.length, candidateCount: deduped.length, selectedCount: selections.length, maxRecords, truncated, semanticStatus: base?.semanticStatus, semanticError: base?.semanticError, relevanceFloorRejected: fabric.reduce((sum, response) => sum + response.diagnostics.relevanceFloorRejected, 0), authorityStatus, ...(authorityError && { authorityError }), authorityDecisions: decisions, authoritySuppressed: decisions.reduce((sum, decision) => sum + decision.suppressedRecordIds.length, 0), unresolvedConflicts: decisions.filter(decision => decision.unresolvedAmbiguity).length, redundancyRejected: fabric.reduce((sum, response) => sum + response.diagnostics.redundancyRejected, 0), diversification: fabric.flatMap(response => response.diagnostics.diversification) } };
        return { context, strategy: structured.length && fabric.length ? "mixed" : structured.length ? "structured" : "fabric", operations };
    }
    private resolve(query: StructuredRetrievalQuery, catalog: { projects: Project[]; stores: Store[] }, allowedProjectIds?: string[]) {
        let project = catalog.projects.find(item => item.id === query.project || normalized(item.name) === normalized(query.project));
        let requestedStore = query.store;
        if (!project) {
            const swappedStore = catalog.stores.find(item => item.id === query.project || normalized(item.name) === normalized(query.project));
            const swappedProject = swappedStore && catalog.projects.find(item => item.id === swappedStore.projectId && (item.id === query.store || normalized(item.name) === normalized(query.store)));
            const repeatedStore = swappedStore && catalog.stores.find(item => item.id === query.store || normalized(item.name) === normalized(query.store));
            if (swappedStore && swappedProject) { project = swappedProject; requestedStore = swappedStore.id; }
            else if (swappedStore && repeatedStore?.id === swappedStore.id) { project = catalog.projects.find(item => item.id === swappedStore.projectId); requestedStore = swappedStore.id; }
        }
        if (!project || (allowedProjectIds?.length && !allowedProjectIds.includes(project.id))) throw new Error(`Unknown or disallowed project '${query.project}'.`);
        const store = catalog.stores.find(item => item.projectId === project.id && (item.id === requestedStore || normalized(item.name) === normalized(requestedStore)));
        if (!store) throw new Error(`Unknown store '${requestedStore}' in project '${project.name}'.`);
        return { project, store };
    }
}
