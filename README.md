# Atlas

Atlas is a local structured-data platform for intelligent clients, exposed over MCP. It stores typed records behind explicit project and store boundaries and provides stable identifiers, controlled schema evolution, structured querying, archival, and an immutable mutation audit trail.

Atlas deliberately does not interpret natural language. Clients decide what data means and call the explicit data tools.

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

`GET /health` returns the version, storage format, and active project/store/record counts. All MCP traffic uses `POST /mcp`.

## Observatory compatibility

Observatory V2 continues to use the unchanged MCP/HTTP tool contract; it does not connect to PostgreSQL or know how records are stored.
