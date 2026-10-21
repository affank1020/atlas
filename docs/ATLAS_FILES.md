# Atlas Files — shared storage foundation (PR 1)

## Status and contract

This is the **internal backend foundation**, not a newly exposed files API or UI.
It does not require additional Cloudflare services or change the Portfolio publishing contract.

- `apps/server/src/server/file-storage.ts` is the shared byte/object adapter. It
  supports local disk and optional private Cloudflare R2, using server-generated,
  strictly validated object keys.
- `apps/server/src/server/atlas-files.ts` stores new File metadata in PostgreSQL,
  scoped to a project, workspace or application owner. Every read, listing and
  archive requires a matching owner scope; private is the default visibility.
- `apps/server/migrations/018_atlas_files.sql` introduces an additive table;
  it does **not** move existing Portfolio media metadata.
- Portfolio's `/api/media/:id/:variant` URLs, image processing, SQL tables and
  legacy local fallback remain unchanged. The Portfolio storage module is a
  compatibility re-export of the shared byte adapter.

## Current limits and security

The generic service has no HTTP/MCP endpoints yet. Only trusted server-side
integrations should call it after independently checking the caller's rights to
the requested owner. The `visibility` field is metadata, **not** a permission
to expose an R2 bucket or object publicly. Keep all buckets private.

Uploads currently accept buffered data up to 25 MiB. Bulk artifact streaming,
presigned uploads, downloads and a Files UI are out of scope for this PR.
An archive updates PostgreSQL metadata only: object retention, physical garbage
collection and verified backup lifecycle policies are separate follow-up work.
Scope names and ownership records are not automatically reconciled to deleted
projects or workspaces yet.

## Follow-up

PR 2 should add authenticated APIs and central authorisation checks before
introducing direct-to-R2 uploads, public CDN delivery, private downloads or an
interactive Files browser. Never point a public DNS hostname at the existing
private Portfolio bucket without separating public and private assets first.
