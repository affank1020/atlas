# Deployment and package boundaries

Server is `apps/server` plus `packages/protocol` and `packages/view-runtime`. It owns migrations, PostgreSQL, HTTP/MCP, Node authentication and routing. It requires `DATABASE_URL` and a trusted ingress; its direct Node WebSocket endpoint is currently constrained to a loopback listener. Never include the desktop Node code or its credential in a Server image. `infra/server.Dockerfile` expresses the intended source boundary. Database migration files retain their historical filenames and content.

Node is `apps/node` plus `packages/protocol`. It owns a long-lived outbound WebSocket connection and its local capabilities. Deploy it on the machine with the Workspace roots, with the existing UUID and credential in a private `.env.node`. The desktop entrypoint is `apps/node/src/platforms/desktop/main.ts`. `core/connection` and `core/config` are platform neutral; `capabilities` holds filesystem, Git, dev tasks, and Unity implementations. Future platforms should supply implementations without changing Server routing.

Web is `apps/web` plus `packages/view-runtime`. Build with `npm run build:web` and deploy its `dist` separately, setting `VITE_ATLAS_API_URL` to the Server endpoint. It does not read PostgreSQL or local Workspace files.

A production deployment still needs a reviewed ingress/TLS arrangement and production secrets. The provided Dockerfile is packaging groundwork, not a deployment of the current Mac instance.
