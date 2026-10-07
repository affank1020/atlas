import type { RecordFilter } from "../../types.js";

export type RetrievalIntent = "structured_query" | "entity_lookup" | "semantic_search" | "cross_store_summary" | "mixed" | "unknown";
export type StructuredRetrievalQuery = { project: string; store: string; filters?: RecordFilter[]; limit?: number };
export type AskAtlasRetrievalPlan = {
    intent: RetrievalIntent;
    structuredQueries?: StructuredRetrievalQuery[];
    semanticQueries?: string[];
    desiredResultType?: "single" | "list" | "summary";
    explanation?: string;
};

const intents = new Set<RetrievalIntent>(["structured_query", "entity_lookup", "semantic_search", "cross_store_summary", "mixed", "unknown"]);
const operators = new Set(["eq", "neq", "in", "contains", "gt", "gte", "lt", "lte"]);

export function parseRetrievalPlan(value: unknown): AskAtlasRetrievalPlan {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Interpreter plan must be an object.");
    const raw = value as Record<string, unknown>;
    if (!intents.has(raw.intent as RetrievalIntent)) throw new Error(`Interpreter returned unsupported intent '${String(raw.intent)}'.`);
    const structuredQueries = raw.structuredQueries === undefined ? undefined : (() => {
        if (!Array.isArray(raw.structuredQueries) || raw.structuredQueries.length > 4) throw new Error("Interpreter structuredQueries must contain at most four operations.");
        return raw.structuredQueries.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid structured query.");
            const query = item as Record<string, unknown>;
            if (typeof query.project !== "string" || typeof query.store !== "string") throw new Error("Structured queries require project and store names or IDs.");
            const filters = query.filters === undefined ? undefined : (() => {
                if (!Array.isArray(query.filters) || query.filters.length > 8) throw new Error("Structured query filters must contain at most eight filters.");
                return query.filters.map((filter) => {
                    if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("Invalid structured filter.");
                    const candidate = filter as Record<string, unknown>;
                    if (typeof candidate.field !== "string" || !operators.has(String(candidate.operator))) throw new Error("Invalid structured filter field or operator.");
                    return { field: candidate.field, operator: candidate.operator as RecordFilter["operator"], value: candidate.value };
                });
            })();
            const limit = query.limit === undefined ? undefined : Number(query.limit);
            if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error("Structured query limit must be between 1 and 100.");
            return { project: query.project, store: query.store, ...(filters && { filters }), ...(limit && { limit }) };
        });
    })();
    const semanticQueries = raw.semanticQueries === undefined ? undefined : (() => {
        if (!Array.isArray(raw.semanticQueries) || raw.semanticQueries.length > 2 || raw.semanticQueries.some(query => typeof query !== "string" || !query.trim())) throw new Error("semanticQueries must contain at most two non-empty strings.");
        return raw.semanticQueries.map(String);
    })();
    const desired = raw.desiredResultType;
    if (desired !== undefined && !["single", "list", "summary"].includes(String(desired))) throw new Error("Invalid desiredResultType.");
    return { intent: raw.intent as RetrievalIntent, ...(structuredQueries && { structuredQueries }), ...(semanticQueries && { semanticQueries }), ...(desired !== undefined ? { desiredResultType: desired as AskAtlasRetrievalPlan["desiredResultType"] } : {}), ...(typeof raw.explanation === "string" ? { explanation: raw.explanation.slice(0, 500) } : {}) };
}
