import { describe, expect, it } from "vitest";
import { ASK_ATLAS_HISTORY_KEY, ASK_ATLAS_HISTORY_VERSION, clearHistory, createConversation, emptyHistory, loadHistory, parseHistory, removeConversation, saveHistory, titleForQuestion } from "./askAtlasHistory";
import type { AskAtlasHistory } from "./askAtlasHistory";

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
        value: (key: string) => values.get(key),
    };
}

describe("Ask Atlas local history", () => {
    it("creates useful bounded titles", () => {
        expect(titleForQuestion("  What   happened with LSEG?  ")).toBe("What happened with LSEG?");
        expect(titleForQuestion("x".repeat(80))).toHaveLength(56);
    });

    it("round-trips the versioned structure", () => {
        const storage = memoryStorage();
        const history = emptyHistory();
        history.conversations[0]!.title = "A saved chat";
        expect(saveHistory(storage, history)).toBe(true);
        expect(JSON.parse(storage.value(ASK_ATLAS_HISTORY_KEY)!).version).toBe(ASK_ATLAS_HISTORY_VERSION);
        expect(loadHistory(storage).conversations[0]!.title).toBe("A saved chat");
    });

    it("recovers from malformed, outdated, empty, and inaccessible storage", () => {
        expect(parseHistory("not json").conversations).toHaveLength(1);
        expect(parseHistory(JSON.stringify({ version: 999, conversations: [] })).conversations).toHaveLength(1);
        expect(parseHistory(JSON.stringify({ version: ASK_ATLAS_HISTORY_VERSION, conversations: [], activeConversationId: "missing" })).conversations).toHaveLength(1);
        expect(loadHistory({ getItem: () => { throw new Error("denied"); } })).toHaveProperty("conversations.length", 1);
        expect(saveHistory({ setItem: () => { throw new Error("full"); } }, emptyHistory())).toBe(false);
    });

    it("deletes the active conversation cleanly and clearing removes the dedicated key", () => {
        const first = createConversation(); const second = createConversation();
        const history: AskAtlasHistory = { version: ASK_ATLAS_HISTORY_VERSION, activeConversationId: first.id, conversations: [first, second] };
        const next = removeConversation(history, first.id);
        expect(next.activeConversationId).toBe(second.id);
        const storage = memoryStorage(); storage.setItem(ASK_ATLAS_HISTORY_KEY, "saved");
        expect(clearHistory(storage).conversations).toHaveLength(1);
        expect(storage.value(ASK_ATLAS_HISTORY_KEY)).toBeUndefined();
    });
});
