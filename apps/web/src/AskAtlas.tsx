import { useEffect, useMemo, useRef, useState } from "react";
import { callAskAgent, callAskAtlas, callTool } from "./api";
import {
    clearHistory, createConversation, defaultAskAtlasConfig, loadHistory, removeConversation, saveHistory, titleForQuestion,
    type AskAtlasConfig, type AskAtlasConversation, type AskAtlasHistory, type AskAtlasMessage,
} from "./askAtlasHistory";
import type { AskAtlasModel, AskAtlasResponse, Project } from "./types";

const ATLAS_EXAMPLES = ["What happened with my LSEG application?", "What happened with Capital One?", "What do you know about my Amazon internship?"];
const MODELS: AskAtlasModel[] = ["qwen3:1.7b", "qwen3:4b"];
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const fmtTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function historyMessages(messages: AskAtlasMessage[]) {
    return messages.filter(message => message.status === "complete").slice(-12).map(message => ({ role: message.role, content: message.content.slice(0, 4000) }));
}

function HistoryDialog({ history, busy, agentName, onClose, onNew, onOpen, onDelete, onClear }: {
    history: AskAtlasHistory; busy: boolean; agentName: string; onClose: () => void; onNew: () => void; onOpen: (id: string) => void; onDelete: (id: string) => void; onClear: () => void;
}) {
    const [query, setQuery] = useState("");
    const [confirmClear, setConfirmClear] = useState(false);
    const conversations = useMemo(() => [...history.conversations]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .filter(item => item.title.toLowerCase().includes(query.trim().toLowerCase())), [history.conversations, query]);
    return <div className="ask-overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}>
        <section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title">
            <header><div><p className="eyebrow">{agentName}</p><h2 id="history-title">Conversation history</h2></div><button type="button" className="icon" onClick={onClose} aria-label="Close history">×</button></header>
            <div className="history-tools"><label><span className="sr-only">Search conversations</span><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search conversations…" /></label><button type="button" onClick={onNew} disabled={busy}>New chat</button></div>
            <div className="history-list">
                {conversations.map(conversation => <article className={conversation.id === history.activeConversationId ? "active" : ""} key={conversation.id}>
                    <button type="button" className="history-open" disabled={busy} onClick={() => onOpen(conversation.id)}>
                        <b>{conversation.title}</b><span>{conversation.messages.filter(message => message.role === "user").length} questions · {fmtTime(conversation.updatedAt)}</span>
                    </button>
                    <button type="button" className="history-delete" disabled={busy} onClick={() => onDelete(conversation.id)} aria-label={`Delete ${conversation.title}`}>×</button>
                </article>)}
                {!conversations.length && <div className="history-empty">No conversations match that search.</div>}
            </div>
            <footer>{confirmClear ? <div className="clear-confirm"><span>Delete every local conversation?</span><button type="button" className="ghost" onClick={() => setConfirmClear(false)}>Cancel</button><button type="button" className="danger-solid" onClick={onClear}>Clear all</button></div> : <button type="button" className="link danger" disabled={busy} onClick={() => setConfirmClear(true)}>Clear all history</button>}</footer>
        </section>
    </div>;
}

function JsonBlock({ value }: { value: unknown }) { return <pre className="raw-json">{JSON.stringify(value, null, 2)}</pre>; }

