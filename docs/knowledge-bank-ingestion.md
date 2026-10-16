# Knowledge Bank — ChatGPT ingestion protocol (v1)

## Purpose and boundaries
The Knowledge Bank is **one** Atlas Core/PostgreSQL project. It holds notes, books and research papers from multiple subjects without merging distinct authors' claims. Ingestion is done interactively by ChatGPT from text/PDF chunks that the user supplies. **Do not build an ingestion API, background job, second database or parallel UX-only store.**

Atlas project ID: `f5091ee1-3d72-4654-8192-37ccfe8608a7`.
Group keys: `ux` (COMP33511), `fyp` (later). **All** is the default browsing/retrieval scope; group is an optional filter.
Store IDs:
- Groups `4ecdd6c1-6807-456b-9151-cc13a9c31b34`
- Sources `0a079819-044a-402e-854f-f14d200b3796`
- Sections `9e8ab094-f3c7-4eb2-8481-be55b019d5b7`
- Entries `c06e106f-7507-4cad-9881-3774917ee580`
- Relationships `1d238fe1-c6ed-41ac-99ba-89ed052f2a7e`

## On EVERY ingestion request
1. Read this protocol; inspect Store schemas and relevant existing records in Atlas. Confirm which document/source the new chunk belongs to; reuse it if already registered. Never silently create a duplicate source.
2. Read the complete submitted chunk. Identify its actual source title/author, source type, role (core/required/recommended/supplementary/reference/unknown), group key(s), chapter/section boundaries, page numbers, and stable URL if provided. Preserve meaningful headings and terminology.
3. Generate a stable lowercase sourceKey once (example: `comp33511-core-notes`). Use stable, descriptive sectionKey values (example `comp33511-core-notes:ch03:3.2`) and entryKey values (example `comp33511-core-notes:ch03:3.2:user-research-methods`). Do not use changing ChatGPT turn IDs as persistent identities. No database uniqueness constraints exist on these user fields; explicitly query before writing.
4. Extract **atomic, useful** entries: definitions, methods, standards, concepts, findings, arguments, comparisons, criticisms, worked examples and concise section summaries where warranted. Preserve technical details, constraints, assumptions, rationale, counterexamples and lecturer-specific wording; avoid bloated generic summaries. Do not infer facts absent from the source.
5. For each entry set `title`, `kind`, `sourceKey`, `groupKeys`, `summary`, `claimProvenance` (explicit/paraphrase/inference), `reviewStatus`, and, when available, `sectionKey`, `locator`, `pageStart`, `pageEnd`, `sourceLink`, and topical `tags`. Add `detail` when nuances matter. `sourceExcerpt` should be brief enough to verify a claim, not a wholesale reproduction of copyright-protected pages. Source location refers to printed page and/or PDF page explicitly; distinguish the two in `locator` if they differ.
6. **Evidence first:** use `explicit` for direct statements/examples from source, `paraphrase` for faithful restatement, `inference` for AI explanation/connections. Inferences must not be represented as lecturer or paper claims. Set `reviewStatus=needs_review` when page/source mapping is uncertain; `source_checked` only after cross-checking against supplied original text. Do not fabricate quotations, DOI, page numbers, hyperlinks, author names, or section boundaries.
7. Persist Sources and Sections first, then Entries, then Relationships. Use Atlas MCP create/update/query/bulk tools. Check existing `sourceKey`, `sectionKey`, `entryKey`, `relationKey` before writes. Upsert by checking exact stable key, not blind bulk insert. Split writes into batches of at most 100. Update existing records conservatively; don't overwrite user edits or verified detail without reason.
8. Relations must reference existing stable Entry keys, carry short rationale and explicit/inferred provenance. If linking similar material in two papers, keep both authors' separate Entries and relate them; never silently merge them. `relationKey` format: `fromEntryKey|relationType|toEntryKey`.
9. Mark a section `complete` only if the user-provided content actually covers the entire section and it has been checked; otherwise `partial`. Mark source `complete` only when all relevant sections/source material were covered. Do not mistake an uploaded excerpt for a full chapter.
10. Validate persistence: retrieve a sample of newly written records, check section/entry counts, labels and citations, and test at least one `knowledge_bank_browse` result (or Atlas `search_atlas` before Application deployment). Report additions, updates, uncertain citations, links that are only to a source landing page, and what portion of the source is still absent.

## Source links
- `originalUrl`: stable original document URL, if available; if it's a Canvas index, label it as an index, NOT a deep link to the PDF.
- `fileRef`: persistent Atlas/Drive/location identifier where original PDF is actually accessible. A ChatGPT ephemeral upload link is not a long-term document URL.
- `pageLink`: use a document-supported deep link/anchor (PDF page fragment if stable and accessible) only after verifying the base URL and correct page. If not possible, store `locator` and page range, leaving the link blank. Do not invent `#page=N` when printed/PDF page mapping is unknown.
- Non-web sources can use chapter/page/section location even if original link is not yet available.

## Retrieval
- ChatGPT: prefer the `knowledge_bank_browse` MCP operation for exhaustive, server-paginated search with `collection`, `q`, `group`, `sourceKey`, `sourceType`, `entryKind`, `tag`, `offset`, `limit`. Use `knowledge_bank_overview` for counts and groups. The operations run read-only against project-scoped PostgreSQL/Core data, without the Views 100-record loading limit. When not yet deployed/available, use `search_atlas` scoped to this project for candidate discovery plus exact `query_records` (with offsets) to verify original records. Never claim an unchecked short search snippet is exhaustive.
- Atlas Web: launch the Knowledge Bank Application under its own project. The older saved View remains a provisional, **first-100-only** browser; do not mistake its local search for corpus-wide search.
- Searches default to all groups. Group/source/type/topic are optional constraints.
- Attribute claims to source and location. Distinguish source-derived content from AI interpretation.

## Initial state
The `ux` group is active and `fyp` planned. `comp33511-core-notes` is a **planned placeholder** pointing only at the Canvas Quick Links page; its PDF and chapter contents have NOT been ingested. Do not treat the blank knowledge bank as evidence that notes were read.

## Assessment integrity
COMP33511's two timed tests expressly prohibit **AI assistance for any purpose**. This ingestion protocol is for advance independent study/preparation, not live exam question analysis, retrieval or answer generation. Check assignment-specific rules before applying AI assistance to assessed work.
