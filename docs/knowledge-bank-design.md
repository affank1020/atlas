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


## Optional study layer (16 October 2026)
- The **Knowledge Study Cards** and **Knowledge Review Progress** stores extend—not replace—the existing unified knowledge bank. Cards carry stable IDs, source and section links, associated entry keys, group metadata, and distinct lecturer/generated origins. Review progress keeps only self-assessment scheduling metadata.
- Backend: `apps/server/src/apps/knowledge-study.ts` with read-only `knowledge_bank_study_deck` and progress-writing `knowledge_bank_rate_card`. Due/new cards are selected with PostgreSQL filters and pagination rather than a first-100 UI cap; 10-minute Again, then interval-based Hard/Good/Easy scheduling is a lightweight practice heuristic, **not a validated memory-science model**. Card grades are explicitly self-rated, never AI-scored.
- Frontend: `apps/web/src/KnowledgeStudy.tsx`, `knowledge-study.css`, accessible under the Knowledge Bank Application's **Study & practice** section. Supports source search, groups, flashcard reveals, user-written self-assessment answers, saved reviews, due/new sessions and multi-batch browse-all practice.
- The first cohort is 19 Chapter 1 cards: five original self-assessment prompts (lecturer wording, our source-grounded answer guides), fourteen generated prompts. Future chunks follow the rules in `knowledge-bank-ingestion.md`.
- Tests: `test/knowledge-study.test.ts` checks PostgreSQL paging with 125 cards, filtering, persisted progress and due exclusion; `apps/web/src/KnowledgeStudy.test.tsx` checks reveal, grade and mini-assessment.
- Local application code must be redeployed before these Study features appear on hosted Atlas; the stores and seed cards are already live in PostgreSQL.


## Source-first entry reading (16 October 2026)
- Existing `Knowledge Entries.sourceExcerpt` is now populated for all 52 Preamble and Chapter 1 entries with exact short quotations validated against user-uploaded Markdown passages (Preamble 20, Chapter 1 32). Source quotations must not be paraphrased or invented.
- `KnowledgeRecordDetails.tsx` centralises a consistent display for the narrow preview and expanded reader: the original excerpt is prioritised, followed by AI-organised summary, detailed explanation, any verification qualification, and full available provenance/tags/links.
- Clicking a result opens a large native `<dialog>` with close/Escape/backdrop handling; this is a presentation change only, preserving existing Core IDs and paginated search. The dialog's content is accessible and source-first.
- The test in `apps/web/src/KnowledgeBank.test.tsx` checks opening the expanded reader, the stored original quote, summary, context and original source link.
- The excerpt is searchable through `knowledge_bank_browse`, which already includes `sourceExcerpt` in server-side search. A source link alone is never a substitute for quoting and identifying the underlying passage.
