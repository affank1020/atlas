import { useEffect, useMemo, useState } from "react";
import { callTool } from "./api";
import type { FabricContextResponse, FabricResult, FabricSearchResponse, Project, RetrievalMode } from "./types";

type Mode = "search_atlas" | "request_context";
type Run = { id: string; mode: Mode; retrievalMode?: RetrievalMode; timestamp: string; query: string; projectIds: string[]; size: number; response: FabricSearchResponse | FabricContextResponse };
type Comparison = { records: string; ordering: string; scores: string; diagnostics: string; canonicalChanged: boolean };
const EXAMPLES = ["Amazon software engineering internship", "OA", "MEMORY VISIBILITY", "graduate job search", "LSEG OA completed", "purple submarine recipes on mars"];
const HISTORY_KEY = "atlas-observatory-fabric-history-v1";

const resultsOf = (run: Run) => run.mode === "search_atlas" ? (run.response as FabricSearchResponse).results : (run.response as FabricContextResponse).selections;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const stable = (value: unknown) => JSON.stringify(canonical(value));
const count = (value: unknown) => typeof value === "number" ? value : 0;
const label = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, x => x.toUpperCase());
const rankingFlag = (result: FabricResult, key: string) => result.ranking?.[key] === true;

function compareRuns(previous: Run, current: Run): Comparison {
    const before = resultsOf(previous), after = resultsOf(current);
    const beforeIds = before.map(x => x.record.id), afterIds = after.map(x => x.record.id);
    const canonicalChanged = stable(before.map(x => x.record)) !== stable(after.map(x => x.record));
    return {
        records: stable([...beforeIds].sort()) === stable([...afterIds].sort()) ? `Same ${afterIds.length} record IDs` : "Record IDs changed",
        ordering: stable(beforeIds) === stable(afterIds) ? "Same ordering" : "Ordering changed",
        scores: stable(before.map(x => x.score)) === stable(after.map(x => x.score)) ? "Same scores" : "Scores changed",
        diagnostics: stable(previous.response.diagnostics) === stable(current.response.diagnostics) ? "Same diagnostics" : "Diagnostics changed",
        canonicalChanged,
    };
}

function Scalar({ value }: { value: unknown }) {
    if (value === null) return <span className="value-null">null</span>;
    if (typeof value === "boolean") return <span className={`value-boolean ${value}`}>{String(value)}</span>;
    if (typeof value === "number") return <span className="value-number">{value}</span>;
    return <span>{String(value)}</span>;
}

function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
    if (Array.isArray(value)) return <ol className="nested-value">{value.map((item, i) => <li key={i}><Value value={item} depth={depth + 1} /></li>)}</ol>;
    if (value && typeof value === "object") return <dl className={`record-data depth-${Math.min(depth, 2)}`}>{Object.entries(value as Record<string, unknown>).map(([key, item]) => <div key={key}><dt>{key}</dt><dd><Value value={item} depth={depth + 1} /></dd></div>)}</dl>;
    return <Scalar value={value} />;
}

function Diagnostics({ value }: { value: Record<string, unknown> }) {
    return <section className="fabric-diagnostics"><div className="section-label">Request diagnostics</div><Value value={value} /></section>;
}

function Diversification({ diagnostics }: { diagnostics: Record<string, unknown> }) {
    const decisions = Array.isArray(diagnostics.diversification) ? diagnostics.diversification as Array<Record<string, unknown>> : [];
    if (!decisions.length) return null;
    return <section className="diversification"><div><p className="eyebrow">Context selection</p><h3>Diversification decisions</h3></div>{decisions.map((decision, index) => <article key={index}><div><small>Dropped record</small><code>{String(decision.droppedRecordId ?? "—")}</code></div><span>→</span><div><small>Kept record</small><code>{String(decision.keptRecordId ?? "—")}</code></div><div><small>Overlap</small><strong>{String(decision.overlap ?? "—")}</strong></div><p>{String(decision.reason ?? "No reason returned.")}</p></article>)}</section>;
}

