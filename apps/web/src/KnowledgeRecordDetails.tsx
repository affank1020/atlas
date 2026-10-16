import type { ReactNode } from 'react';

export type KnowledgeDetailRecord = {
    id: string; title?: string; name?: string; kind?: string; summary?: string; detail?: string;
    description?: string; sourceKey?: string; sourceType?: string; sourceTypeResolved?: string | null;
    sourceTitle?: string | null; sourceRole?: string; originalUrl?: string; sourceOriginalUrl?: string | null; sourceLink?: string;
    pageLink?: string; pageStart?: number; pageEnd?: number; locator?: string; sectionKey?: string;
    sectionLabel?: string; authors?: string; year?: number; doi?: string; citation?: string;
    status?: string; claimProvenance?: string; reviewStatus?: string; sourceExcerpt?: string;
    rationale?: string; fromEntryKey?: string; toEntryKey?: string; relationType?: string;
    relationProvenance?: string; linkNotes?: string; tags?: string[]; groupKeys?: string[];
    entryKey?: string; relationKey?: string; confidenceNote?: string;
};

const safeLink = (value?: string | null) => {
    if (!value) return '';
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.toString() : ''; }
    catch { return ''; }
};
export const knowledgeTitle = (record: KnowledgeDetailRecord) =>
    record.title || record.name || record.sectionLabel || record.relationType || 'Untitled record';

function Fact({ label, children }: { label: string; children: ReactNode }) {
    if (children === undefined || children === null || children === '') return null;
    return <><dt>{label}</dt><dd>{children}</dd></>;
}

export function KnowledgeRecordDetails({
    record,
    onFindSource,
}: {
    record: KnowledgeDetailRecord;
    onFindSource?: (record: KnowledgeDetailRecord) => void;
}) {
    const link = safeLink(record.sourceLink || record.pageLink || record.originalUrl || record.sourceOriginalUrl);
    const originalText = record.sourceExcerpt?.trim();
    return <div className="knowledge-record-detail">
        <div className="knowledge-detail-label">KNOWLEDGE BANK / SOURCE-GROUNDED RECORD</div>
        <h2>{knowledgeTitle(record)}</h2>
        <div className="knowledge-pills">{[
            record.kind, record.sourceType || record.sourceTypeResolved, record.claimProvenance,
            record.reviewStatus, record.status,
        ].filter(Boolean).map((value, i) => <span key={i}>{value}</span>)}</div>
        {originalText && <section className="knowledge-quote-section">
            <h3>Original notes · Verbatim passage</h3>
            <blockquote className="knowledge-verbatim-quote">{originalText}</blockquote>
            <p className="knowledge-quote-source">
                {record.sourceTitle || record.sourceKey || 'Original source'}
                {record.locator ? ` · ${record.locator}` : ''}
            </p>
        </section>}
        {record.summary && <section>
            <h3>AI-organised summary</h3><p>{record.summary}</p>
        </section>}
        {record.detail && <section>
            <h3>Detailed explanation</h3><p>{record.detail}</p>
        </section>}
        {record.description && <section>
            <h3>Description</h3><p>{record.description}</p>
        </section>}
        {record.rationale && <section>
            <h3>Relationship</h3><p>{record.rationale}</p>
            <small>{record.fromEntryKey} → {record.toEntryKey}</small>
        </section>}
        {record.confidenceNote && <section>
            <h3>Qualification / verification note</h3>
            <p>{record.confidenceNote}</p>
        </section>}
        <section>
            <h3>Source and provenance</h3>
            <dl className="knowledge-record-facts">
                <Fact label="Source">{record.sourceTitle || record.sourceKey}</Fact>
                <Fact label="Source type">{record.sourceType || record.sourceTypeResolved}</Fact>
                <Fact label="Section">{record.locator || record.sectionLabel || record.sectionKey}</Fact>
                {(record.pageStart !== undefined || record.pageEnd !== undefined) &&
                    <Fact label="Pages">{record.pageStart}{record.pageEnd !== undefined && record.pageEnd !== record.pageStart ? `–${record.pageEnd}` : ''}</Fact>}
                <Fact label="Authors">{record.authors}</Fact>
                <Fact label="Year">{record.year}</Fact>
                <Fact label="DOI">{record.doi}</Fact>
                <Fact label="Citation">{record.citation}</Fact>
                <Fact label="Entry ID">{record.entryKey}</Fact>
                <Fact label="Review">{record.reviewStatus}</Fact>
                <Fact label="Provenance">{record.claimProvenance}</Fact>
            </dl>
            {link && <a className="knowledge-link" href={link} target="_blank" rel="noopener noreferrer">
                {record.sourceLink || record.pageLink ? 'Open referenced section ↗' : 'Open original source ↗'}
            </a>}
            {record.linkNotes && <p className="knowledge-muted">{record.linkNotes}</p>}
        </section>
        {!!record.tags?.length && <section>
            <h3>Topics</h3>
            <div className="knowledge-pills">{record.tags.map((tag, i) => <span key={i}>{tag}</span>)}</div>
        </section>}
        {onFindSource && record.sourceKey &&
            <button className="knowledge-source-open" type="button" onClick={() => onFindSource(record)}>
                Find knowledge from this source →
            </button>}
    </div>;
}
