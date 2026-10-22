# Atlas operations and hosted cutover

Production: `https://affan-atlas.duckdns.org`. The VPS hosts Atlas Server,
PostgreSQL and the Caddy/Web ingress. The MacBook hosts only the desktop Node,
Unity and workspace execution. Atlas Node connects **outbound** by WSS.

## Live deployment baseline

- GitHub: `affank1020/atlas`; CI builds Server/Web images tagged by commit SHA.
- VPS: `~/atlas-deploy` holds `infra/docker-compose.production.yml` and the
  **private** `infra/production.env`; image tag is pinned using
  `ATLAS_IMAGE_TAG`.
- VPS database containing restored local history: `atlas_import`. The initial
  fresh `atlas` database still exists as a separate database; do not confuse it
  with the imported production data. Check the effective **database name** in
  `DATABASE_URL` without printing the password.
- At the migration checkpoint there were 10 projects, 46 stores, 559 records and
  4 views including archived entries. These numbers will change with usage.
- `postgres` is private; Server binds to VPS loopback `127.0.0.1:3000`;
  `ingress` alone publishes 80/443.
- The raw `/mcp` endpoint is NOT a public unauthenticated API. Caddy Basic Auth
  protects Web and ordinary APIs, while `/mcp` uses dedicated OAuth bearer
  verification on Atlas Server; if hosted OAuth is unset, `/mcp` returns 503.
  See [direct MCP authentication](MCP_AUTH.md). `/node/connect` and `/node/enrol`
  bypass **human** Basic Auth but require server-validated Node credentials or
  one-use tokens.

## Read-only VPS diagnostics

Copy the helper from the Mac repo once:

```bash
scp scripts/atlas-vps.sh ovh:atlas-deploy/atlas-vps.sh
ssh ovh
cd ~/atlas-deploy
chmod 700 atlas-vps.sh
./atlas-vps.sh diagnose
```

You can also use the local CLI over SSH: `./atlasctl vps status`,
`./atlasctl vps diagnose`, `./atlasctl vps mcp` or `./atlasctl vps logs server`. It uses the `ovh`
SSH alias by default; set `ATLAS_VPS_SSH_HOST` to a different trusted SSH
alias if necessary.

Other commands: `./atlas-vps.sh status`, `health`, `https`, `nodes`,
`migrations`, `logs ingress`, `logs server`, `follow server`.
The script does not dump the environment or print the database password.
Container logs can nevertheless contain sensitive debugging data; redact
before sharing. No production data is modified by these commands.

Manual equivalent, when debugging the helper itself:

```bash
docker compose --env-file infra/production.env -f infra/docker-compose.production.yml ps
curl -fsS http://127.0.0.1:3000/health
docker compose --env-file infra/production.env -f infra/docker-compose.production.yml logs --tail=80 server
```

Avoid `docker compose config` without `--quiet`, as it can print resolved
secrets. Never run `docker compose down -v` on the VPS.

## Optional Tailscale private Node transport (staged, not yet activated)

Atlas's public HTTPS endpoint, Portfolio CMS API/media and ChatGPT MCP/OAuth stay
publicly reachable through the existing Caddy ingress. **Tailscale is an
additional private transport for Node WebSockets**, not a replacement for public
Atlas APIs or an alternative to Node authentication.

The initial HTTPS reverse proxy on `8443` accepted Node registrations but
experienced repeated abnormal WebSocket closures (`1006`); it is not
accepted as the production Node transport yet. The opt-in alternative uses
**Tailscale Serve TLS-terminated TCP** on a separate tailnet-only port,
feeding a dedicated HTTP/1.1 Caddy sidecar. Its listener is bound to
VPS loopback `127.0.0.1:3100`; its routes are limited to
`/node/connect` (credential-authenticated WSS upgrade) and `/node/enrol`
(one-use enrolment token). All other routes return HTTP 404.

### Activate the isolated TCP-mode test endpoint

After merging/deploying the Atlas commit that contains
`infra/docker-compose.production.yml` and
`infra/Caddyfile.node-private`, on the VPS:

```bash
cd ~/atlas-deploy
docker compose --env-file infra/production.env -f infra/docker-compose.production.yml \
  --profile tailscale up -d node-private-ingress
curl -i http://127.0.0.1:3100/health
sudo tailscale serve --bg --tls-terminated-tcp=8444 tcp://127.0.0.1:3100
tailscale serve status
```

The `/health` curl above must return **404**, because this proxy should not
permit administrative or general Atlas API access. If Tailscale Serve rejects
the TCP listener configuration, do not modify the public ingress or Node
identity; inspect the installed Tailscale version and CLI help first.

