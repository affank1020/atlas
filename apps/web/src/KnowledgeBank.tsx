import { useEffect, useState } from 'react';
import { callTool } from './api';
import './knowledge-bank.css';

type Collection = 'entries' | 'sources' | 'sections' | 'relations';
type KnowledgeRecord = {
    id: string; title?: string; name?: string; kind?: string; summary?: string; detail?: string;
    description?: string; sourceKey?: string; sourceType?: string; sourceTypeResolved?: string | null;
    sourceTitle?: string | null; sourceRole?: string; originalUrl?: string; sourceOriginalUrl?: string | null; sourceLink?: string;
    pageLink?: string; pageStart?: number; pageEnd?: number; locator?: string; sectionKey?: string;
    sectionLabel?: string; authors?: string; year?: number; doi?: string; citation?: string;
    status?: string; claimProvenance?: string; reviewStatus?: string; sourceExcerpt?: string;
    rationale?: string; fromEntryKey?: string; toEntryKey?: string; relationType?: string;
    relationProvenance?: string; linkNotes?: string; tags?: string[]; groupKeys?: string[];
};
type Page = { items: KnowledgeRecord[]; total: number; limit: number; offset: number };
type Overview = { groups: { id: string; key: string; name: string; status?: string }[]; counts: Record<string, number> };
const collections: { value: Collection; label: string; description: string }[] = [
    { value: 'entries', label: 'Knowledge', description: 'Concepts, methods, findings, arguments and examples' },
    { value: 'sources', label: 'Sources', description: 'Original documents, papers and lecture notes' },
    { value: 'sections', label: 'Chapters', description: 'Source sections and ingestion progress' },
    { value: 'relations', label: 'Connections', description: 'Relationships between source-grounded entries' },
];
const kindOptions = ['concept','definition','method','standard','finding','argument','example','criticism','comparison','summary','other'];
const sourceTypes = [
    ['lecture_notes','Lecture notes'], ['paper','Research papers'], ['book','Books'], ['documentation','Documentation'],
    ['webpage','Webpages'], ['slides','Slides'], ['transcript','Transcripts'], ['other','Other'],
];
const safeLink = (value?: string) => {
    if (!value) return '';
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.toString() : ''; }
    catch { return ''; }
};
const titleFor = (r: KnowledgeRecord) => r.title || r.name || r.sectionLabel || r.relationType || 'Untitled record';
const number = (n: number) => n.toLocaleString('en-GB');
const emptyOverview: Overview = { groups: [], counts: {} };

