import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskAtlas } from "./AskAtlas";
import { ASK_ATLAS_HISTORY_KEY } from "./askAtlasHistory";
import type { AskAtlasResponse } from "./types";

const api = vi.hoisted(() => ({ callTool: vi.fn(), callAskAtlas: vi.fn() }));
vi.mock("./api", () => api);

const response: AskAtlasResponse = {
    question: "What happened with LSEG?",
    answer: "The assessment was completed [S1].",
    sources: [{ label: "S1", projectId: "project-1", projectName: "Career", storeId: "store-1", storeName: "Applications", recordId: "record-1", snippet: "LSEG assessment completed." }],
    diagnostics: {
        provider: "ollama", model: "qwen3:4b", latencyMs: 42, contextRecordCount: 1, authorityStatus: "ready", unresolvedConflicts: 0,
        relevantUnresolvedConflicts: 0, authorityDecisions: [{ identity: "LSEG", reason: "current" }], relevanceFloorRejected: 2, authoritySuppressed: 1,
        redundancyRejected: 0, retrieval: { strategy: "mixed", operations: [{ type: "semantic_search", returned: 1 }] },
        interpreter: { provider: "ollama", model: "qwen3:4b", intent: "semantic_search", plan: { semanticQueries: ["LSEG"] }, validationStatus: "valid" },
    },
};

function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

beforeEach(() => {
    localStorage.clear();
    api.callTool.mockReset().mockResolvedValue([{ id: "project-1", name: "Career", createdAt: "2026-01-01", updatedAt: "2026-01-01" }]);
    api.callAskAtlas.mockReset();
});
afterEach(() => cleanup());