function AuthorityDecisions({ diagnostics }: { diagnostics: Record<string, unknown> }) {
    const decisions = Array.isArray(diagnostics.authorityDecisions) ? diagnostics.authorityDecisions as Array<Record<string, unknown>> : [];
    if (!decisions.length && diagnostics.authorityStatus !== "unavailable") return null;
    return <section className="authority-decisions"><div><p className="eyebrow">Authority policy</p><h3>{diagnostics.authorityStatus === "unavailable" ? "Policy unavailable" : `${decisions.length} equivalence decision${decisions.length === 1 ? "" : "s"}`}</h3>{Boolean(diagnostics.authorityError) && <p>{String(diagnostics.authorityError)}</p>}</div>{decisions.map((decision, index) => <article className={decision.unresolvedAmbiguity ? "unresolved" : ""} key={String(decision.equivalenceGroupId ?? index)}><header><code>{String(decision.equivalenceGroupId ?? "—")}</code><span>{String(decision.equivalenceKind ?? "unknown")}</span><b>{String(decision.contradictionStatus ?? "none")} conflict</b></header><div className="authority-flow"><div><small>Preferred</small><code>{String(decision.preferredRecordId ?? "Unresolved")}</code></div><span>→</span><div><small>Suppressed</small><code>{Array.isArray(decision.suppressedRecordIds) && decision.suppressedRecordIds.length ? decision.suppressedRecordIds.join(", ") : "None"}</code></div></div><p>{String(decision.reason ?? "No reason returned.")}</p><details><summary>Equivalent records and temporal evidence</summary><Value value={decision.records} /></details></article>)}</section>;
}

function ResultCard({ result, position, context, onOpen }: { result: FabricResult; position: number; context: boolean; onOpen: () => void }) {
    return <article className="fabric-result">
        <header><div className="result-rank">{context ? `Selected ${position}` : `#${position}`}</div><div><h3>{result.project.name} <span>/</span> {result.store.name}</h3><code>{result.record.id}</code></div><div className="score"><small>Score</small><strong>{result.score}</strong></div></header>
        <div className="result-body"><section><div className="section-label">Canonical record</div><Value value={result.record.data} /></section><aside><div className="section-label">Retrieval</div><div className="source-row"><span>Sources</span>{rankingFlag(result, "lexicalFound") && <b className="source lexical">Lexical</b>}{rankingFlag(result, "semanticFound") && <b className="source semantic">Semantic</b>}{!rankingFlag(result, "lexicalFound") && !rankingFlag(result, "semanticFound") && <b className="source">Not reported</b>}</div><p className="snippet">{result.snippet || "No snippet returned."}</p><div className="chip-row">{result.matchedFields?.map(field => <span className="chip" key={field}>{field}</span>)}</div><ul className="reason-list">{result.reasons?.map(reason => <li key={reason}>{reason}</li>)}</ul><details><summary>Ranking components</summary><Value value={result.ranking} /></details>{result.projection && <details><summary>Projection metadata</summary><Value value={result.projection} /></details>}</aside></div>
        <footer><a href={`#/projects/${result.project.id}/stores/${result.store.id}/records`}>Open store</a><button className="ghost" onClick={onOpen}>Inspect full result</button></footer>
    </article>;
}

function ResultModal({ result, onClose }: { result: FabricResult; onClose: () => void }) {
    return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="modal fabric-modal"><header><div><p className="eyebrow">Fabric result</p><h2>{result.project.name} / {result.store.name}</h2></div><button className="icon" onClick={onClose} aria-label="Close">×</button></header><div className="fabric-modal-body"><h3>Canonical record</h3><Value value={result.record} /><h3>Complete retrieval metadata</h3><Value value={Object.fromEntries(Object.entries(result).filter(([key]) => key !== "record"))} /><details open><summary>Raw response fragment</summary><pre className="raw-json">{JSON.stringify(result, null, 2)}</pre></details></div></section></div>;
}

function RunView({ run, comparison, onAgain, onInspect }: { run: Run; comparison?: Comparison; onAgain: () => void; onInspect: (result: FabricResult) => void }) {
    const results = resultsOf(run), context = run.mode === "request_context";
    return <div className="fabric-output"><div className="run-summary"><div><p className="eyebrow">{context ? "Actual bounded context pack" : "Search candidates and ranking"}</p><h2>{run.response.query}</h2><p>{context ? `Selected ${results.length} / max ${run.size}` : `${results.length} returned · ${count(run.response.diagnostics.candidateCount)} candidates`}</p></div><button className="ghost" onClick={onAgain}>Run again</button></div>
        {comparison && <section className={`determinism ${comparison.canonicalChanged ? "warning" : ""}`}><div><p className="eyebrow">Determinism check</p><h3>{comparison.canonicalChanged ? "Canonical data changed between runs" : "Meaningful retrieval output compared"}</h3></div><ul>{[comparison.records, comparison.ordering, comparison.scores, comparison.diagnostics].map(item => <li className={item.includes("changed") ? "changed" : "same"} key={item}>{item}</li>)}</ul>{comparison.canonicalChanged && <p>Differences are not labelled nondeterministic because the source records changed.</p>}</section>}
        <Diagnostics value={run.response.diagnostics} />
        {context && <AuthorityDecisions diagnostics={run.response.diagnostics} />}
        {context && <Diversification diagnostics={run.response.diagnostics} />}
        {!results.length && <div className="fabric-empty"><h3>{context ? "Valid empty context pack" : "No results"}</h3><p>{context ? "Fabric selected zero records; none may have cleared its relevance threshold." : "No active records matched this query and project scope."}</p></div>}
        <div className="fabric-results">{results.map((result, i) => <ResultCard key={`${result.record.id}-${i}`} result={result} position={i + 1} context={context} onOpen={() => onInspect(result)} />)}</div>
        <details className="raw-response"><summary>Raw JSON response</summary><pre className="raw-json">{JSON.stringify(run.response, null, 2)}</pre></details>
    </div>;
}

