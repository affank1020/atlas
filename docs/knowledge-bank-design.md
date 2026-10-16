# Atlas Knowledge Bank — Architecture and decisions

## Current direction (16 October 2026)
The user chose a **single Knowledge Bank Atlas Project and native View**. A standalone code-defined Knowledge Bank Application and dedicated Study Application were retired. No first-party Knowledge Bank Application should be registered or shipped.

The source of truth is **Core/PostgreSQL Stores**, not a separate service. ChatGPT handles source ingestion using `docs/knowledge-bank-ingestion.md`; the View only browses current saved records.

- Knowledge Bank project ID: `f5091ee1-3d72-4654-8192-37ccfe8608a7`
- Native View ID: `2107baaf-806e-448f-a954-fc89ebe937f0`
- Native View route: `#/projects/f5091ee1-3d72-4654-8192-37ccfe8608a7/views/2107baaf-806e-448f-a954-fc89ebe937f0`
- Five active knowledge stores: Groups, Sources, Sections, Entries, Relationships (IDs are in the ingestion protocol).

## Data organisation
A `group` is optional logical metadata, not a separate project or database. Default browsing shows **All**. Source ID identifies an exact document; source type distinguishes lecture notes, papers, books, and other material; topic tags identify concepts. Multiple papers' findings should not be silently merged into a single citationless claim.

Every knowledge entry must preserve provenance: source, section, locator/page when known, a checked original excerpt if available, a distinct AI summary and details, and whether its contents are explicit source facts, paraphrases or inference. Related claims connect through a separate Relationship record.

## Presentation: a View, not an Application
The existing View `knowledge-bank` shows entries, sources, chapters and connections. Filters for group, source identity/type, knowledge kind and topical tags are optional. Clicking an entry opens a large native dialog with the original source quotation first, then summary, explanation, caveats, tags and source metadata. The dialog closes by Close button or Escape.

**Important View constraint:** each static Store query returns at most 100 records; the View's JavaScript filters only the loaded subset. It is NOT corpus-wide search when Entries grow beyond 100. ChatGPT can search Atlas Core across all records using `search_atlas` and `query_records` with filtering and offsets. Avoid declaring this limitation solved or recreating a backend just for ingestion. If full-corpus View search is later essential, explicitly revisit expanding the View platform or choosing a separate search interface.

## Practice and legacy implementation
Use ChatGPT for informal, source-grounded revision questions and mini assessments outside official tests. The code-defined Knowledge Bank and Study Applications were removed from the local Atlas project and should disappear from hosted Applications after Server/Web deployment. Historical study card/progress stores and their data are left intact for reversibility, but future chapter ingestion does not automatically create flashcards.

## Verification checklist
- New reading chunk is ingested without duplicate `entryKey`/`sourceKey`.
- `sourceExcerpt` matches the uploaded source exactly and is shown before AI explanations.
- Filtering and click-to-expand reader render safely in the native View (no privileged DOM or network).
- Original source links are only displayed when actually known; locators are useful without them.
- All five Core stores remain independent of any optional UI.
- View's first-100 limitation remains explicit; ChatGPT retrieval uses Core.
- No launchable Knowledge Bank Application is registered after deployment.


## Native View server-side search/pagination upgrade (locally implemented; deployment needed)
- Atlas Views now support **declarative, parameter-bound, paginated Store queries**, avoiding a standalone Knowledge Bank Application. Query definitions accept `searchParam`, `offsetParam`, and `paramFilters: [{param, field, operator:"eq"|"contains"}]`.
- URL params must be explicitly declared in the saved View manifest with `url-params`. Server-side validation rejects unknown params, stores, fields or operators; the SQL repository binds user search terms and filter values, caps each page at 100 records, and returns total-match counts as `<queryName>Page[0]`.
- `atlas.setParam(...)` followed by `atlas.refresh()` renders the next server-filtered page. No direct iframe network access, added app, or extra ingestion service.
- Unit/integration tests: `test/view-query-pagination.test.ts` (145 rows; cross-100 pagination, text search, group/source/tag filters, param validation and SQL-injection-style input) and `test/knowledge-view-draft.test.ts` (full saved View draft, original excerpts, sandbox validation).
- A complete staged definition is saved as `docs/knowledge-bank-view-server-search.json`. It retains the existing source-first expanded entry dialog and adds server-side search and 25-row page controls on Sources, Sections, Entries and Relationships. Filtering by source type applies to the Sources tab; group/source/kind/tag apply to collections with those fields. Connections lack a groupKeys field, so group alone does not filter relationships.
- **Rollout order is mandatory:** (1) deploy the updated Atlas Server; (2) reread the active native View to confirm its revision; (3) preview the staged definition against the deployed Server, then update the existing View ID in place; (4) render and validate search and pagination. Never publish the staged definition while the hosted Server still rejects new query properties. Old View continues to work during the upgrade.
- This is server-side search over JSONB record data (case-insensitive substring), not a rank-ordered semantic search engine. It is suited to this corpus; performance should be rechecked for very large data volumes.
