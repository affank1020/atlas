# Project Files — read-only MCP access

Atlas Web remains the upload and folder-management interface. This integration
does **not** ingest files or transfer 25 MiB payloads through the MCP transport.

## Owner-authenticated MCP tools

- `list_project_files({ projectId, folderId?, limit?, offset? })` lists active
  files from the specified project, returning metadata and `hasMore`.
  If `folderId` is omitted, it lists files across all folders; `null`
  selects the project root. Default page size is 50, maximum 100, with
  deterministic descending creation-time/ID ordering and bounded offset.
- `get_project_file({ projectId, fileId })` returns the metadata for one
  **active** file in that exact Project plus `downloadUrl` and `expiresAt`
  when primary R2 is configured. Files whose Project does not match return
  NOT_FOUND. Archived files cannot receive links.

Both tools are registered **only for the verified owner OAuth identity** in
Atlas MCP, not for Relay service credentials or unauthenticated clients. The
dispatcher checks the authenticated identity again and checks the Project is
active before consulting Files. No new public Atlas HTTP route is added.

## R2 signed links

`get_project_file` generates a **120-second SigV4 presigned GET** to the
private Cloudflare R2 S3 endpoint. The URL is a bearer capability: anyone
holding it can download the object during its lifetime, without Atlas login.
Do not log, cache, or forward it to untrusted parties. Generate a fresh URL for
each intended retrieval. Signed URLs expire automatically and do not revoke
previously issued URLs when the Atlas metadata is archived.

Atlas MCP never returns the R2 object key or the object bytes directly. It
does not create public buckets or open the private `/api/files/*` admin
endpoints. The original file stays in R2. The URL may be opened by a browser
or fetched by a separate client; ChatGPT access to arbitrary signed URLs
depends on client/tool support.

When primary R2 is not configured, `downloadUrl` and `expiresAt` are
`null` with `availability: "r2_not_configured"`. Legacy local-fallback
objects can still be viewed through the authenticated Atlas Web Files
interface, but should not be assumed available at a generated R2 URL.
The presigner itself makes **no object existence probe** to avoid transferring
bytes; an R2-signed URL for a local-only/missing key may fail on GET.

## Validation

`test/project-files-mcp.test.ts` covers signer bounds, the SigV4 signature,
owner OAuth restrictions, project activation checks, bound file identity, and
SQL pagination/folder scoping.

After merging and deploying, verify on the live authenticated ChatGPT connector:
list a known University Project file, request its signed URL, open it before
expiry, confirm expiry afterward, and reject a cross-Project or archived ID.
An actual PDF read inside ChatGPT is **not** promised by this integration.
