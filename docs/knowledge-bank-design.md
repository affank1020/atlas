# Atlas Knowledge Bank — Design and operating contract

## Decisions
- One standalone **Knowledge Bank** Atlas project so the source library is cross-disciplinary. Groups are metadata, not separate projects/stores. Existing University and FYP projects remain untouched.
- Five project-owned typed Atlas Stores: Groups, Sources, Sections, Entries and Relationships (see `knowledge-bank-ingestion.md` for IDs and ingestion steps).
- ChatGPT takes supplied reading chunks, follows the Markdown protocol and writes directly through Atlas MCP. PostgreSQL/Core owns persistent data, audits and schemas. **No independent ingestion backend**.
- Browse all by default, with optional group, source, document type, entry kind and topic filters. Source identity and type are not conflated with topic tags.
- Original facts/quotations/explanations keep precise provenance. Atomic Entries reference one Source and optional Section. Cross-source synthesis uses Relationships.
- Initial UX focus, FYP papers may be added later using identical schema and instructions; do not migrate existing FYP literature without an explicit request.
- React is used for **browsing only**, not ingestion. The code-defined `Knowledge Bank` Application lives within the Knowledge Bank Atlas Project. A read-only, project-scoped SQL operation searches the existing Core `records` and `stores` tables with total counts, typed filters and deterministic 25-row pages (max 100 per request). No new persistence service, ingestion backend, or index is introduced.
- `knowledge_bank_browse` and `knowledge_bank_overview` serve Atlas Web and are prioritised for ChatGPT MCP clients. Queries cover all matching records on the server; the legacy saved View remains limited to the first 100 per Store.
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
7. For more than 100 Entries, the Application must provide server-backed search and paginated results; the test `test/knowledge-bank.test.ts` creates 146 Entries and verifies filters/offsets beyond 100. Do not use the legacy View as the authoritative search surface.

## Implemented Application (local code; deployment required)
- Project: `f5091ee1-3d72-4654-8192-37ccfe8608a7`
- Local Application route: `#/projects/f5091ee1-3d72-4654-8192-37ccfe8608a7/applications/knowledge-bank`
- Server: `apps/server/src/apps/knowledge-bank.ts` — `knowledge_bank_browse`, `knowledge_bank_overview`; SQL read-only, scoped to the five known Store UUIDs and Knowledge Bank project.
- Web: `apps/web/src/KnowledgeBank.tsx` and `knowledge-bank.css` — All-group default, filters, server-side pagination, source suggestions, provenance detail and external source links.
- Tests: `test/knowledge-bank.test.ts`, `apps/web/src/KnowledgeBank.test.tsx`. Full `npm test` passed 172 backend, 101 web, Mac UI check (16 Oct 2026).
- Older saved View: still available under `/projects/f5091ee1-3d72-4654-8192-37ccfe8608a7/views/knowledge-bank`, but its query cap remains 100. It is not the recommended interface.
- Limitations: source text not yet ingested; default source is a planned placeholder only. Data is already persisted remotely; the new Application source changes are in the local Atlas checkout and must be deployed before appearing on hosted Atlas.