function ModeComparison({ runs, onOpen }: { runs: Run[]; onOpen: (run: Run) => void }) {
    if (!runs.length) return null;
    return <section className="mode-comparison"><div className="section-label">Same query · authoritative Fabric outputs</div><div>{runs.map(run => <button key={run.id} onClick={() => onOpen(run)}><span className={`mode-dot ${run.retrievalMode}`} /> <b>{label(run.retrievalMode ?? "hybrid")}</b><strong>{resultsOf(run).length} returned</strong><small>{count(run.response.diagnostics.candidateCount)} candidates · semantic {String(run.response.diagnostics.semanticStatus ?? "—")}</small><ol>{resultsOf(run).slice(0, 5).map(result => <li key={result.record.id}><span>{result.project.name} / {result.store.name}</span><code>{result.score}</code></li>)}</ol></button>)}</div></section>;
}

export function Fabric() {
    const [projects, setProjects] = useState<Project[]>([]); const [projectError, setProjectError] = useState("");
    const [query, setQuery] = useState(""); const [projectIds, setProjectIds] = useState<string[]>([]); const [searchMode, setSearchMode] = useState<RetrievalMode>("hybrid"); const [limit, setLimit] = useState(20); const [maxRecords, setMaxRecords] = useState(5);
    const [history, setHistory] = useState<Run[]>(() => { try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY) || "[]") as Run[]; } catch { return []; } });
    const [activeId, setActiveId] = useState(history[0]?.id); const [comparison, setComparison] = useState<Comparison>(); const [comparisonPair, setComparisonPair] = useState<[Run, Run]>(); const [modeRuns, setModeRuns] = useState<Run[]>([]); const [busy, setBusy] = useState<Mode | "compare" | "modes">(); const [error, setError] = useState(""); const [detail, setDetail] = useState<FabricResult>();
    useEffect(() => { callTool<Project[]>("list_projects").then(setProjects).catch(e => setProjectError(e.message)); }, []);
    useEffect(() => { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 20))); }, [history]);
    const active = history.find(x => x.id === activeId);
    const run = async (mode: Mode, isRepeat = false, retrievalOverride = searchMode) => {
        const trimmed = query.trim(); if (!trimmed) { setError("Enter a query before running Fabric."); return undefined; }
        const size = mode === "search_atlas" ? limit : maxRecords; setBusy(mode); setError(""); setComparison(undefined);
        try {
            const input = { query: trimmed, ...(projectIds.length && { projectIds }), ...(mode === "search_atlas" ? { limit, mode: retrievalOverride } : { maxRecords }) };
            const response = mode === "search_atlas" ? await callTool<FabricSearchResponse>(mode, input) : await callTool<FabricContextResponse>(mode, input);
            const next: Run = { id: crypto.randomUUID(), mode, ...(mode === "search_atlas" && { retrievalMode: retrievalOverride }), timestamp: new Date().toISOString(), query: trimmed, projectIds: [...projectIds], size, response };
            const previous = history.find(item => item.mode === mode && item.retrievalMode === next.retrievalMode && item.query === trimmed && item.size === size && stable([...item.projectIds].sort()) === stable([...projectIds].sort()));
            setHistory(items => [next, ...items].slice(0, 20)); setActiveId(next.id); if (isRepeat && previous) setComparison(compareRuns(previous, next)); return next;
        } catch (e) { setError((e as Error).message); return undefined; } finally { setBusy(undefined); }
    };
    const compare = async () => { setBusy("compare"); const search = await run("search_atlas", false, "hybrid"); const context = search ? await run("request_context") : undefined; if (search && context) setComparisonPair([search, context]); setBusy(undefined); };
    const compareModes = async () => { setBusy("modes"); const runs: Run[] = []; for (const mode of ["lexical", "semantic", "hybrid"] as RetrievalMode[]) { const result = await run("search_atlas", false, mode); if (result) runs.push(result); } setModeRuns(runs); setBusy(undefined); };
    const reopen = (item: Run) => { setQuery(item.query); setProjectIds(item.projectIds); if (item.mode === "search_atlas") { setLimit(item.size); setSearchMode(item.retrievalMode ?? "hybrid"); } else setMaxRecords(item.size); setActiveId(item.id); setComparison(undefined); setError(""); };
    const selectedNames = useMemo(() => projects.filter(p => projectIds.includes(p.id)).map(p => p.name), [projects, projectIds]);
    return <><header className="page-head"><div><p className="eyebrow">Read-only inspection surface</p><h1>Fabric</h1><p>Issue retrieval requests, inspect canonical records and ranking metadata, compare bounded context selection, and test determinism.</p></div></header>
        <div className="fabric-layout"><div className="fabric-main"><section className="panel fabric-controls"><div className="panel-head"><div><h2>Query Fabric</h2><p>One query, two exposed MCP capabilities. Requests run only when submitted.</p></div><span className="readonly-badge">Read only</span></div><div className="fabric-form"><label>Query<textarea aria-label="Fabric query" value={query} onChange={e => setQuery(e.target.value)} placeholder="What should Fabric retrieve?" /></label><div className="examples">{EXAMPLES.map(x => <button className="example" key={x} onClick={() => setQuery(x)}>{x}</button>)}</div><fieldset><legend>Project scope</legend><label className="project-option"><input type="checkbox" checked={!projectIds.length} onChange={() => setProjectIds([])} /> All active projects</label>{projects.map(project => <label className="project-option" key={project.id}><input type="checkbox" checked={projectIds.includes(project.id)} onChange={e => setProjectIds(ids => e.target.checked ? [...ids, project.id] : ids.filter(id => id !== project.id))} /> {project.name}</label>)}{projectError && <p className="form-error">Projects unavailable: {projectError}</p>}</fieldset><div className="fabric-limits"><label>Search mode<select aria-label="Search mode" value={searchMode} onChange={e => setSearchMode(e.target.value as RetrievalMode)}><option value="lexical">Lexical</option><option value="semantic">Semantic</option><option value="hybrid">Hybrid</option></select></label><label>Search limit<input aria-label="Search limit" type="number" min="1" max="100" value={limit} onChange={e => setLimit(Number(e.target.value))} /></label><label>Context maxRecords<input aria-label="Context maxRecords" type="number" min="1" max="50" value={maxRecords} onChange={e => setMaxRecords(Number(e.target.value))} /></label><div><small>Current scope</small><strong>{selectedNames.length ? selectedNames.join(", ") : "All active projects"}</strong></div></div><div className="fabric-actions"><button disabled={!!busy} onClick={() => run("search_atlas")}>{busy === "search_atlas" ? "Searching…" : `Search ${searchMode}`}</button><button disabled={!!busy} onClick={() => run("request_context")}>{busy === "request_context" ? "Selecting…" : "Request context"}</button><button className="ghost" disabled={!!busy} onClick={compareModes}>{busy === "modes" ? "Running modes…" : "Compare modes"}</button><button className="ghost" disabled={!!busy} onClick={compare}>{busy === "compare" ? "Comparing…" : "Search + Context"}</button></div></div></section>{error && <div className="notice error"><b>Fabric request failed.</b> {error}</div>}<ModeComparison runs={modeRuns} onOpen={reopen} />{comparisonPair && <section className="compare-pipeline"><button onClick={() => reopen(comparisonPair[0])}><small>Hybrid search candidates / ranking</small><strong>{count(comparisonPair[0].response.diagnostics.candidateCount)} candidates · {resultsOf(comparisonPair[0]).length} returned</strong></button><span>→</span><button onClick={() => reopen(comparisonPair[1])}><small>Bounded context selection</small><strong>{resultsOf(comparisonPair[1]).length} selected / max {comparisonPair[1].size}</strong></button></section>}{active && <RunView run={active} comparison={comparison} onAgain={() => run(active.mode, true, active.retrievalMode ?? "hybrid")} onInspect={setDetail} />}</div><aside className="fabric-history"><div className="section-label">Session history</div>{history.map(item => <button className={item.id === activeId ? "active" : ""} key={item.id} onClick={() => reopen(item)}><span>{item.mode === "search_atlas" ? `Search · ${item.retrievalMode ?? "hybrid"}` : "Context · hybrid"}</span><b>{item.query}</b><small>{new Date(item.timestamp).toLocaleTimeString()} · {item.projectIds.length ? `${item.projectIds.length} filtered` : "all projects"} · {item.mode === "search_atlas" ? `limit ${item.size}` : `max ${item.size}`}</small><small>{count(item.response.diagnostics.candidateCount)} candidates · {resultsOf(item).length} {item.mode === "search_atlas" ? "returned" : "selected"}</small></button>)}{!history.length && <p>No Fabric requests in this browser session.</p>}</aside></div>{detail && <ResultModal result={detail} onClose={() => setDetail(undefined)} />}</>;
}