function Inspector({ response, config, toolName, scopeName, onClose }: { response: AskAtlasResponse; config: AskAtlasConfig; toolName: string; scopeName?: string; onClose: () => void }) {
    const [tab, setTab] = useState<"sources" | "retrieval" | "diagnostics" | "raw">("sources");
    const diagnostics = response.diagnostics;
    const diagnosticItems = [
        ["Provider", diagnostics.provider], ["Model used", diagnostics.model], ["Requested model", diagnostics.requestedModel], ["Resolved model", diagnostics.resolvedModel],
        ["Latency", typeof diagnostics.latencyMs === "number" ? `${diagnostics.latencyMs} ms` : undefined], ["Context records", diagnostics.contextRecordCount],
        ["Authority", diagnostics.authorityStatus], ["Unresolved conflicts", diagnostics.unresolvedConflicts], ["Relevant conflicts", diagnostics.relevantUnresolvedConflicts],
        ["Authority suppressed", diagnostics.authoritySuppressed], ["Relevance rejected", diagnostics.relevanceFloorRejected], ["Redundancy rejected", diagnostics.redundancyRejected],
        ["Semantic status", diagnostics.semanticStatus], ["Conversation turns", diagnostics.conversationTurns], ["Evidence truncated", diagnostics.truncated],
    ].filter(([, value]) => value !== undefined);
    return <div className="inspector-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
        <aside className="response-inspector" role="dialog" aria-modal="true" aria-labelledby="inspector-title">
            <header><div><p className="eyebrow">Response inspector</p><h2 id="inspector-title">Evidence & diagnostics</h2></div><button type="button" className="icon" onClick={onClose} aria-label="Close inspector">×</button></header>
            <nav aria-label="Inspector sections">{(["sources", "retrieval", "diagnostics", "raw"] as const).map(item => <button type="button" key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}{item === "sources" ? ` (${response.sources.length})` : ""}</button>)}</nav>
            <div className="inspector-body">
                {tab === "sources" && <section aria-label="Sources">
                    {response.sources.map(source => <article className="inspector-source" key={`${source.storeId}-${source.recordId}`}>
                        <header><span className="source-label">{source.label}</span><div><b>{source.projectName}</b><span>{source.storeName}</span></div></header>
                        <p>{source.snippet}</p>
                        <dl><div><dt>Record</dt><dd><code>{source.recordId}</code></dd></div><div><dt>Store</dt><dd><code>{source.storeId}</code></dd></div></dl>
                        {scopeName ? <span className="derived-source-note">Derived Contentful document</span> : <a href={`#/projects/${source.projectId}/stores/${source.storeId}/records`}>Open record’s store <span aria-hidden="true">↗</span></a>}
                    </article>)}
                    {!response.sources.length && <div className="inspector-empty"><h3>No supporting sources</h3><p>This response did not cite a Fabric search document. Check retrieval and diagnostics for more detail.</p></div>}
                </section>}
                {tab === "retrieval" && <section className="inspector-section">
                    <h3>Request</h3><dl className="inspector-facts"><div><dt>Question</dt><dd>{response.question}</dd></div><div><dt>Requested mode</dt><dd>{config.retrievalMode}</dd></div><div><dt>Executed strategy</dt><dd>{diagnostics.retrieval?.strategy ?? "Not reported"}</dd></div><div><dt>Scope</dt><dd>{scopeName ?? (config.projectIds.length ? `${config.projectIds.length} selected project${config.projectIds.length === 1 ? "" : "s"}` : "All active projects")}</dd></div><div><dt>Evidence limit</dt><dd>{config.maxRecords} records</dd></div></dl>
                    {diagnostics.interpreter && <><h3>Interpretation</h3><JsonBlock value={diagnostics.interpreter} /></>}
                    {diagnostics.retrieval && <><h3>Retrieval operations</h3><JsonBlock value={diagnostics.retrieval} /></>}
                    {diagnostics.retrievalPlan && <><h3>Deterministic augmentation</h3><JsonBlock value={diagnostics.retrievalPlan} /></>}
                    {!diagnostics.interpreter && !diagnostics.retrieval && !diagnostics.retrievalPlan && <p className="muted-copy">The backend did not return detailed retrieval metadata for this response.</p>}
                </section>}
                {tab === "diagnostics" && <section className="inspector-section"><h3>Answer generation</h3><dl className="inspector-facts">{diagnosticItems.map(([label, value]) => <div key={String(label)}><dt>{String(label)}</dt><dd>{String(value)}</dd></div>)}</dl>
                    {diagnostics.validationFailure && <div className="inspector-warning"><b>Validation failure</b><span>{diagnostics.validationFailure}</span></div>}
                    {diagnostics.semanticError && <div className="inspector-warning"><b>Semantic error</b><span>{diagnostics.semanticError}</span></div>}
                    <h3>Authority decisions</h3><JsonBlock value={diagnostics.authorityDecisions} />
                </section>}
                {tab === "raw" && <section className="inspector-section"><p className="muted-copy">Complete structured response returned by <code>{toolName}</code>.</p><JsonBlock value={response} /></section>}
            </div>
        </aside>
    </div>;
}

