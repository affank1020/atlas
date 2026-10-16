# Knowledge Bank — ChatGPT ingestion protocol

## Purpose
Use **one unified Atlas Knowledge Bank** backed by Core/PostgreSQL Stores. The user supplies reading passages to ChatGPT, which extracts, verifies and saves source-grounded knowledge through the existing Atlas MCP/Core tools. The presentation is a native Atlas **View**, not a first-party Application. No separate ingestion backend, standalone React app, background worker or UX-specific database.

Knowledge Bank Project: `f5091ee1-3d72-4654-8192-37ccfe8608a7`.
Knowledge Bank View: `2107baaf-806e-448f-a954-fc89ebe937f0`, slug `knowledge-bank`.
Default knowledge group filter is **All**; `ux` is active and `fyp` is reserved for future use.

## Shared Core stores
- Groups: `4ecdd6c1-6807-456b-9151-cc13a9c31b34`
- Sources: `0a079819-044a-402e-854f-f14d200b3796`
- Sections: `9e8ab094-f3c7-4eb2-8481-be55b019d5b7`
- Entries: `c06e106f-7507-4cad-9881-3774917ee580`
- Relationships: `1d238fe1-c6ed-41ac-99ba-89ed052f2a7e`

Source identity (`sourceKey`), source type (`sourceType`), logical group (`groupKeys`) and topical tags (`tags`) are separate. Different documents retain distinct claims; use relations for connections.

## Mandatory procedure for every new chunk
1. Read this protocol; inspect the relevant Atlas Sources, Sections and Entries first. Resolve the original document and reuse its stable `sourceKey`. Check exact stable keys before creating anything; do not duplicate material already ingested.
2. Inspect the complete supplied chunk: author/title, chapter/section boundaries, original headings, source role (core/required/recommended/supplementary/reference/unknown), group, any printed/PDF page numbers, official URL and external readings cited.
3. Add/update Sources and Sections with actual coverage status. An excerpt does NOT make its source or entire chapter complete. Use descriptive section keys such as `comp33511-core-notes:ch02:2.1`; preserve hierarchy.
4. Extract **atomic** knowledge Entries only when useful: concepts, definitions, standards, methods, findings, criticisms, comparisons, lecturer examples and carefully scoped summaries. Keep relevant nuance, methods, assumptions, caveats and arguments rather than merely restating generic UX facts.
5. Every substantive source-grounded Entry should include `title`, `kind`, `sourceKey`, `groupKeys`, `sectionKey`, `summary`, `detail` where warranted, `locator`, `tags`, `claimProvenance`, `reviewStatus` and a **verified verbatim `sourceExcerpt`** when the source provides suitable wording. Prefer a concise, context-bearing, exact quotation (commonly 10–45 words), not wholesale reproduction. Include PDF page information only when known; don't invent page numbers.
6. Match the excerpt against the **actual user-provided source passage** before saving it. Keep its wording exact, except for removal of irrelevant Markdown styling. Quote means the author's text, not an AI reconstruction. If an accurate quote cannot be checked, leave `sourceExcerpt` empty, use `reviewStatus=needs_review`, add `confidenceNote` explaining why. `claimProvenance=explicit` for direct claims/examples, `paraphrase` for faithful summary and `inference` for assistant-derived interpretation. Never present an inference as the author's position.
7. Add verified, short Relationships using actual existing entry keys and `relationProvenance=explicit|inferred`. Preserve different interpretations from distinct sources without merging them.
8. Use Atlas MCP bulk operations in batches <=100 and exact stable-key checks before writing. Avoid overwriting human edits and previously verified text. Validate newly written records, source links, section coverage and quotation accuracy by re-reading a sample.
9. Test retrieval through `search_atlas` with Knowledge Bank project scope and deterministic `query_records` with filters/offset where needed. Atlas View script filters/search operate on up to **100 loaded records per collection**, and are not exhaustive once a Store grows beyond that. Do not pretend the View has server-wide search.
10. Report newly ingested entries, source coverage, any doubtful citations, what still remains unread and what the original URL actually reaches.

## Original text over generated explanations
The View now uses a click-to-expand native dialog that visibly prioritises each `sourceExcerpt` as **Original notes · Verbatim passage**, followed by **AI-organised summary**, detailed explanation, verification notes and source location. The source link is secondary evidence and may be unreliable. Use readable section locators even if no working deep link exists.

## Practice
The user now prefers **AI-assisted mini assessments in ChatGPT**, grounded in Knowledge Bank records. Do NOT automatically generate or persist standalone flashcards/review progress when ingesting another chapter unless specifically requested. Historical Chapter 1 cards (19) and any review metadata remain in two unused, preserved stores (`6d40585b-d4d5-4043-b89f-1afaddf2266e`, `0158e3fa-4577-485a-9a48-4ac8669be22b`); there is no active Study Application. Original lecturer self-assessment questions must remain distinguished from generated practice questions.

COMP33511's two official timed tests prohibit AI assistance of any kind. Use these records for advance preparation only, never live retrieval, drafting or editing during prohibited tests.

## Current seed progress (16 October 2026)
- `comp33511-core-notes`: Simon Harper, **UX from 30,000ft** (`https://leanpub.com/read/UX/`), group `ux`, core lecture notes, source status **partial**.
- Preamble: 7 Section records, 20 Entries, 14 Relationships; section coverage marked complete.
- Chapter 1 **Be Curious, Be Critical!**: 19 Section records, 32 Entries, 25 Relationships; section coverage marked complete.
- All **52** existing Entries include original-text quotations. Some numerical assertions from the lecturer remain unverified against original research papers; preserve attribution and caveats.
- `pirsig-zamm-1974`: a **planned**, separately registered recommended book mentioned in the Preamble. The original book has not been ingested.
- Chapters 2–18 and other unprovided readings remain unprocessed.
