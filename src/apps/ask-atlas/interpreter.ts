import type { Project, Store } from "../../types.js";
import type { AskAtlasModel, ConversationMessage } from "./types.js";
import { parseRetrievalPlan, type AskAtlasRetrievalPlan } from "./retrieval-plan.js";

export type AtlasCatalogReader = {
    listProjects(includeArchived?: boolean): Promise<Project[]>;
    listStores(projectId: string, includeArchived?: boolean): Promise<Store[]>;
};
export interface InterpretationProvider { readonly name: string; interpret(input: { model: AskAtlasModel; system: string; prompt: string }): Promise<unknown>; }
export const DEFAULT_INTERPRETER_MODEL: AskAtlasModel = "qwen3:4b";

export class AskAtlasInterpreter {
    constructor(readonly provider: InterpretationProvider, readonly catalog: AtlasCatalogReader, readonly model: AskAtlasModel = DEFAULT_INTERPRETER_MODEL) {}
    async interpret(question: string, projectIds?: string[], history: ConversationMessage[] = []): Promise<{ plan: AskAtlasRetrievalPlan; catalog: { projects: Project[]; stores: Store[] }; validationStatus: "valid" }> {
        const projects = (await this.catalog.listProjects()).filter(project => !projectIds?.length || projectIds.includes(project.id));
        const stores = (await Promise.all(projects.map(project => this.catalog.listStores(project.id)))).flat();
        const description = projects.map(project => ({ id: project.id, name: project.name, ...(project.description && { description: project.description }), stores: stores.filter(store => store.projectId === project.id).map(store => ({ id: store.id, name: store.name, ...(store.description && { description: store.description }), fields: store.schema.fields.map(field => ({ name: field.name, type: field.type, ...(field.enumValues && { enumValues: field.enumValues }) })) })) }));
        const raw = await this.provider.interpret({ model: this.model, system: "You are the Ask Atlas retrieval planner. Never answer the user. Resolve follow-up references using the conversation, but treat previous assistant answers as unverified, not evidence. semanticQueries must be standalone search queries that preserve named entities and the user's constraints. For entity questions and follow-up dates, prefer semantic_search with a standalone query naming the subject from conversation (for example LSEG online assessment completion date); do not invent a structured field or filter. Search across stores rather than assuming a single store contains the whole answer. Return only one JSON retrieval plan using the supplied catalog. Use structured_query for exact store filters and complete lists; entity_lookup for a named entity in a structured store; semantic_search for broad/fuzzy personal context; mixed only when both are necessary. For complete lists of submitted applications, prefer a canonical applications store over an openings, opportunities, or read-only mirror store, so Not Applied opportunities are excluded. A complete list usually needs no filters. For pending online assessments, use every catalog store that explicitly models actual assessment state: query oaStatus=pending where available and status='OA Received' where available; never include status='Not Applied' or completed assessments. Use only scalar or array filter values exactly matching catalog field semantics. Never invent catalog names, fields, operators, or values.", prompt: `Atlas catalog:\n${JSON.stringify(description)}\n\nConversation (for reference resolution only):\n${JSON.stringify(history)}\n\nUser question:\n${question}\n\nReturn JSON with intent, optional structuredQueries, optional semanticQueries, desiredResultType, and a short explanation.` });
        return { plan: parseRetrievalPlan(raw), catalog: { projects, stores }, validationStatus: "valid" };
    }
}