describe("Ask Atlas chat workspace", () => {
    it("creates a conversation, shows genuine pending state, then renders an answer", async () => {
        const request = deferred<{ response: AskAtlasResponse; modelFieldAccepted: boolean }>();
        api.callAskAtlas.mockReturnValue(request.promise);
        const user = userEvent.setup(); render(<AskAtlas />);
        await user.type(screen.getByLabelText("Message Ask Atlas"), "What happened with LSEG?");
        await user.click(screen.getByLabelText("Send message"));
        expect(within(screen.getByLabelText("Conversation")).getByText("What happened with LSEG?")).toBeInTheDocument();
        expect(screen.getByText("Working on your question…")).toBeInTheDocument();
        expect(api.callAskAtlas).toHaveBeenCalledWith(expect.objectContaining({ question: "What happened with LSEG?", retrievalMode: "auto", maxRecords: 10 }), "qwen3:4b");
        await act(async () => request.resolve({ response, modelFieldAccepted: true }));
        expect(await screen.findByText("The assessment was completed [S1].")).toBeInTheDocument();
        expect(screen.getByText("mixed retrieval")).toBeInTheDocument();
    });

    it("opens history, switches chats, deletes one, and confirms clear all", async () => {
        api.callAskAtlas.mockResolvedValue({ response, modelFieldAccepted: true });
        const user = userEvent.setup(); render(<AskAtlas />);
        await user.type(screen.getByLabelText("Message Ask Atlas"), "What happened with LSEG?"); await user.click(screen.getByLabelText("Send message"));
        await screen.findByText(response.answer); await user.click(screen.getByRole("button", { name: "New chat" }));
        expect(screen.getByText("What would you like to know?")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /History/ }));
        const dialog = screen.getByRole("dialog", { name: "Conversation history" });
        await user.click(within(dialog).getByText("What happened with LSEG?").closest("button")!);
        expect(screen.getByText(response.answer)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /History/ }));
        await user.click(within(screen.getByRole("dialog")).getByLabelText("Delete What happened with LSEG?"));
        expect(within(screen.getByRole("dialog")).queryByText("What happened with LSEG?")).not.toBeInTheDocument();
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear all history" }));
        expect(screen.getByText("Delete every local conversation?")).toBeInTheDocument();
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear all" }));
        expect(screen.getByText("What would you like to know?")).toBeInTheDocument();
        expect(localStorage.getItem(ASK_ATLAS_HISTORY_KEY)).toBeNull();
    });

    it("persists conversations across remount and ignores malformed local data", async () => {
        api.callAskAtlas.mockResolvedValue({ response, modelFieldAccepted: true });
        const user = userEvent.setup(); const view = render(<AskAtlas />);
        await user.type(screen.getByLabelText("Message Ask Atlas"), "What happened with LSEG?"); await user.click(screen.getByLabelText("Send message"));
        await screen.findByText(response.answer); await waitFor(() => expect(localStorage.getItem(ASK_ATLAS_HISTORY_KEY)).toContain(response.answer));
        view.unmount(); render(<AskAtlas />); expect(screen.getByText(response.answer)).toBeInTheDocument();
        view.unmount(); localStorage.setItem(ASK_ATLAS_HISTORY_KEY, "broken"); render(<AskAtlas />); expect(screen.getByText("What would you like to know?")).toBeInTheDocument();
    });

    it("updates scope and advanced controls and sends them with the request", async () => {
        api.callAskAtlas.mockResolvedValue({ response, modelFieldAccepted: true });
        const user = userEvent.setup(); render(<AskAtlas />);
        await user.click(screen.getByText("Advanced"));
        await user.click(await screen.findByRole("checkbox", { name: "Career" }));
        await user.selectOptions(screen.getByLabelText("Retrieval mode"), "planned");
        await user.selectOptions(screen.getByLabelText("Answering model"), "qwen3:1.7b");
        fireEvent.change(screen.getByLabelText("Evidence limit"), { target: { value: "6" } });
        await user.type(screen.getByLabelText("Message Ask Atlas"), "What happened with LSEG?"); await user.click(screen.getByLabelText("Send message"));
        expect(api.callAskAtlas).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ["project-1"], retrievalMode: "planned", maxRecords: 6 }), "qwen3:1.7b");
    });

    it("opens response sources, retrieval, diagnostics, raw data, and record navigation", async () => {
        api.callAskAtlas.mockResolvedValue({ response, modelFieldAccepted: true });
        const user = userEvent.setup(); render(<AskAtlas />);
        await user.type(screen.getByLabelText("Message Ask Atlas"), "What happened with LSEG?"); await user.click(screen.getByLabelText("Send message"));
        await user.click(await screen.findByRole("button", { name: "1 source" }));
        const inspector = screen.getByRole("dialog", { name: "Evidence & diagnostics" });
        expect(within(inspector).getByText("LSEG assessment completed.")).toBeInTheDocument();
        expect(within(inspector).getByRole("link", { name: /Open record’s store/ })).toHaveAttribute("href", "#/projects/project-1/stores/store-1/records");
        await user.click(within(inspector).getByRole("button", { name: "Retrieval" })); expect(within(inspector).getByText("Executed strategy")).toBeInTheDocument(); expect(within(inspector).getByText(/semanticQueries/)).toBeInTheDocument();
        await user.click(within(inspector).getByRole("button", { name: "Diagnostics" })); expect(within(inspector).getByText("Authority decisions")).toBeInTheDocument();
        await user.click(within(inspector).getByRole("button", { name: "Raw" })); expect(within(inspector).getByText(/assessment was completed/)).toBeInTheDocument();
    });

    it("renders a failed request and retries it without duplicating the user message", async () => {
        api.callAskAtlas.mockRejectedValueOnce(new Error("backend unavailable")).mockResolvedValueOnce({ response, modelFieldAccepted: true });
        const user = userEvent.setup(); render(<AskAtlas />);
        await user.type(screen.getByLabelText("Message Ask Atlas"), "What happened with LSEG?"); await user.click(screen.getByLabelText("Send message"));
        expect(await screen.findByText("backend unavailable")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText(response.answer)).toBeInTheDocument();
        expect(within(screen.getByLabelText("Conversation")).getAllByText("What happened with LSEG?")).toHaveLength(1);
        expect(api.callAskAtlas).toHaveBeenCalledTimes(2);
    });
});
