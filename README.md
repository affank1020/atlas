# Atlas

Atlas is an npm workspace monorepo. **Being in the same monorepo does not mean Server and Node are deployed together.**

```text
Atlas/
├── apps/server/           HTTP, MCP, Core, database, migrations, Workspace metadata, Node registry and routing
├── apps/node/             standalone outbound Node client and local desktop capabilities
├── apps/web/              independent React/Vite Server client
├── packages/protocol/     version 2 Server–Node wire schemas, operations and validation
├── packages/view-runtime/ shared browser View host/kit used by Server and Web
├── infra/                 PostgreSQL Compose and Server image definition
├── config/                operator-owned named task definitions and policy examples
├── docs/                  architecture and feature documentation
└── test/                  integration and contract regression tests
```

Server and Node depend on `@atlas/protocol`; protocol has no application dependency. Server cannot import Node implementation, and Node cannot import Server implementation. Web uses `VITE_ATLAS_API_URL` for the Server endpoint (defaults to `http://127.0.0.1:3000`). The View host/kit is a small separate browser package so Web builds without Server source. Architecture tests enforce these dependencies.

## Local development

Node.js 20+ and PostgreSQL are required. Run `npm ci` once at the root, then `npm run db:migrate` with `apps/server/.env` configured. Keep all `.env` files private. Start the three apps independently with `npm run dev:server`, `npm run dev:node`, and `npm run dev:web`. `./atlasctl start server`, `./atlasctl start node`, and `./atlasctl start web` manage individual local processes; `./atlasctl dev up` explicitly starts the combined development stack plus PostgreSQL and the MCP tunnel. For a local Compose database use `docker compose -f infra/docker-compose.yml up -d postgres`.

For the hosted topology, edit only the existing private `apps/node/.env.node` to set `ATLAS_SERVER_URL=wss://affan-atlas.duckdns.org/node/connect`, then use `./atlasctl up` to start only the MacBook Node. `./atlasctl down` and `restart` operate on that Node alone. The full local-development stack is available explicitly as `./atlasctl dev up` (including the legacy MCP tunnel). `./atlasctl vps status`, `./atlasctl vps diagnose` and `./atlasctl vps logs server` call the VPS diagnostics remotely over your SSH alias `ovh`. See the [operations runbook](docs/OPERATIONS.md) for Node migration and diagnostics, and [direct MCP OAuth setup](docs/MCP_AUTH.md) for replacing the Secure MCP Tunnel with a ChatGPT plugin connected to the hosted Server.

`npm run build` builds both shared packages and all three applications. `npm test` runs the 113 Server/Node integration tests (using isolated PostgreSQL schemas) and the Web test suite. `npm run build:server`, `build:node`, `build:web`, `test:server`, `test:node`, and `test:web` are available individually. `npm run start:server` and `npm run start:node` use compiled entrypoints.

## Configuration and identity

Server reads `apps/server/.env`; copy `apps/server/.env.example` and set `DATABASE_URL`. Server defaults to remote Node execution and refuses the old local execution mode. Migrations are unchanged SQL files in `apps/server/migrations`, tracked in the existing `atlas_migrations` table. `npm run db:status` and `npm run db:migrate` use the Server configuration. The media directory is Server owned.

Node reads `apps/node/.env.node`; copy `apps/node/.env.node.example` for a new Node. An existing Node must retain its `ATLAS_NODE_ID` and `ATLAS_NODE_CREDENTIAL`. Set `ATLAS_SERVER_URL` to `/node/connect` and `ATLAS_WORKSPACE_ROOTS` to comma-separated approved absolute paths. Plaintext `ws://` is accepted only for loopback; other destinations require `wss://`. Node revalidates the bound root and each request before execution. Enrolment and credential rotation are Server identity operations; see [Node architecture](docs/architecture/ATLAS_NODES.md).

A Workspace belongs to a Project and is placed on a Node. `Workspace` metadata, placement, audits, and routing stay in Server/PostgreSQL. File, Git, named dev-task, and Unity execution happens in the Node. The Atlas Workspace uses the monorepo root; AI Football retains its own root. The named dev tasks in `config/atlas-dev-tasks.json` provide full test/build and individual app builds. Callers can select only configured task names, never send a shell command.

## Deployment boundaries

The Server image in `infra/server.Dockerfile` copies only Server, protocol, and View runtime source for build; it does not start Node. A hosted topology runs Server and PostgreSQL, with Web deployed separately. A desktop Node runs on the machine that owns the Workspace files and connects outbound to Server. Future Android, iOS, Windows, or Linux implementations can supply different capability implementations behind the same Node core and protocol; no such clients are included now. HTTP access to a hosted Server and secure WebSocket transport need an appropriate trusted ingress/proxy, since the Server's direct listener currently remains loopback bound for remote Node mode.

The original Atlas Git history remains the primary monorepo history. The former `atlas-ui` checkout had no Git repository to import; its source and tests were moved intact. A private pre-migration recovery snapshot and database dump were taken before the move. See [deployment notes](docs/deployment.md) and the detailed [Server](docs/architecture/ATLAS_SERVER_ARCHITECTURE.md) and [Node](docs/architecture/ATLAS_NODES.md) documents.
