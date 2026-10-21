# Atlas Applications

Applications are **code-defined capabilities** with their own frontend and optional
backend/MCP operations. They can belong to a Project or be standalone. They are distinct from Views:
Views embed into the Project interface; Applications are **launched in a new
browser tab** with a dedicated full-page interface.

## Current implementation

Portfolio is the inaugural Application. Its existing Project ID, Stores,
publication revisions, media, Contentful sync, Ask Portfolio and MCP operation
names remain unchanged. No migration or republishing of Portfolio data is needed.

- Server application registry: `apps/server/src/apps/registry.ts`
- Portfolio registration and tools: `apps/server/src/apps/portfolio-definition.ts`
- Application API: `list_applications({ projectId })`, `list_all_applications({})`
  and `get_application({ projectId?, slug })` over the shared HTTP/MCP dispatch.
  The global list excludes applications from archived Projects.
- Typed Application operations: contributed by the definition and exposed on
  both the HTTP tool API and authenticated MCP transport.
- Global Applications launcher: `#/applications` (searchable and filterable)
- Project Applications tab: `#/projects/:projectId/applications`
- Project launch page: `#/projects/:projectId/applications/:slug`
- Standalone launch page: `#/applications/:slug`
- UI component map: `apps/web/src/Applications.tsx`; global directory: `ApplicationsDirectory.tsx`

Launch links use `target="_blank"` and `rel="noopener noreferrer"`; a direct
deep link also works. The previous `#/portfolio` page remains available for
compatibility. The new launch page uses the same compiled React component,
without embedding it in a View sandbox or requiring another server.

## Adding another first-party Application

1. Implement the domain service in Atlas Server (or use the existing Node
   routing layer for work executed on an external device).
2. Register its definition with a unique slug, descriptions, typed operation schemas
   and optionally a Project ID in the composed ApplicationRegistry.
3. Register its frontend component in the Atlas Web component map.
4. Verify project scoping, API and MCP compatibility, and launch behaviour.

The registry deliberately does **not** load arbitrary code, dynamically install
third-party packages, create a database-backed Application instance, or grant
scripts unrestricted machine access. Registration is done in source code.
There are two code-defined Application instances: **Portfolio** and
**Football Training** (FYP). Domain-specific permissions and device capabilities
remain the responsibility of existing Atlas service/Node boundaries.

Football Training is implemented in `apps/server/src/apps/football-training.ts`
and `apps/web/src/FootballTraining.tsx`. Its validated operations route through
the project-owned Unity Workspace to the Mac Node's `football.training`
capability, never to a Python runtime on the hosted Server. The external
Python driver is developed separately in the FYP workspace. See
[`football-training-application.md`](football-training-application.md).

Portfolio and Ask Portfolio no longer have global sidebar entries; the
legacy URLs remain supported. Portfolio links to Ask Portfolio internally.