function ConfigControls({ config, projects, busy, fixedScope, onChange }: { config: AskAtlasConfig; projects: Project[]; busy: boolean; fixedScope?: string; onChange: (config: AskAtlasConfig) => void }) {
    const scopeLabel = fixedScope ?? (config.projectIds.length ? `${config.projectIds.length} project${config.projectIds.length === 1 ? "" : "s"}` : "All projects");
    const toggleProject = (projectId: string, checked: boolean) => onChange({ ...config, projectIds: checked ? [...config.projectIds, projectId] : config.projectIds.filter(id => id !== projectId) });
    return <details className="composer-settings">
        <summary><span className="setting-chip">Scope: {scopeLabel}</span><span className="setting-chip">Retrieval: {config.retrievalMode}</span><span className="setting-chip">Model: {config.model}</span><span className="setting-chip secondary">Advanced</span></summary>
        {!fixedScope && <fieldset disabled={busy}><legend>Search scope</legend><label className="project-option"><input type="checkbox" checked={!config.projectIds.length} onChange={() => onChange({ ...config, projectIds: [] })} /> All active projects</label>{projects.map(project => <label className="project-option" key={project.id}><input type="checkbox" checked={config.projectIds.includes(project.id)} onChange={event => toggleProject(project.id, event.target.checked)} /> {project.name}</label>)}</fieldset>}
        <div className="setting-grid">
            <label>Retrieval mode<select aria-label="Retrieval mode" disabled={busy} value={config.retrievalMode} onChange={event => onChange({ ...config, retrievalMode: event.target.value as AskAtlasConfig["retrievalMode"] })}><option value="auto">Automatic</option><option value="direct">Direct search</option><option value="planned">Planned retrieval</option></select></label>
            <label>Answering model<select aria-label="Answering model" disabled={busy} value={config.model} onChange={event => onChange({ ...config, model: event.target.value as AskAtlasModel })}>{MODELS.map(model => <option key={model}>{model}</option>)}</select></label>
            <label>Evidence limit<input aria-label="Evidence limit" disabled={busy} type="number" min="1" max="50" value={config.maxRecords} onChange={event => onChange({ ...config, maxRecords: Math.min(50, Math.max(1, Number(event.target.value) || 1)) })} /></label>
        </div>
    </details>;
}

export type AskChatProps = { agentName: string; toolName: "ask_atlas" | "ask_portfolio"; storageKey: string; introEyebrow: string; introCopy: string; examples: string[]; fixedScope?: string; banner?: React.ReactNode };

