# Atlas

Atlas is a local structured-data platform for intelligent clients, exposed over MCP. It stores typed records behind explicit project and store boundaries and provides stable identifiers, controlled schema evolution, structured querying, archival, and an immutable mutation audit trail.

Atlas deliberately does not interpret natural language. Clients decide what data means and call the explicit data tools.

## Fabric Stage 1

Fabric is a higher-level subsystem that consumes Atlas Core without changing Core's project/store/record model. It provides two additional MCP tools:

- `search_atlas`: PostgreSQL-backed discovery across active records in all stores, optionally limited to selected projects.
- `request_context`: a bounded, provenance-rich selection of records for another client to use as context; it does not generate an answer.

`search_atlas` accepts an optional diagnostic `mode`: `lexical`, `semantic`, or `hybrid`. Hybrid is the default.

Fabric creates deterministic searchable projections from arbitrary JSON record values, retaining normalized field names alongside strings, numbers, booleans, dates, arrays, nested objects, and null values. Results include canonical records, project/store provenance, scores, matching fields, snippets, reasons, ranking components, and search-scope diagnostics.

`fabric_search_documents` is disposable derived state. Immediately before every Fabric request, Fabric transactionally upserts active canonical Core rows and removes documents whose records, stores, or projects are archived. This synchronous-on-read model gives Stage 1 simple, explicit consistency without making Core call Fabric. Deleting and rebuilding this table cannot damage canonical Core data.

Ranking combines PostgreSQL full-text relevance, exact-phrase matching, generic substring term coverage, matching field diagnostics, and project/store metadata. There are no project- or store-specific ranking rules, embeddings, LLM calls, or inferred relationships.

### Deterministic retrieval hardening

Fabric maintains separate display and searchable projections. Display projections retain complete values for provenance and debugging; UUIDs, URLs, long compact machine identifiers, nulls, and empty collections do not contribute their values to ranking. Every result reports searchable fields and display-only fields with exclusion reasons.

Terms of two characters or fewer use token-boundary matching instead of unrestricted substring matching. Ranking has explicit stable project/store/record ID tie-breakers, so identical data and queries produce identical ordering.

Context assembly applies a deterministic evidence floor and may return fewer than `maxRecords`. It also compares projected value-token overlap conservatively, retaining the richer record when two selections are clear near-duplicates. Context diagnostics report relevance-floor rejections and every diversification decision. These rules remain generic: no project, store, schema, or domain names are special-cased.

### Semantic and hybrid retrieval

Stage 2 adds a vendor-neutral `EmbeddingProvider` boundary. The default provider uses the local Ollama API with `nomic-embed-text`; configure it with `FABRIC_EMBEDDING_MODEL` and `OLLAMA_URL`. No paid API or external vector database is used.

`fabric_semantic_documents` stores disposable embeddings of the existing safe searchable projection as PostgreSQL `double precision[]` values. UUIDs, URLs, opaque identifiers, nulls, and empty collections therefore reach neither lexical ranking nor embeddings. PostgreSQL calculates cosine similarity through `fabric_cosine_similarity`. Active semantic candidates require raw cosine similarity of at least `0.35`.

On each semantic or hybrid read, Fabric synchronizes lexical projections, embeds only missing or changed semantic documents, removes archived documents, and stores the model name, source text, dimension, source timestamp, and vector. `FabricSearchService.rebuildSemanticIndex()` truncates this derived table; the next search recreates it from canonical Core data.

Hybrid ranking uses deterministic weighted reciprocal ranks:

```text
lexical contribution = lexical match ? 0.45 / lexical rank : 0
semantic contribution = semantic match ? 0.55 / semantic rank : 0
hybrid score = lexical contribution + semantic contribution
```

Ties resolve by semantic score, lexical normalized score, project ID, store ID, then record ID. Diagnostics expose both ranks and contributions, raw lexical score, cosine similarity, normalized semantic score, retrieval sources, model, candidate counts, and provider status.

If Ollama is unavailable, hybrid search falls back to the frozen lexical channel and reports `semanticStatus: "unavailable"`; semantic-only mode returns no results with the same diagnostic. Core reads and writes remain independent and operational.

### Deterministic authority policy

Fabric applies an explicit authority pass to context candidates after retrieval and the relevance floor, but before diversification. It does not change lexical, semantic, or hybrid candidate scoring. `search_atlas` therefore keeps the Stage 2 ordering contract; `request_context` may suppress a lower-authority equivalent and explains every decision in diagnostics.

Policy is persisted separately from canonical Core data:

- `fabric_store_authority_policies` declares a store's role, optional canonical store, equivalence kind, identity and comparison fields, semantic effective-time fields, and explicit current/historical markers.
- `fabric_record_authority_policies` provides sparse record-level overrides, explicit effective time, and explicit supersession links.

Equivalence is opt-in and deterministic. Only stores with compatible policy and the same normalized values for all configured identity fields enter a group. `same_entity` links records about one entity without assuming that every field states the same fact. `same_fact` additionally permits explicitly configured comparison fields to produce contradiction diagnostics. Unconfigured records are never equated by fuzzy similarity, names, timestamps, or retrieval proximity.

