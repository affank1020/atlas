import type { ContextResponse } from "../../fabric/types.js";

export const ASK_ATLAS_MODELS = ["qwen3:1.7b", "qwen3:4b"] as const;
export type AskAtlasModel = typeof ASK_ATLAS_MODELS[number];
export const DEFAULT_ASK_ATLAS_MODEL: AskAtlasModel = "qwen3:4b";

export type ConversationMessage = { role: "user" | "assistant"; content: string };

export type AskAtlasInput = { history?: ConversationMessage[]; retrievalMode?: "auto" | "direct" | "planned"; question: string; projectIds?: string[]; maxRecords?: number; model?: AskAtlasModel };

export type AskAtlasSource = {
    label: string;
    projectId: string;
    projectName: string;
    storeId: string;
    storeName: string;
    recordId: string;
    snippet: string;
};

export type AskAtlasDiagnostics = {
    provider: string;
    model: string;
    latencyMs?: number;
    truncated?: boolean;
    semanticStatus?: string;
    semanticError?: string;
    validationFailure?: string;
    conversationTurns?: number;
    contextRecordCount: number;
    authorityStatus: ContextResponse["diagnostics"]["authorityStatus"];
    unresolvedConflicts: number;
    relevantUnresolvedConflicts: number;
    authorityDecisions: ContextResponse["diagnostics"]["authorityDecisions"];
    relevanceFloorRejected: number;
    authoritySuppressed: number;
    redundancyRejected: number;
    retrievalPlan?: {
        originalQuery: string;
        augmentedQueries?: string[];
        reason?: string;
    };
    interpreter?: {
        provider: string;
        model: AskAtlasModel;
        intent?: string;
        plan?: unknown;
        validationStatus: "valid" | "invalid" | "unavailable";
        error?: string;
    };
    retrieval?: {
        strategy: "structured" | "fabric" | "mixed";
        operations: Array<Record<string, unknown>>;
    };
};

export type AskAtlasResponse = {
    question: string;
    abstained?: boolean;
    answer: string;
    sources: AskAtlasSource[];
    diagnostics: AskAtlasDiagnostics;
};

export type GenerationRequest = {
    model: AskAtlasModel;
    system: string;
    question: string;
    evidence: string;
    responseStyle?: "answer" | "record_list";
    history?: ConversationMessage[];
};

export interface AnswerGenerationProvider {
    readonly name: string;
    readonly model: AskAtlasModel;
    generate(request: GenerationRequest): Promise<string>;
}