export function AskChat({ agentName, toolName, storageKey, introEyebrow, introCopy, examples, fixedScope, banner }: AskChatProps) {
    const [history, setHistory] = useState<AskAtlasHistory>(() => loadHistory(globalThis.window?.localStorage, storageKey));
    const [projects, setProjects] = useState<Project[]>([]);
    const [question, setQuestion] = useState("");
    const [busy, setBusy] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [inspected, setInspected] = useState<{ response: AskAtlasResponse; config: AskAtlasConfig }>();
    const [projectError, setProjectError] = useState("");
    const [storageAvailable, setStorageAvailable] = useState(true);
    const [modelFieldAccepted, setModelFieldAccepted] = useState<boolean>();
    const transcriptRef = useRef<HTMLDivElement>(null);
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const followOutput = useRef(true);
    const skipNextSave = useRef(false);
    const active = history.conversations.find(item => item.id === history.activeConversationId) ?? history.conversations[0]!;

    useEffect(() => { if (!fixedScope) callTool<Project[]>("list_projects", {}).then(setProjects).catch(error => setProjectError(error.message)); }, [fixedScope]);
    useEffect(() => {
        if (skipNextSave.current) { skipNextSave.current = false; return; }
        setStorageAvailable(saveHistory(globalThis.window?.localStorage, history, storageKey));
    }, [history, storageKey]);
    useEffect(() => {
        const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setHistoryOpen(false); setInspected(undefined); } };
        addEventListener("keydown", close); return () => removeEventListener("keydown", close);
    }, []);
    useEffect(() => {
        if (!followOutput.current) return;
        transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: busy ? "smooth" : "auto" });
    }, [active.messages, busy]);

    const mutateActive = (change: (conversation: AskAtlasConversation) => AskAtlasConversation) => setHistory(previous => ({ ...previous, conversations: previous.conversations.map(item => item.id === previous.activeConversationId ? change(item) : item) }));
    const updateConfig = (config: AskAtlasConfig) => mutateActive(conversation => ({ ...conversation, config, updatedAt: new Date().toISOString() }));
    const newChat = () => {
        const conversation = createConversation(active?.config ?? defaultAskAtlasConfig());
        setHistory(previous => ({ ...previous, activeConversationId: conversation.id, conversations: [conversation, ...previous.conversations] }));
        setQuestion(""); setHistoryOpen(false); setInspected(undefined); setTimeout(() => composerRef.current?.focus(), 0);
    };
    const deleteConversation = (conversationId: string) => { setHistory(previous => removeConversation(previous, conversationId)); setInspected(undefined); };
    const clearAll = () => { skipNextSave.current = true; setHistory(clearHistory(globalThis.window?.localStorage, storageKey)); setHistoryOpen(false); setInspected(undefined); };

    const submitQuestion = async (text: string, retryAssistantId?: string) => {
        const trimmed = text.trim();
        if (!trimmed || busy) return;
        const snapshot = active;
        const sentAt = new Date().toISOString();
        const assistantId = retryAssistantId ?? uid();
        let priorMessages = snapshot.messages;
        if (retryAssistantId) {
            const assistantIndex = snapshot.messages.findIndex(message => message.id === retryAssistantId);
            priorMessages = snapshot.messages.slice(0, Math.max(0, assistantIndex - 1));
            mutateActive(conversation => ({ ...conversation, updatedAt: sentAt, messages: conversation.messages.map(message => message.id === retryAssistantId ? { ...message, content: "", error: undefined, status: "pending" } : message) }));
        } else {
            const userMessage: AskAtlasMessage = { id: uid(), role: "user", content: trimmed, createdAt: sentAt, status: "complete" };
            const assistantMessage: AskAtlasMessage = { id: assistantId, role: "assistant", content: "", createdAt: sentAt, status: "pending", config: snapshot.config };
            mutateActive(conversation => ({ ...conversation, title: conversation.messages.length ? conversation.title : titleForQuestion(trimmed), updatedAt: sentAt, messages: [...conversation.messages, userMessage, assistantMessage] }));
            setQuestion("");
        }
        setBusy(true); setModelFieldAccepted(undefined); followOutput.current = true;
        const config = snapshot.config;
        const input = { question: trimmed, maxRecords: config.maxRecords, history: historyMessages(priorMessages), retrievalMode: config.retrievalMode, ...(!fixedScope && config.projectIds.length && { projectIds: config.projectIds }) };
        try {
            const result = toolName === "ask_atlas" ? await callAskAtlas<AskAtlasResponse>(input, config.model) : await callAskAgent<AskAtlasResponse>(toolName, input, config.model);
            const finishedAt = new Date().toISOString();
            mutateActive(conversation => ({ ...conversation, updatedAt: finishedAt, messages: conversation.messages.map(message => message.id === assistantId ? { ...message, content: result.response.answer, response: result.response, status: "complete" } : message) }));
            setModelFieldAccepted(result.modelFieldAccepted);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            mutateActive(conversation => ({ ...conversation, updatedAt: new Date().toISOString(), messages: conversation.messages.map(item => item.id === assistantId ? { ...item, content: "", error: message, status: "error" } : item) }));
        } finally { setBusy(false); setTimeout(() => composerRef.current?.focus(), 0); }
    };

    const onSubmit = (event: React.FormEvent) => { event.preventDefault(); void submitQuestion(question); };
    const scrollChanged = () => { const element = transcriptRef.current; if (element) followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120; };
    return <div className="ask-atlas-page" data-busy={busy}>
        <header className="ask-header"><div className="ask-title"><span className="atlas-mark" aria-hidden="true">✦</span><div><p className="eyebrow">{agentName}</p><h1>{active.title}</h1></div></div><div className="ask-header-actions"><span className="readonly-badge">Read only</span><button type="button" className="ghost" onClick={() => setHistoryOpen(true)}>History <span className="button-count">{history.conversations.length}</span></button><button type="button" onClick={newChat} disabled={busy}>New chat</button></div></header>
        {banner}
        <div className="ask-transcript" ref={transcriptRef} onScroll={scrollChanged} aria-live="polite" aria-label="Conversation">
            <div className="conversation-column">
                {!active.messages.length && <section className="ask-empty"><div className="empty-mark">✦</div><p className="eyebrow">{introEyebrow}</p><h2>What would you like to know?</h2><p>{introCopy}</p><div className="empty-examples">{examples.map(example => <button type="button" className="example" key={example} onClick={() => { setQuestion(example); composerRef.current?.focus(); }}>{example}</button>)}</div></section>}
                {active.messages.map((message, index) => message.role === "user" ? <article className="chat-message user-message" key={message.id}><div className="message-author">You</div><div className="message-content">{message.content}</div></article> : <article className={`chat-message assistant-message ${message.status}`} key={message.id}>
                    <div className="assistant-avatar" aria-hidden="true">✦</div><div className="assistant-content"><div className="message-author">{agentName.replace(/^Ask /, "")}</div>
                        {message.status === "pending" && <div className="assistant-pending" role="status"><span className="thinking-dots"><i /><i /><i /></span><span>Working on your question…</span></div>}
                        {message.status === "error" && <div className="assistant-error" role="alert"><b>{agentName} couldn’t answer.</b><span>{message.error}</span><button type="button" className="ghost" disabled={busy} onClick={() => void submitQuestion(active.messages[index - 1]?.content ?? "", message.id)}>Retry</button></div>}
                        {message.status === "complete" && <><div className="message-content assistant-answer">{message.content}</div>{message.response && <div className="response-meta"><button type="button" onClick={() => setInspected({ response: message.response!, config: message.config ?? active.config })}>{message.response.sources.length} source{message.response.sources.length === 1 ? "" : "s"}</button><span>·</span><span>{message.response.diagnostics.retrieval?.strategy ? `${message.response.diagnostics.retrieval.strategy} retrieval` : "retrieval details"}</span><span>·</span><button type="button" onClick={() => setInspected({ response: message.response!, config: message.config ?? active.config })}>Inspect</button></div>}</>}
                    </div>
                </article>)}
            </div>
        </div>
        <div className="composer-dock"><form className="chat-composer" onSubmit={onSubmit}><div className="composer-input"><label className="sr-only" htmlFor={`${toolName}-question`}>Message {agentName}</label><textarea id={`${toolName}-question`} ref={composerRef} autoFocus rows={1} maxLength={4000} disabled={busy} value={question} onChange={event => { setQuestion(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={active.messages.length ? "Ask a follow-up…" : `Ask anything about the ${fixedScope ?? "Atlas"}…`} /><button className="send-button" aria-label="Send message" disabled={busy || !question.trim()}>{busy ? <span className="send-spinner" /> : "↑"}</button></div><ConfigControls config={active.config} projects={projects} busy={busy} fixedScope={fixedScope} onChange={updateConfig} /></form>
            <div className="composer-foot"><span>Enter to send · Shift+Enter for a new line</span>{projectError && <span className="foot-error">Project scopes unavailable: {projectError}</span>}{!storageAvailable && <span className="foot-error">History is available for this session but couldn’t be saved locally.</span>}{modelFieldAccepted === false && <span className="compatibility-note">Legacy backend: model selection was not accepted.</span>}</div>
        </div>
        {historyOpen && <HistoryDialog history={history} busy={busy} agentName={agentName} onClose={() => setHistoryOpen(false)} onNew={newChat} onOpen={id => { setHistory(previous => ({ ...previous, activeConversationId: id })); setHistoryOpen(false); setInspected(undefined); }} onDelete={deleteConversation} onClear={clearAll} />}
        {inspected && <Inspector response={inspected.response} config={inspected.config} toolName={toolName} scopeName={fixedScope} onClose={() => setInspected(undefined)} />}
    </div>;
}

export function AskAtlas() {
    return <AskChat agentName="Ask Atlas" toolName="ask_atlas" storageKey="atlas.observatory.ask-atlas.history" introEyebrow="Grounded in your Atlas" introCopy="Ask about your records, then follow up naturally. Sources and retrieval details stay one click away." examples={ATLAS_EXAMPLES} />;
}
