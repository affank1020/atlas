# Atlas Web

Atlas Web is the local, owner-facing UI for Atlas. Most views inspect
and operate the structured-data platform; the contained Portfolio workspace is
also a publishing CMS. Atlas Web communicates with Atlas through its HTTP
tool bridge—not directly with PostgreSQL.

## Run locally

Start Atlas first:

```bash
cd ../atlas
npm install
npm run dev
```

Then start Atlas Web:

```bash
cd ../atlas-ui
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

By default Atlas Web calls Atlas at `http://127.0.0.1:3000`. To use another
origin, create `.env` with:

```text
VITE_ATLAS_API_URL=http://127.0.0.1:3000
```

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