export function KnowledgeBank() {
    const [collection, setCollection] = useState<Collection>('entries');
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [group, setGroup] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] || '').get('group') || '');
    const [sourceType, setSourceType] = useState('');
    const [entryKind, setEntryKind] = useState('');
    const [tag, setTag] = useState('');
    const [sourceKey, setSourceKey] = useState('');
    const [sourceLabel, setSourceLabel] = useState('');
    const [sourceSearch, setSourceSearch] = useState('');
    const [suggestions, setSuggestions] = useState<KnowledgeRecord[]>([]);
    const [suggestOpen, setSuggestOpen] = useState(false);
    const [offset, setOffset] = useState(0);
    const [page, setPage] = useState<Page>({ items: [], total: 0, offset: 0, limit: 25 });
    const [overview, setOverview] = useState<Overview>(emptyOverview);
    const [selectedId, setSelectedId] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [refreshToken, setRefreshToken] = useState(0);
    const selected = page.items.find(r => r.id === selectedId);
    const activeCollection = collections.find(c => c.value === collection)!;

    useEffect(() => {
        const token = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
        return () => window.clearTimeout(token);
    }, [query]);
    useEffect(() => {
        const controller = new AbortController();
        callTool<Overview>('knowledge_bank_overview', {}, controller.signal)
            .then(value => { if (!controller.signal.aborted) setOverview(value); })
            .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
        return () => controller.abort();
    }, [refreshToken]);
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true); setError('');
        callTool<Page>('knowledge_bank_browse', {
            collection, q: debouncedQuery, group, sourceKey, sourceType,
            entryKind: collection === 'entries' ? entryKind : '', tag, offset, limit: 25,
        }, controller.signal)
            .then(value => {
                if (controller.signal.aborted) return;
                setPage(value);
                setSelectedId(previous => value.items.some(r => r.id === previous) ? previous : '');
            })
            .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [collection, debouncedQuery, group, sourceKey, sourceType, entryKind, tag, offset, refreshToken]);
    useEffect(() => {
        if (!suggestOpen) return;
        const controller = new AbortController();
        const token = window.setTimeout(() => {
            callTool<Page>('knowledge_bank_browse', {
                collection: 'sources', q: sourceSearch.trim(), group: '', sourceKey: '',
                sourceType: '', entryKind: '', tag: '', offset: 0, limit: 20,
            }, controller.signal)
                .then(value => { if (!controller.signal.aborted) setSuggestions(value.items); })
                .catch(() => { if (!controller.signal.aborted) setSuggestions([]); });
        }, 180);
        return () => { window.clearTimeout(token); controller.abort(); };
    }, [sourceSearch, suggestOpen]);

    const resetOffset = () => { setOffset(0); setSelectedId(''); };
    const switchCollection = (next: Collection) => { setCollection(next); resetOffset(); };
    const setSource = (r: KnowledgeRecord) => {
        setSourceKey(r.sourceKey || ''); setSourceLabel(titleFor(r)); setSuggestOpen(false); setSourceSearch(''); resetOffset();
    };
    const clear = () => {
        setQuery(''); setDebouncedQuery(''); setGroup(''); setSourceKey(''); setSourceLabel('');
        setSourceSearch(''); setSourceType(''); setEntryKind(''); setTag(''); resetOffset();
    };
    const pageStart = page.total ? page.offset + 1 : 0;
    const pageEnd = Math.min(page.total, page.offset + page.items.length);

    return <div className="knowledge-app">
        <header className="knowledge-head">
            <div className="knowledge-eyebrow">ATLAS / KNOWLEDGE BANK</div>
            <div className="knowledge-title-row">
                <div><h1>Your research, organised.</h1><p>A single, source-grounded library for notes, papers and connected ideas.</p></div>
                <button type="button" className="knowledge-refresh" onClick={() => setRefreshToken(n => n + 1)}>↻ Refresh</button>
            </div>
            <div className="knowledge-overview" aria-label="Library totals">
                <span><strong>{number(overview.counts['Knowledge Sources'] || 0)}</strong> sources</span>
                <span><strong>{number(overview.counts['Knowledge Entries'] || 0)}</strong> knowledge entries</span>
                <span><strong>{number(overview.counts['Knowledge Sections'] || 0)}</strong> sections</span>
                <span><strong>{number(overview.counts['Knowledge Relationships'] || 0)}</strong> connections</span>
            </div>
        </header>
        <div className="knowledge-layout">
            <aside className="knowledge-search" aria-label="Knowledge filters">
                <div className="knowledge-filter-head"><h2>Find knowledge</h2><button type="button" onClick={clear}>Clear all</button></div>
                <label htmlFor="knowledge-query">Search entire library</label>
                <input id="knowledge-query" type="search" placeholder="Search titles, concepts, content…" value={query}
                    onChange={e => { setQuery(e.target.value); resetOffset(); }} />
                <label htmlFor="knowledge-group">Knowledge group</label>
                <select id="knowledge-group" value={group} onChange={e => { setGroup(e.target.value); resetOffset(); }}>
                    <option value="">All groups</option>
                    {overview.groups.map(g => <option key={g.key} value={g.key}>{g.name}</option>)}
                </select>
                <label htmlFor="knowledge-source-input">Original document</label>
                {sourceKey ? <div className="knowledge-selected-source"><span title={sourceLabel}>{sourceLabel}</span><button type="button" aria-label="Clear source filter" onClick={() => { setSourceKey(''); setSourceLabel(''); resetOffset(); }}>×</button></div>
                : <div className="knowledge-source-picker">
                    <input id="knowledge-source-input" type="search" placeholder="Find a source…" value={sourceSearch}
                        onFocus={() => setSuggestOpen(true)} onChange={e => { setSourceSearch(e.target.value); setSuggestOpen(true); }} />
                    {suggestOpen && <div className="knowledge-suggestions" role="group" aria-label="Matching sources">
                        {suggestions.length === 0 ? <p>No matching sources.</p> : suggestions.map(r =>
                            <button type="button" key={r.id} onClick={() => setSource(r)}>{titleFor(r)}<small>{r.sourceType || 'Source'}</small></button>)}
                        <button type="button" className="knowledge-dismiss" onClick={() => setSuggestOpen(false)}>Close source picker</button>
                    </div>}
                  </div>}
                <label htmlFor="knowledge-source-type">Document type</label>
                <select id="knowledge-source-type" value={sourceType} onChange={e => { setSourceType(e.target.value); resetOffset(); }}>
                    <option value="">All document types</option>
                    {sourceTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                {collection === 'entries' && <><label htmlFor="knowledge-kind">Knowledge type</label>
                    <select id="knowledge-kind" value={entryKind} onChange={e => { setEntryKind(e.target.value); resetOffset(); }}>
                        <option value="">All knowledge types</option>
                        {kindOptions.map(k => <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.slice(1)}</option>)}
                    </select></>}
                <label htmlFor="knowledge-tag">Topic tag</label>
                <input id="knowledge-tag" value={tag} onChange={e => { setTag(e.target.value); resetOffset(); }}
                    placeholder="e.g. user research" type="search" />
                <p className="knowledge-filter-note">Filters run against all matching PostgreSQL records, not just this page.</p>
            </aside>
            <main className="knowledge-content">
                <div className="knowledge-tabs" role="tablist" aria-label="Library collections">
                    {collections.map(c => <button type="button" role="tab" aria-selected={collection === c.value}
                        key={c.value} onClick={() => switchCollection(c.value)}>{c.label}</button>)}
                </div>
                <div className="knowledge-content-heading">
                    <div><h2>{activeCollection.label}</h2><p>{activeCollection.description}</p></div>
                    <span className="knowledge-count">{loading ? 'Searching…' : `${number(page.total)} results`}</span>
                </div>
                {error && <div className="knowledge-error" role="alert">Could not load the library: {error}
                    <button type="button" onClick={() => setRefreshToken(n => n + 1)}>Retry</button></div>}
                {!error && <div className="knowledge-results">
                    {loading ? <p className="knowledge-muted" role="status">Searching the knowledge bank…</p> :
                        page.items.length === 0 ? <div className="knowledge-empty">
                            <strong>{collection === 'entries' && !debouncedQuery && !group && !sourceKey && !tag && !entryKind ? 'No knowledge ingested yet' : 'No matching records'}</strong>
                            <p>{collection === 'entries' && !debouncedQuery && !group && !sourceKey && !tag && !entryKind
                                ? 'Send the first UX chapter to ChatGPT to begin filling the bank.'
                                : 'Try a different search term or remove a filter.'}</p>
                        </div> : <div className="knowledge-result-list">
                            {page.items.map(item => <button type="button" className={`knowledge-result ${selectedId === item.id ? 'active' : ''}`}
                                key={item.id} onClick={() => setSelectedId(item.id)}>
                                <div className="knowledge-result-header"><strong>{titleFor(item)}</strong><span>{item.kind || item.sourceType || item.status || item.relationType || 'Section'}</span></div>
                                <p>{item.summary || item.description || item.rationale || (collection === 'sources' ? 'Original document and reference' : 'Open for details')}</p>
                                <small>{item.sourceTitle || (collection === 'sources' ? item.authors || item.sourceRole : item.sourceKey) || 'Knowledge Bank'}
                                    {item.locator ? ` · ${item.locator}` : ''}</small>
                            </button>)}
                          </div>}
                    {!loading && page.total > 0 && <nav className="knowledge-pagination" aria-label="Results pagination">
                        <span>{number(pageStart)}–{number(pageEnd)} of {number(page.total)}</span>
                        <div><button type="button" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 25)); setSelectedId(''); }}>Previous</button>
                        <button type="button" disabled={offset + 25 >= page.total} onClick={() => { setOffset(offset + 25); setSelectedId(''); }}>Next</button></div>
                    </nav>}
                </div>}
            </main>
            <aside className="knowledge-detail" aria-label="Record details">
                {selected ? <div>
                    <div className="knowledge-detail-label">SOURCE-GROUNDED RECORD</div>
                    <h2>{titleFor(selected)}</h2>
                    <div className="knowledge-pills">{[selected.kind, selected.sourceType || selected.sourceTypeResolved || undefined, selected.claimProvenance, selected.reviewStatus, selected.status].filter(Boolean).map((v,i) => <span key={i}>{v}</span>)}</div>
                    {selected.summary && <section><h3>Summary</h3><p>{selected.summary}</p></section>}
                    {selected.detail && <section><h3>Detailed notes</h3><p>{selected.detail}</p></section>}
                    {selected.description && <section><h3>Description</h3><p>{selected.description}</p></section>}
                    {selected.sourceExcerpt && <section><h3>Short source excerpt</h3><blockquote>{selected.sourceExcerpt}</blockquote></section>}
                    {selected.rationale && <section><h3>Relationship</h3><p>{selected.rationale}</p><small>{selected.fromEntryKey} → {selected.toEntryKey}</small></section>}
                    <section><h3>Original reference</h3>
                        <dl>
                            {selected.sourceTitle && <><dt>Source</dt><dd>{selected.sourceTitle}</dd></>}
                            {selected.sourceKey && <><dt>Source key</dt><dd>{selected.sourceKey}</dd></>}
                            {selected.sectionKey && <><dt>Section</dt><dd>{selected.sectionKey}</dd></>}
                            {selected.locator && <><dt>Location</dt><dd>{selected.locator}</dd></>}
                            {selected.pageStart !== undefined && <><dt>Pages</dt><dd>{selected.pageStart}{selected.pageEnd !== undefined && selected.pageEnd !== selected.pageStart ? `–${selected.pageEnd}` : ''}</dd></>}
                            {selected.authors && <><dt>Authors</dt><dd>{selected.authors}</dd></>}
                            {selected.doi && <><dt>DOI</dt><dd>{selected.doi}</dd></>}
                            {selected.citation && <><dt>Citation</dt><dd>{selected.citation}</dd></>}
                        </dl>
                        {safeLink(selected.sourceLink || selected.pageLink || selected.originalUrl || selected.sourceOriginalUrl || '') && <a className="knowledge-link"
                            href={safeLink(selected.sourceLink || selected.pageLink || selected.originalUrl || selected.sourceOriginalUrl || '')}
                            target="_blank" rel="noreferrer noopener">{selected.sourceLink || selected.pageLink ? 'Open cited passage ↗' : 'Open original source ↗'}</a>}
                        {selected.linkNotes && <p className="knowledge-muted">{selected.linkNotes}</p>}
                    </section>
                    {!!selected.tags?.length && <section><h3>Topics</h3><div className="knowledge-pills">{selected.tags.map(t => <span key={t}>{t}</span>)}</div></section>}
                    {collection === 'sources' && selected.sourceKey && <button className="knowledge-source-open" type="button"
                        onClick={() => { setSource(selected); switchCollection('entries'); }}>Find knowledge from this source →</button>}
                </div> : <div className="knowledge-detail-prompt"><span>↗</span><h2>Inspect a record</h2><p>Select an item to see its full notes, references and original document links.</p></div>}
            </aside>
        </div>
    </div>;
}
