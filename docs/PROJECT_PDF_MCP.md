# Private Project PDF text retrieval over MCP

This extends Project Files discovery and R2 signed-link retrieval, without
changing uploads or exposing private Files through an unauthenticated HTTP route.

## New owner-only MCP operations

- `read_project_file({ projectId, fileId, startPage?, pageCount? })`:
  returns extracted text for 1–5 pages (1-based) from an active Project PDF.
  The default is pages 1–3. Each page includes its original page index and
  an explicit truncation flag when its text exceeds 10,000 characters.
  The response includes `totalPages` and `nextPage` for navigation.
- `search_project_file({ projectId, fileId, query, limit?, offset? })`:
  case-insensitive phrase search across all extractable pages, with page
  indices, occurrence counts, snippets, `totalMatchingPages` and `hasMore`.
  Results are capped to 20 matching pages per call; default limit is 10.

Both tools are registered only for authenticated owner OAuth in MCP. The
dispatcher checks OAuth again, checks the active Project before reading,
then the Atlas Files service checks active file ownership by Project **and**
file ID. Other Projects' files, archived files, missing files, and Relay
service tokens cannot access bytes or cached text.

## Extraction, deployment and resource bounds

Poppler's `pdftotext -layout -enc UTF-8` runs without a shell. PDF bytes
are streamed to the subprocess via stdin. The existing Files service reads
the original object (local or R2) with byte-count and SHA-256 verification.
No temporary unencrypted PDF files are written.

Production `infra/server.Dockerfile` installs `poppler-utils` in the
runtime stage. Local developers must install `pdftotext` separately
(e.g. `brew install poppler`); other Atlas tools continue working if it
is unavailable. Extraction has a 15-second deadline, 2 MiB text output
limit and 600-page cap. An in-memory, per-process LRU cache retains up to
12 documents / 12 MiB extracted text, keyed by Project, file ID and checksum.
Active-file metadata is rechecked on every call, including cache hits.
Concurrent calls coalesce extraction of the same document; cache is reset
on restart and never persisted to PostgreSQL.

## Limitations

This MVP handles PDFs with selectable text. It does **not** run OCR on
scanned pages, provide a page-image tool, or promise perfect LaTeX/formula
reconstruction. Poppler preserves layout best-effort, but mathematical
symbols, subscripts and diagrams may be lost. For authoritative equations
use the original PDF via `get_project_file`'s short-lived signed link.
The JSON/text response contains only requested bounded excerpts, never
the entire raw file or its R2 key.

## Verification

`test/project-pdf-mcp.test.ts` checks page numbering, search results,
pagination validation, active-file gating, Project isolation, checksum
cache invalidation, malformed inputs and dispatcher authorization.
The server build checks TypeScript integration. A live PDF extraction
smoke test in the deployed Docker image is recommended after merge.
