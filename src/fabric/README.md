# Atlas Fabric — frozen retrieval implementation

Fabric is frozen. It remains the current implementation behind Atlas Server Retrieval; it is not a product primitive. Ranking, authority semantics, diagnostic contracts and existing debug tools remain supported. See [Atlas Server architecture](../../docs/architecture/ATLAS_SERVER_ARCHITECTURE.md).

Fabric derives lexical and semantic indexes from active Core records, combines retrieval channels, then applies explicit authority policy and bounded context selection. `search_atlas` and `request_context` are exposed through HTTP and MCP and through the existing Atlas Web Fabric debug page. Ask Atlas consumes this evidence and adds validated structured retrieval when appropriate.

See the root README for ranking, conversation, diagnostics, and test instructions. Core remains independently usable. No canonical records or authority policies need migration for the Server architecture refactor.