Preference is lexicographic and evidence-based: explicit supersession, authority role (`canonical`, `primary`, `unknown`, `supporting`, `mirror`/`derived`, `historical`), explicit currentness, then semantic effective time. Fabric never treats database `updated_at` as domain currentness. Equal evidence remains unresolved: conflicting records are preserved and flagged instead of receiving an invented winner. If the policy subsystem fails, context assembly fails open and reports `authorityStatus: "unavailable"`; Core remains independent.

The repository includes an explicit policy example in `config/fabric-authority.json`. Apply it after migrations with:

```bash
npm run fabric:configure-authority
```

The Observatory Context view renders equivalence groups, preferred and suppressed records, contradiction status, rationale, and temporal evidence.

## Data model

```text
Project
└── Store (name + versioned schema)
    └── Record (stable ID + schema-validated data)
```

A schema field supports `string`, `number`, `boolean`, `date`, `datetime`, `enum`, `array`, or `object`; it can be required, documented, or given a default. Enum fields declare their allowed values.

Project, store, and record IDs remain stable through updates. Archive operations retain history rather than deleting data. Archiving a project cascades to its stores and records; archiving a store cascades to its records.

## MCP tools

Atlas serves Streamable HTTP at `http://127.0.0.1:3000/mcp`:

- Project: `list_projects`, `get_project`, `create_project`, `update_project`, `archive_project`
- Store: `list_stores`, `get_store`, `create_store`, `update_store`, `update_store_schema`, `archive_store`
- Record: `list_records`, `query_records`, `get_record`, `create_record`, `update_record`, `archive_record`, `bulk_records`
- Operations: `get_atlas_status`, `get_recent_activity`, `get_audit_history`

`query_records` supports `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, and `contains`, multi-field `asc`/`desc` sorting, and deterministic `limit`/`offset` pagination. Unknown filter or sort fields are rejected.

`bulk_records` applies up to 100 creates, updates, and archives atomically: one invalid operation rolls back the complete batch.

All mutation tools accept an optional `client` label. Atlas records the operation, timestamp, target IDs, client, and before/after state in the audit trail.

## Schema evolution

`update_store_schema` atomically validates the proposed schema against every active record. Defaults are applied to new fields. A change fails without mutation if existing records would become invalid.

Removing a field that contains data requires `dropRemovedFields: true`; this makes destructive schema intent explicit. Successful changes increment the schema version and are audited.

## PostgreSQL persistence

PostgreSQL is Atlas's sole runtime persistence backend. `AtlasCatalog` retains validation, stable-ID, archive, query, schema-evolution, and audit semantics; an `AtlasRepository` boundary owns durable storage. The database uses relational ownership and timestamps with JSONB schema definitions, record data, and audit before/after state. Every mutation—including `bulk_records` and its audit events—runs in one database transaction under a cross-process advisory lock.

`data/atlas-structured.json` is now only an immutable legacy import source. Atlas never silently reads, writes, or re-imports it, and the older `data/atlas.json` remains untouched.

## Install, test, and run

Requires Node.js 20 or newer.

```bash
npm install
npm run db:migrate
npm test
npm start
```

Start a local PostgreSQL 16 instance with `docker compose up -d postgres`, copy `.env.example` into your environment, and export `DATABASE_URL`. Atlas fails clearly when this variable is absent or the database cannot be reached.

Database commands:

```bash
npm run db:status
npm run db:migrate
npm run db:import-json                 # defaults to data/atlas-structured.json
npm run db:import-json -- /path/file   # explicit snapshot
```

Migrations are committed SQL files and run transactionally. The importer preserves IDs, timestamps, archives, schema versions, record values, and audits in a single transaction; it refuses a non-empty database, so an accidental repeat creates no duplicates. For a clean development reset, remove the Compose volume (`docker compose down -v`), restart PostgreSQL, and rerun migrations. Tests use a real PostgreSQL database specified by `TEST_DATABASE_URL` (or `DATABASE_URL`) and isolate cases in temporary schemas.

For local backup/recovery, use `pg_dump "$DATABASE_URL" > atlas.sql` and restore into a freshly migrated/empty database with `psql "$DATABASE_URL" < atlas.sql`. Keep the original structured JSON as a fallback snapshot until the PostgreSQL backup process is established.

PostgreSQL makes Atlas durable and concurrency-safe; it does **not** yet make Atlas the authoritative personal datastore. Existing external spreadsheets remain authoritative until Atlas is hosted and its reliability and value have been proven.

For development with automatic rebuilds:

```bash
npm run dev
```

Configuration:

- `ATLAS_HOST` defaults to `127.0.0.1`.
- `ATLAS_PORT` defaults to `3000`.
- `DATABASE_URL` is required (for example `postgresql://atlas:atlas@127.0.0.1:5432/atlas`).

No model server, embedding service, vector database, Ollama installation, or semantic-interpreter environment variables are required.

## Health check

`GET /health` returns the version, storage format, and active project/store/record counts. Its legacy top-level `projects`, `stores`, and `records` fields intentionally mean active entities. The additive `counts` object reports `{ active, archived, total }` for each canonical entity type; Fabric-derived documents are never included. All MCP traffic uses `POST /mcp`.

## Observatory compatibility

Observatory V2 continues to use the unchanged MCP/HTTP tool contract; it does not connect to PostgreSQL or know how records are stored.
