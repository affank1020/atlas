# Atlas Knowledge Bank — Design and operating contract

## Decisions
- One standalone **Knowledge Bank** Atlas project so the source library is cross-disciplinary. Groups are metadata, not separate projects/stores. Existing University and FYP projects remain untouched.
- Five project-owned typed Atlas Stores: Groups, Sources, Sections, Entries and Relationships (see \`knowledge-bank-ingestion.md\` for IDs and ingestion steps).
- ChatGPT takes supplied reading chunks, follows the Markdown protocol and writes directly through Atlas MCP. PostgreSQL/Core owns persistent data, audits and schemas. **No independent ingestion backend**.
- Browse all by default, with optional group, source, document type, entry kind and topic filters. Source identity and type are not conflated with topic tags.
- Original facts/quotations/explanations keep precise provenance. Atomic Entries reference one Source and optional Section. Cross-source synthesis uses Relationships.
- Initial UX focus, FYP papers may be added later using identical schema and instructions; do not migrate existing FYP literature without an explicit request.
- Vue/React UI is not required for ingestion. Native Atlas View provides early browsing; **View Kit filters are limited to at most 100 rows/query**, so need server-backed search/pagination before claiming complete human-facing corpus search.
- Atlas's general \`search_atlas\` already supports MCP-side cross-record search scoped by project. Verify relevance/coverage as items are ingested, and use Core queries for deterministic filtering and pagination.
- Direct document links are desired but must resolve to verified, durable URLs; otherwise show exact chapter/section/page metadata only.

## Record organization
Groups: key, name, description, linkedProjectId, status.
Sources: sourceKey, title, groupKeys[], sourceType, sourceRole, authors/year/DOI, originalUrl/fileRef, citation, tags[], status, linkNotes.
Sections: sectionKey, sourceKey, parentSectionKey, groupKeys[], title, sectionLabel, position, pageStart/pageEnd/pageLink, summary, tags[], status.
Entries: entryKey, sourceKey, sectionKey, groupKeys[], title, kind, summary, detail, sourceExcerpt, claimProvenance, locator/pageStart/pageEnd/sourceLink, tags[], reviewStatus, confidenceNote.
Relationships: relationKey, fromEntryKey, toEntryKey, relationType, rationale, relationProvenance, evidenceSourceKey, tags[].

## Operational acceptance checks
1. An uploaded section can be added, then the same chunk reprocessed without duplicate stable keys.
2. Search by title/topic/terminology retrieves saved Entries via Atlas MCP.
3. Filter by group, exact source, source type, kind and tags produces correct records (with source type determined from Sources).
4. Browse a section and open an Entry containing its provenance; original links only if verified.
5. Cross-chapter relationships never destroy the separate source claims.
6. Documents are not marked complete when only partially supplied.
7. For more than 100 Entries, server-backed browsing must be available (an explicit future enhancement); current View cannot meet that acceptance criterion alone.

## Known UI limit and decision
Native View Kit query definitions are static and capped at 100 results/query. URL parameters do not change the server query. The initial View is an **honestly bounded browser** with local quick-filter. If corpus-wide human search is a hard requirement before ingestion grows, build a small server-backed Application or extend View Kit with a safe paginated query/search operation rather than pretending client filtering is exhaustive.