From the Mac, while connected to the tailnet, check that
`https://vps-996c17b1.tail8f0f1e.ts.net:8444/health` returns 404 and
a WebSocket upgrade to `/node/connect` **without** credentials returns 401.
Then edit only `ATLAS_SERVER_URL` in private `apps/node/.env.node`:

```dotenv
ATLAS_SERVER_URL=wss://vps-996c17b1.tail8f0f1e.ts.net:8444/node/connect
```

Run `./atlasctl restart` to compile the heartbeat-enabled Node and
reconnect with its existing UUID, credential and Workspace bindings.
Monitor `./atlasctl status --json`, `./atlasctl logs node`, and the live
server Node registry for repeated disconnects. Run a real read-only
Workspace or Git operation; leave the Mac awake and test sleep/wake recovery
separately. The Node client watchdog probes every 15 seconds and forcibly
recycles a connection after 45 seconds without a WebSocket pong, so a
stale connection after sleep should recover rather than require restart.

### Rollback and cleanup

To restore the known public transport, change only the Node URL back to
`wss://affan-atlas.duckdns.org/node/connect` and run `./atlasctl restart`.
Keep both tailnet test endpoints isolated until the private route is proven.

After a successful comparison, optional cleanup on VPS:

```bash
sudo tailscale serve --tls-terminated-tcp=8444 off
docker compose --env-file infra/production.env -f infra/docker-compose.production.yml \
  --profile tailscale stop node-private-ingress
```

Don't turn off the existing `8443` HTTPS Serve listener until its use has been
reviewed; don't use `tailscale funnel` or publish VPS port `3100` on
`0.0.0.0`. Tailnet ACL/grants should restrict access to the private Node
port, and the existing app-level Node credentials must remain mandatory.

## MacBook Node cutover

**Cutover order for uninterrupted ChatGPT workspace access:** first establish
and test the new direct authenticated MCP connection (see below), then move
the Node's WSS URL to the VPS, then retire the local Server and tunnel. A
one-off Node WSS test before direct MCP is possible, but while connected to
the VPS it will look **offline** to the old tunnel-backed local MCP Server:
ChatGPT's current Workspace, Git and Unity calls may temporarily fail. Avoid
writing Atlas records through the local MCP Server after the data migration,
since those writes do not reach the VPS database.

**Before changing anything:** preserve `apps/node/.env.node` in a private backup,
and verify the VPS database contains the registered Mac Node UUID and assigned
Workspaces (`./atlas-vps.sh nodes`). After database migration, its stored credential
hash should correspond to the existing local `ATLAS_NODE_CREDENTIAL`; no reenrolment
or credential rotation should be needed.

1. Ensure `https://affan-atlas.duckdns.org` is reachable with valid TLS.
2. On the Mac, inspect `./atlasctl status`, then stop the managed local Node:
   `./atlasctl stop node`. If it reports an **external** process, identify its
   process supervisor before stopping it; avoid accidentally running two clients.
3. Edit only `ATLAS_SERVER_URL` in the existing **private**
   `apps/node/.env.node`:

   ```dotenv
   ATLAS_SERVER_URL=wss://affan-atlas.duckdns.org/node/connect
   ```

   Keep `ATLAS_NODE_ID`, `ATLAS_NODE_CREDENTIAL`, and
   `ATLAS_WORKSPACE_ROOTS` **unchanged**. Do not commit or paste these secrets.
4. Start `./atlasctl up`. It builds and starts **only the compiled Node**, not
   local Server, Web, PostgreSQL or MCP tunnel. It does not use `tsx watch`, so
   rebuilding shared packages cannot interrupt Workspace operations.
   `./atlasctl down` stops only the hosted Node.
   The previous `--hosted` flag is now optional for compatibility; the full
   local stack requires an explicit `./atlasctl dev up`.
5. On the VPS run `./atlas-vps.sh nodes` and confirm the same Node UUID is
   **online** with its existing Workspace assignments. Try a harmless
   `workspace_git_status` through the hosted Atlas interface to confirm routing.
6. If the Node does not connect, use `./atlasctl logs node` on the Mac.
   Check DNS, TLS, URL, Node credential, and Workspace root paths. Revert the
   URL to local loopback only if returning to the local Server intentionally.

### Automatic hosted Node startup with launchd

Atlas Control can install a per-user LaunchAgent after the hosted Node URL and
existing identity are configured:

```bash
./atlasctl launchd install
./atlasctl launchd status
```

