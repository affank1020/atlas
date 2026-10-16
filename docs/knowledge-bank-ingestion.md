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
5. For each entry set `title`, `kind`, `sourceKey`, `groupKeys`, `summary`, `claimProvenance` (explicit/paraphrase/inference), `reviewStatus`, and, when available, `sectionKey`, `locator`, `pageStart`, `pageEnd`, `sourceLink`, and topical `tags`. Add `detail` when nuances matter. **A verified verbatim `sourceExcerpt` is now required for source-grounded knowledge entries whenever the original supplied text supports it.** The excerpt must be a relevant, concise, *exact contiguous quotation*, not an AI paraphrase and not an unbounded copy of the full notes. Source location refers to printed page and/or PDF page explicitly; distinguish the two in `locator` if they differ.
6. **Evidence first:** use `explicit` for direct statements/examples from source, `paraphrase` for faithful restatement, `inference` for AI explanation/connections. Inferences must not be represented as lecturer or paper claims. For `sourceExcerpt`, find the selected passage in the actual supplied document before writing and validate that the exact wording appears there, allowing only removal of Markdown styling/links (never silently change the words). Include enough context for the excerpt to be meaningful; prefer one 10–45-word quotation per entry and, where necessary, short additional non-contiguous excerpts only if separately labelled and independently checked. If the relevant exact wording is unavailable, leave `sourceExcerpt` blank and mark `reviewStatus=needs_review` with a `confidenceNote`, rather than fabricating text. `sourceExcerpt` is visibly labelled *Original notes* in Atlas, while `summary` and `detail` are labelled as AI organisation/explanation. Set `reviewStatus=source_checked` only after cross-checking against supplied original text. Do not fabricate quotations, DOI, page numbers, hyperlinks, author names, or section boundaries.
7. Persist Sources and Sections first, then Entries, then Relationships. Use Atlas MCP create/update/query/bulk tools. Check existing `sourceKey`, `sectionKey`, `entryKey`, `relationKey` before writes. Upsert by checking exact stable key, not blind bulk insert. Split writes into batches of at most 100. Update existing records conservatively; don't overwrite user edits or verified detail without reason.
8. Relations must reference existing stable Entry keys, carry short rationale and explicit/inferred provenance. If linking similar material in two papers, keep both authors' separate Entries and relate them; never silently merge them. `relationKey` format: `fromEntryKey|relationType|toEntryKey`.
9. Mark a section `complete` only if the user-provided content actually covers the entire section and it has been checked; otherwise `partial`. Mark source `complete` only when all relevant sections/source material were covered. Do not mistake an uploaded excerpt for a full chapter.
10. Validate persistence: retrieve a sample of newly written records, check section/entry counts, labels, **presence and verbatim accuracy of `sourceExcerpt`**, and citations, and test at least one `knowledge_bank_browse` result (or Atlas `search_atlas` before Application deployment). Report additions, updates, missing/unverified quotations, uncertain citations, links that are only to a source landing page, and what portion of the source is still absent.

## Chapter practice / flashcard ingestion (from Chapter 1 onward)
- The same unified Knowledge Bank Project now contains **Knowledge Study Cards** Store `6d40585b-d4d5-4043-b89f-1afaddf2266e` and **Knowledge Review Progress** Store `0158e3fa-4577-485a-9a48-4ac8669be22b`. All source, group, provenance and identity conventions above still apply.
- For every **fully ingested** chapter, add a focused set of useful source-linked cards; prefer high-yield and applied understanding over mechanically turning every sentence into a question. Use stable `cardKey` (e.g. `comp33511-core-notes:ch01:card:miller-7`) and check for existing keys before writing. Each card stores `question`, `expectedAnswer`, `groupKeys`, `sourceKey`, `sectionKey`, `entryKeys` (existing entry IDs as stable keys), `cardType` (`recall`, `application`, `critique`, `assessment`), `origin`, `sourceLink`, `tags`, `status=active`.
- **Do not confuse origin.** If a question is copied from a lecturer's actual self-assessment section, set `origin=lecturer`, `cardType=assessment` and use its exact wording; its answer guide, unless explicitly supplied by the lecturer, is our own **source-grounded generated guidance** and must be labelled. Independently authored practice questions use `origin=generated`. Do not label generated cards as official tests.
- The `Knowledge Review Progress` Store records self-ratings and due dates via the Application's `knowledge_bank_rate_card` operation. Never ingest review history or invent mastery ratings. `knowledge_bank_study_deck` retrieves due/new cards or all practice with filters.
- Retain section-level evidence links and references and ask for critique/application where a simple recall prompt would lose important context. Use review cards **only during independent preparation**, not live COMP33511 timed tests that ban AI assistance.

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

## Seeded source state (16 October 2026)
- The `ux` group is active and `fyp` planned. The source `comp33511-core-notes` now points to Simon Harper's **UX from 30,000ft** at `https://leanpub.com/read/UX/` (`lecture_notes`, `core`, **partial**).
- The full **Preamble** supplied by the user has been ingested: the Preamble parent and six logical subsections (seven Section records, marked complete), 20 source-grounded Entries and 14 Relationships. Stable keys all begin `comp33511-core-notes:preamble`.
- These Entries link to the Leanpub preamble page and provide exact heading locators; there are no printed/PDF page numbers. The Tom's Diner example uses an original figure anchor.
- `pirsig-zamm-1974` is a separate recommended **planned** secondary-book source mentioned in the Preamble. Its original content has not been supplied; do not conflate the course author's description of that text with knowledge extracted from the text itself.
- **Chapters 2–18, appendices, glossary and other papers remain unprocessed.** Chapter 1 is now processed separately (see below). Never mark the whole notes source complete or claim to have read other materials. For future chunks, use exact stable-key checks before adding or updating any record.

## Chapter 1 progress (16 October 2026)
- Fully ingested the user-supplied Chapter 1 **Be Curious, Be Critical!**, link `https://leanpub.com/read/UX/wrong` — 19 Chapter Section records, 32 source-grounded knowledge Entries, 25 inferred Relations, and 19 Study Cards (5 exact lecturer self-assessment questions and 14 generated prompts). Original Preamble records remain unchanged.
- Chapter 1 card section locators are qualified by chapter/section, not fabricated page numbers. The five lecturer self-assessment question answers are generated study guidance; the lecturer supplied only the questions.
- Treat numerical assertions (e.g. user-testing error percentages, the blindness proportion, age-related neuroplasticity statement, and questionnaire behaviour) as the author's attributed presentation. Original papers have not been read or independently checked.
- Chapter 1 is part of the existing source `comp33511-core-notes`, whose overall status remains **partial**.

## Verified excerpt backfill (16 October 2026)
- All 52 existing knowledge Entries from the Preamble (20) and Chapter 1 (32) now have `sourceExcerpt` populated with a short, exact, relevant quotation checked against the user-uploaded Markdown originals, rather than only a generated summary.
- These are direct excerpts from the original course text, **not** quotations produced by a language model. They must not be silently rewritten for style; the AI explanation stays in `summary`/`detail`.
- The Knowledge Bank Application offers a large, accessible record dialog by clicking an entry; its verified excerpt is visually prioritised over the summary. The narrow sidebar uses the same source-grounded details. The dialog supports closing and displays all available metadata.
- The Web search backend already includes `sourceExcerpt` among its searched fields, so original lecturer wording is queryable from Atlas too.

## Assessment integrity
COMP33511's two timed tests expressly prohibit **AI assistance for any purpose**. This ingestion protocol is for advance independent study/preparation, not live exam question analysis, retrieval or answer generation. Check assignment-specific rules before applying AI assistance to assessed work.
