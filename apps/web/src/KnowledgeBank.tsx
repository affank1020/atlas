import { useEffect, useRef, useState } from 'react';
import { callTool } from './api';
import { KnowledgeStudy } from './KnowledgeStudy';
import { KnowledgeRecordDetails, knowledgeTitle, type KnowledgeDetailRecord } from './KnowledgeRecordDetails';
import './knowledge-bank.css';

type Collection = 'entries' | 'sources' | 'sections' | 'relations';
type KnowledgeRecord = KnowledgeDetailRecord;
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
const titleFor = knowledgeTitle;
const number = (n: number) => n.toLocaleString('en-GB');
const emptyOverview: Overview = { groups: [], counts: {} };

export function KnowledgeBank() {
    const [collection, setCollection] = useState<Collection>('entries');
    const [mainPanel, setMainPanel] = useState<'library'|'study'>('library');
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
    const [expandedId, setExpandedId] = useState('');
    const expandedDialogRef = useRef<HTMLDialogElement>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [refreshToken, setRefreshToken] = useState(0);
    const selected = page.items.find(r => r.id === selectedId);
    const expanded = page.items.find(r => r.id === expandedId);
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

    useEffect(() => {
        const dialog = expandedDialogRef.current;
        if (!dialog) return;
        if (expanded && !dialog.open) dialog.showModal();
        else if (!expanded && dialog.open) dialog.close();
    }, [expanded]);

    const resetOffset = () => { setOffset(0); setSelectedId(''); setExpandedId(''); };
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
        <nav className="knowledge-mainnav" aria-label="Knowledge Bank sections">
          <button type="button" aria-current={mainPanel==='library'?'page':undefined} onClick={()=>setMainPanel('library')}>Browse library</button>
          <button type="button" aria-current={mainPanel==='study'?'page':undefined} onClick={()=>{setExpandedId('');setMainPanel('study');}}>Study &amp; practice</button>
        </nav>
        {mainPanel==='study' ? <KnowledgeStudy/> : <div className="knowledge-layout">
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
                                key={item.id} onClick={() => { setSelectedId(item.id); setExpandedId(item.id); }}>
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
                {selected ? <KnowledgeRecordDetails record={selected}
                    onFindSource={collection === 'sources' ? record => { setExpandedId(''); setSource(record); switchCollection('entries'); } : undefined} />
                 : <div className="knowledge-detail-prompt"><span>↗</span><h2>Inspect a record</h2><p>Choose an entry to read the original quotation, its explanation and full source metadata.</p></div>}
            </aside>
        </div>}
        {mainPanel === 'library' && <dialog ref={expandedDialogRef} className="knowledge-expanded-dialog"
            aria-label={expanded ? `Full details: ${titleFor(expanded)}` : 'Full knowledge record'}
            onClose={() => setExpandedId('')}
            onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
            {expanded && <div className="knowledge-expanded-inner">
                <div className="knowledge-expanded-bar">
                    <span>Expanded knowledge entry</span>
                    <button type="button" autoFocus aria-label="Close expanded entry"
                        onClick={() => expandedDialogRef.current?.close()}>Close <span aria-hidden="true">×</span></button>
                </div>
                <KnowledgeRecordDetails record={expanded}
                    onFindSource={collection === 'sources' ? record => {
                        expandedDialogRef.current?.close(); setSource(record); switchCollection('entries');
                    } : undefined}/>
            </div>}
        </dialog>}
    </div>;
}
