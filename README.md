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

## Persistence

Data is stored in `data/atlas-structured.json` by default. Writes are serialized and replace the file atomically. Set `ATLAS_DATA_FILE` to choose another location.

The previous `data/atlas.json` is not migrated, modified, or loaded. It remains available as a legacy artifact if it already exists.

## Install, test, and run

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm start
```

For development with automatic rebuilds:

```bash
npm run dev
```

Configuration:

- `ATLAS_HOST` defaults to `127.0.0.1`.
- `ATLAS_PORT` defaults to `3000`.
- `ATLAS_DATA_FILE` defaults to `data/atlas-structured.json` in the working directory.

No model server, embedding service, vector database, Ollama installation, or semantic-interpreter environment variables are required.

## Health check

`GET /health` returns the version, storage format, and active project/store/record counts. All MCP traffic uses `POST /mcp`.

## Observatory compatibility

The earlier Observatory depended on the removed event/context/trace and semantic-playground APIs. Those endpoints no longer exist. Its frontend must be redesigned around projects, stores, records, schemas, and audit events before it can work with this Atlas version; that separate redesign is intentionally outside this rewrite.
