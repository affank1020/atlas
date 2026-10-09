# Deployment and package boundaries

Atlas is split into independently deployable Server, Node, and Web applications.

## Server

Server is `apps/server` plus `packages/protocol` and `packages/view-runtime`. It owns PostgreSQL migrations, HTTP/MCP, Node authentication and routing, Portfolio media, and Fabric data.

Production requirements:

- `DATABASE_URL` is mandatory.
- Server defaults to a loopback bind. A non-loopback bind requires `ATLAS_TRUSTED_INGRESS=true`; this is intended only when the process is reachable through a reviewed private/container network and reverse proxy.
- Never publish PostgreSQL or the Server container port directly to the internet.
- Never include desktop Node code or a Node credential in the Server image.
- `infra/server.Dockerfile` runs pending migrations before starting Server.

## Node

Node is `apps/node` plus `packages/protocol`. It owns a long-lived outbound WebSocket connection and local capabilities. Run it on the machine that owns Workspace roots, with its UUID and credential in a private `.env.node`.

The desktop entrypoint is `apps/node/src/platforms/desktop/main.ts`. `core/connection` and `core/config` are platform neutral; `capabilities` holds filesystem, Git, dev-task, and Unity implementations.

A hosted Atlas Server does **not** replace the desktop Node. The Node remains on the user's machine and connects outbound to `/node/connect`.

## Web

Web is `apps/web` plus `packages/view-runtime`. Production builds use the current origin for Atlas API calls unless `VITE_ATLAS_API_URL` is explicitly supplied. This keeps Web and API behind the same ingress.

`infra/web.Dockerfile` builds the Vite app and packages it into the Caddy ingress image.

## Single-VPS production stack

`infra/docker-compose.production.yml` defines the initial single-host deployment:

- `postgres`: private PostgreSQL 16 with a persistent volume and no published port.
- `server`: Atlas Server on the Compose network, with persistent Portfolio media and a VPS-loopback-only maintenance port at `127.0.0.1:3000`.
- `ingress`: Caddy serving Atlas Web and reverse-proxying Server routes on ports 80/443.

Caddy routing is intentionally conservative:

- `/node/connect` and `/node/enrol` bypass human Basic Auth because Atlas Node authenticates with its Server-issued credential or one-use enrolment token.
- `/api/public/portfolio`, `/api/media/*`, and the signed Contentful webhook remain public.
- Atlas Web, `/api/*`, `/mcp`, `/projects/*`, and `/health` are protected by Caddy Basic Auth as an interim single-user production boundary.

Basic Auth is appropriate for the initial private single-user deployment, but it is not the long-term Atlas identity model. Replace it with first-class Atlas authentication/OAuth before multi-user or third-party access.

## GitHub Actions and VPS deployment

The checked-in workflows live in `.github/workflows/ci.yml` and
`.github/workflows/deploy.yml`. Production manifests are maintained in
`infra/docker-compose.production.yml`, while `.dockerignore` excludes local
Atlas data snapshots from Docker build contexts.

- **Atlas CI** runs on pushes to `main`, pull requests, and manual dispatch.
  It runs `npm test` on Node 22 with an isolated PostgreSQL 16 service, then
  builds both Docker images. Successful main builds publish
  `ghcr.io/affank1020/atlas-server` and `ghcr.io/affank1020/atlas-web`
  tagged with the exact Git commit SHA and with `latest`. It uses the
  short-lived GitHub Actions token rather than a stored registry password.
- **Atlas Deploy** is manual-only (`workflow_dispatch`) and restricted to
  `main`. It deploys the images tagged with the workflow's commit SHA using
  `docker compose pull` and `up --no-build --wait`. It does not run Node
  on the VPS or copy the repository's local data.

Before first deployment:

1. Confirm both GHCR images exist for the chosen commit. Package visibility
   is independent of repository visibility. Make them public in GitHub
   package settings **or** configure Docker's GHCR read authentication on the VPS.
2. Create a GitHub Actions environment named `production` with appropriate
   environment protection/approval rules. In that environment, add these
   secrets: `VPS_HOST` (server address), `VPS_USER` (SSH account),
   `VPS_SSH_PRIVATE_KEY` (dedicated deployment key), and
   `VPS_SSH_KNOWN_HOSTS` (the independently verified SSH host-key entry,
   e.g. `hostname ssh-ed25519 AAAA...`). Verify the host key out-of-band;
   do not blindly trust an `ssh-keyscan` result.
3. On the VPS, ensure `docker compose` works for the SSH account and create
   `~/atlas-deploy/infra/production.env` **on the VPS only**. Fill in real
   PostgreSQL credentials, site DNS, HTTPS address, and the Basic Auth hash
   based on `infra/production.env.example`. Never add this file to GitHub.
4. Before redirecting an existing Node or treating VPS Atlas as authoritative,
   back up the Mac's PostgreSQL database and plan a tested data migration to
   the persistent VPS volume. A fresh production volume starts empty.
5. Confirm DNS points to the VPS, ports 80/443 are reachable, and HTTPS can
   be provisioned by Caddy. Then trigger **Atlas Deploy** in GitHub Actions.

The deploy workflow uploads only the Compose manifest, not the environment
file. Images are chosen by `ATLAS_IMAGE_TAG`, which the workflow sets to the
commit SHA. Existing volumes are not deleted. Do not use `docker compose down -v`
on a live installation.

For a cautious first boot before DNS/HTTPS, the manual source-build
`postgres server` procedure below remains available over an SSH tunnel. The
workflow deliberately does not automate this partial bootstrap.

## First deployment

Copy the example environment file:

```bash
cp infra/production.env.example infra/production.env
```

Generate a database password using URL-safe characters:

```bash
openssl rand -hex 32
```

Use that value for both `POSTGRES_PASSWORD` and the password component of `DATABASE_URL`.

Generate the Caddy password hash:

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'YOUR_PASSWORD'
```

Put the resulting hash in `ATLAS_ADMIN_PASSWORD_HASH` using single quotes so its `$` characters remain literal.

Do **not** expose Atlas Web/API, Basic Auth credentials, or Node credentials over plain HTTP. Before a hostname has working HTTPS, start only PostgreSQL and Server:

```bash
docker compose --env-file infra/production.env -f infra/docker-compose.production.yml up -d --build postgres server
```

Server is published only on the VPS loopback interface. From a trusted client, use SSH tunnelling for temporary maintenance/testing:

```bash
ssh -L 3000:127.0.0.1:3000 ovh
```

After DNS points a hostname at the VPS, configure:

```text
ATLAS_SITE_ADDRESS=atlas.example.com
ATLAS_WORKSPACE_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,https://atlas.example.com
```

Then start the full stack:

```bash
docker compose --env-file infra/production.env -f infra/docker-compose.production.yml up -d --build
```

Caddy will obtain and renew TLS certificates automatically. Only after HTTPS is live should a remote Atlas Node be pointed at the public `wss://.../node/connect` endpoint.

Inspect it with:

```bash
docker compose --env-file infra/production.env -f infra/docker-compose.production.yml ps
docker compose --env-file infra/production.env -f infra/docker-compose.production.yml logs -f server
```

## Data and AI-provider notes

The production PostgreSQL volume is persistent, but VPS-level backups are not a substitute for a database-level backup. Add scheduled `pg_dump` backups before Atlas becomes authoritative.

The current AI provider defaults to Ollama on `127.0.0.1:11434`. The production stack intentionally does not run an Ollama model on the 4 GB VPS. Core Atlas, lexical retrieval, Views, Node routing, and data management can run without it; semantic retrieval/Ask Atlas require an available configured provider.
