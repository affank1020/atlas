# Atlas Web

Atlas Web is the local, owner-facing UI for Atlas. Most views inspect
and operate the structured-data platform; the contained Portfolio workspace is
also a publishing CMS. Atlas Web communicates with Atlas through its HTTP
tool bridge—not directly with PostgreSQL.

## Run locally

From the monorepo root, install dependencies and start the frontend:

```bash
npm install
npm run dev:web
```

Open `http://127.0.0.1:5173`. When no API URL is configured, development
runs in **mock mode** by default: seeded demonstration projects, stores,
records, nodes, workspaces, activity and portfolio content, with no local
PostgreSQL or Atlas Server required. Mock mode never makes API requests and
rejects mutations instead of pretending they succeeded. A visible Mock data
label distinguishes fixtures from live infrastructure. Advanced integrations
without fixtures intentionally report an unavailable operation.

To force mock mode even if you have an API URL in your environment, set:

```text
VITE_ATLAS_API_MODE=mock
```

To connect to a real Atlas Server (the PostgreSQL database can be local or
remote), create `apps/web/.env.local` with:

```text
VITE_ATLAS_API_MODE=live
VITE_ATLAS_API_URL=http://127.0.0.1:3000
```

Then run `npm run dev:server` in another terminal with the server's normal
database and authentication configuration. An API URL without an explicit
mode also opts into live mode. **Mock mode only runs in Vite development;**
production builds always use the real backend.

## Main workspaces

- Portfolio: content-type editors, draft/published state, explicit publishing,
  immutable revision history, media uploads, alt text, and generated variants.
- Ask Portfolio: the shared Ask Atlas chat shell fixed to published Portfolio
  content only.
- Projects: generic Core project/store/record/schema/view administration.
- Fabric: lexical, semantic, and hybrid retrieval inspection.
- Ask Atlas: grounded conversation over all public/default Fabric sources.
- Activity: immutable Core mutation history.

Build the production bundle with `npm run build`.

## Design system

See [Atlas Web design system](docs/design/ATLAS_DESIGN_SYSTEM.md) for tokens, navigation, View compatibility and extension rules.