Installation builds the Node, replaces a Terminal-managed Atlas Control Node,
and starts the compiled entrypoint at login. The plist contains only absolute
executable/configuration paths and a conservative `PATH`; credentials remain
exclusively in the private `apps/node/.env.node`. Unexpected process exits are
restarted, while the Node's own WebSocket client reconnects without exiting
when the VPS is temporarily unavailable.

`./atlasctl up`, `down`, and `restart` use launchd automatically while the
LaunchAgent is installed. Logs are written to `~/Library/Logs/Atlas/node.log`
and `node-error.log`, and are also shown by `./atlasctl logs node`. Remove the
agent without deleting credentials, Workspace roots, or logs with:

```bash
./atlasctl launchd uninstall
```

If installation reports an unmanaged Node process, close or stop the Terminal
or supervisor that owns it and retry. Atlas Control deliberately will not kill
a process it cannot prove it started.

**Important split-brain warning:** A copied PostgreSQL database is a snapshot,
not continuous replication. Until the ChatGPT MCP connection is migrated, the
old tunnel may still send writes to the **Mac's old Server/database**, while
Atlas Web writes to the **VPS**. Do not make authoritative Atlas changes through
the old ChatGPT tunnel during this transition; reconcile any changes made
since the database dump before declaring the Mac database retired.

## Retiring the Secure MCP Tunnel

The currently connected ChatGPT Atlas integration uses the old Secure MCP Tunnel
pointing at the local Server. It does **not** automatically switch because DNS
and HTTPS now work. The new hosted `/mcp` endpoint includes an OAuth JWT gate,
but still requires an operator-configured issuer and user. Follow the complete
[Auth0 + ChatGPT setup runbook](MCP_AUTH.md).

To remove the tunnel completely:
1. Configure Auth0 for the MCP audience and owner identity, set the three
   production OAuth environment values, deploy the new images, and confirm
   a tokenless POST to `/mcp` returns **401 Bearer**. Do **not** disable OAuth
   to make the endpoint reachable.
2. Create a new direct ChatGPT MCP plugin with endpoint
   `https://affan-atlas.duckdns.org/mcp`, authenticate and verify tool
   discovery and a read-only call against the **VPS**.
3. Only after successful direct tests: retire the old tunnel connection in
   ChatGPT; on the Mac run `./atlasctl stop tunnel` (if managed) and stop the
   local Server, Web, and local PostgreSQL **only when unused**. Inspect their
   status and retain the local DB backup. Disable any old auto-start process.
4. Remove the old tunnel's Keychain credential/profile only once verified
   unnecessary. Do not delete the Node's credential or its allow-listed roots.

## Safe database backup (on the VPS)

Use the reviewed [manual age-encrypted PostgreSQL snapshot runbook](POSTGRES_BACKUP.md).
It creates a consistent, explicitly confirmed `pg_dump` stream encrypted before
writing to private host storage and derives the actual database name from the
running Server container. The former manual plain-text dump example is retired.

**Important:** This is still only a local encrypted snapshot. An independent
offsite copy with verified checksum, retention controls and an isolated
restoration drill are required before Atlas can claim database disaster
recovery. Do not prune snapshots while these guarantees are unverified.

## Moving to a purchased domain later

Suppose you buy `example.com` and want `atlas.example.com`:

1. Create DNS `A` record for `atlas` pointing to the VPS's public IPv4.
   Only add `AAAA` if the VPS really serves IPv6. Keep DuckDNS working until
   the new hostname is verified.
2. Update the VPS **private** environment:

   ```dotenv
   ATLAS_SITE_ADDRESS=atlas.example.com
   ATLAS_WORKSPACE_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,https://atlas.example.com
   ```

3. Recreate **server** (origin allowlist) and **ingress** (Caddy hostname), but
   not PostgreSQL; Caddy automatically requests a new certificate:

   ```bash
   docker compose --env-file infra/production.env -f infra/docker-compose.production.yml \
     up -d --no-build --no-deps --force-recreate --wait server ingress
   ```

4. Verify TLS and login at the new URL before switching the Mac Node's
   `ATLAS_SERVER_URL` to `wss://atlas.example.com/node/connect`. Update the
   direct MCP plugin's server URL/metadata if one has been installed.
5. An optional Caddy redirect can keep the old hostname alive for a transition;
   configure that explicitly, otherwise only the new hostname is served.

Remember to update `ATLAS_MCP_RESOURCE` to the new URL `/mcp` and register the
new audience/resource in your OAuth provider before changing ChatGPT's MCP
connection; the resource audience is part of access-token validation.

The Node UUID, workspace IDs, database contents, Docker images and repo do not
need to change for a domain move. A hostname move is largely DNS, TLS and
configuration, not an application migration.
