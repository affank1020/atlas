import type { AskAtlasModel, AskAtlasResponse } from "./types";

export const ASK_ATLAS_HISTORY_KEY = "atlas.observatory.ask-atlas.history";
export const ASK_ATLAS_HISTORY_VERSION = 1;

export type AskAtlasConfig = {
    projectIds: string[];
    retrievalMode: "auto" | "direct" | "planned";
    model: AskAtlasModel;
    maxRecords: number;
};

export type AskAtlasMessage = {
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
    status: "pending" | "complete" | "error";
    response?: AskAtlasResponse;
    error?: string;
    config?: AskAtlasConfig;
};

export type AskAtlasConversation = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    config: AskAtlasConfig;
    messages: AskAtlasMessage[];
};

export type AskAtlasHistory = {
    version: typeof ASK_ATLAS_HISTORY_VERSION;
    activeConversationId: string;
    conversations: AskAtlasConversation[];
};

export const defaultAskAtlasConfig = (): AskAtlasConfig => ({ projectIds: [], retrievalMode: "auto", model: "qwen3:4b", maxRecords: 10 });

const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const now = () => new Date().toISOString();

export function createConversation(config: AskAtlasConfig = defaultAskAtlasConfig()): AskAtlasConversation {
    const timestamp = now();
    return { id: id(), title: "New conversation", createdAt: timestamp, updatedAt: timestamp, config: { ...config, projectIds: [...config.projectIds] }, messages: [] };
}

export function emptyHistory(config?: AskAtlasConfig): AskAtlasHistory {
    const conversation = createConversation(config);
    return { version: ASK_ATLAS_HISTORY_VERSION, activeConversationId: conversation.id, conversations: [conversation] };
}

export function titleForQuestion(question: string): string {
    const compact = question.replace(/\s+/g, " ").trim();
    return compact.length > 56 ? `${compact.slice(0, 55).trimEnd()}…` : compact || "New conversation";
}

function validConfig(value: unknown): value is AskAtlasConfig {
    if (!value || typeof value !== "object") return false;
    const config = value as Record<string, unknown>;
    return Array.isArray(config.projectIds) && config.projectIds.every(item => typeof item === "string") &&
        ["auto", "direct", "planned"].includes(String(config.retrievalMode)) &&
        ["qwen3:1.7b", "qwen3:4b"].includes(String(config.model)) &&
        Number.isInteger(config.maxRecords) && Number(config.maxRecords) >= 1 && Number(config.maxRecords) <= 50;
}

function validMessage(value: unknown): value is AskAtlasMessage {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    return typeof message.id === "string" && ["user", "assistant"].includes(String(message.role)) &&
        typeof message.content === "string" && typeof message.createdAt === "string" &&
        ["pending", "complete", "error"].includes(String(message.status)) && (message.config === undefined || validConfig(message.config));
}

function validConversation(value: unknown): value is AskAtlasConversation {
    if (!value || typeof value !== "object") return false;
    const conversation = value as Record<string, unknown>;
    return typeof conversation.id === "string" && typeof conversation.title === "string" &&
        typeof conversation.createdAt === "string" && typeof conversation.updatedAt === "string" &&
        validConfig(conversation.config) && Array.isArray(conversation.messages) && conversation.messages.every(validMessage);
}

export function parseHistory(raw: string | null): AskAtlasHistory {
    if (!raw) return emptyHistory();
    try {
        const value = JSON.parse(raw) as Record<string, unknown>;
        if (value.version !== ASK_ATLAS_HISTORY_VERSION || !Array.isArray(value.conversations) || !value.conversations.every(validConversation)) return emptyHistory();
        const conversations = (value.conversations as AskAtlasConversation[]).map(conversation => ({ ...conversation, messages: conversation.messages.map(message => message.status === "pending" ? { ...message, status: "error" as const, error: "This request was interrupted when the page closed. Retry to continue." } : message) }));
        if (!conversations.length) return emptyHistory();
        const activeConversationId = typeof value.activeConversationId === "string" && conversations.some(item => item.id === value.activeConversationId)
            ? value.activeConversationId
            : [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!.id;
        return { version: ASK_ATLAS_HISTORY_VERSION, activeConversationId, conversations };
    } catch {
        return emptyHistory();
    }
}

export function loadHistory(storage: Pick<Storage, "getItem"> | undefined, key = ASK_ATLAS_HISTORY_KEY): AskAtlasHistory {
    if (!storage) return emptyHistory();
    try { return parseHistory(storage.getItem(key)); } catch { return emptyHistory(); }
}

export function saveHistory(storage: Pick<Storage, "setItem"> | undefined, history: AskAtlasHistory, key = ASK_ATLAS_HISTORY_KEY): boolean {
    if (!storage) return false;
    try { storage.setItem(key, JSON.stringify(history)); return true; } catch { return false; }
}

export function removeConversation(history: AskAtlasHistory, conversationId: string): AskAtlasHistory {
    const remaining = history.conversations.filter(item => item.id !== conversationId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!remaining.length) return emptyHistory();
    return { ...history, conversations: remaining, activeConversationId: history.activeConversationId === conversationId ? remaining[0]!.id : history.activeConversationId };
}

export function clearHistory(storage: Pick<Storage, "removeItem"> | undefined, key = ASK_ATLAS_HISTORY_KEY): AskAtlasHistory {
    try { storage?.removeItem(key); } catch { /* local storage is best-effort */ }
    return emptyHistory();
}
