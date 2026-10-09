# Direct ChatGPT → Atlas MCP (OAuth, no tunnel)

Atlas MCP endpoint: `https://affan-atlas.duckdns.org/mcp`.

This is the **direct replacement** for the private MacBook Secure MCP Tunnel.
Atlas Web still uses its own temporary Caddy Basic Auth login. MCP uses
OAuth tokens issued by a trusted provider (recommendation: Auth0) and verified
by Atlas Server. The local database and desktop Node are not involved in MCP
authentication.

## What the code now does

- Caddy routes `/mcp` and
  `/.well-known/oauth-protected-resource` to Atlas Server without the **human**
  Basic Auth prompt, but retains Basic Auth on Web and ordinary HTTP tools.
- On trusted production ingress, the MCP endpoint returns **503** until the
  required OAuth environment variables are supplied; it never falls through to
  anonymous access.
- Without a Bearer token or with an invalid token, returns **401** and an OAuth
  resource metadata `WWW-Authenticate` challenge.
- With a valid RS256 JWT from the configured Auth0 issuer, verifies signing key,
  issuer, exact MCP audience/resource, expiry, not-before, the exact **owner
  subject**, and `atlas:access` permission. Uses issuer-pinned JWKS with a
  short bounded cache. No access tokens or secrets are logged.
- In local loopback development, the old unauthenticated local MCP behavior
  remains available **only outside** trusted production ingress, so old tests
  and development flows still work.
- The MCP tool registry advertises its OAuth security scheme when configured.
- All other HTTP/UI/Node authorization policies are unchanged.

## 1. Configure Auth0 (one-time)

Use https://manage.auth0.com/ and create your tenant and your own user.
Do not send anyone your login, client secret or access token.

1. Under **Applications → APIs**, create API "Atlas MCP".
   Its **Identifier / Audience must be exactly**:

   ```text
   https://affan-atlas.duckdns.org/mcp
   ```

   Use signing algorithm **RS256**, add the API permission `atlas:access`,
   and enable offline access if offered (for long-lived ChatGPT linking).
   Enable RBAC/adding permissions to access token as appropriate; the
   verifier accepts `atlas:access` in either `scope` or `permissions`.
2. Under **Settings → Advanced**, enable **Resource Parameter Compatibility
   Profile** so the OAuth `resource` parameter sent by ChatGPT selects the API
   audience. Without this, Auth0 can issue a token for the wrong audience.
3. Under **Applications → Applications**, create a **Regular Web Application**
   called "ChatGPT Atlas MCP". Enable **Authorization Code / PKCE** and **Refresh
   Token** grant where supported, and register the **exact redirect URI shown
   by the ChatGPT custom MCP plugin setup** in Auth0's Allowed Callback URLs.
   Depending on Auth0/OAuth issuer metadata, ChatGPT may use the stable
   `https://chatgpt.com/connector_platform_oauth_redirect` or a connector-
   specific callback URI. Do not guess; inspect the ChatGPT app UI.
4. Prefer using this explicit Auth0 application (known Client ID and Secret),
   rather than switching on *open* Dynamic Client Registration globally for
   a private single-user server.
5. Open **User Management → Users**, find the account you'll log into and copy
   its exact **User ID** (the `sub` JWT claim, often `auth0|...`).
   Restrict user signups if Atlas should remain private.

Auth0 must provide issuer metadata with `code_challenge_methods_supported`
including `S256`, and ChatGPT must be able to obtain a JWT API access token
with audience `https://affan-atlas.duckdns.org/mcp`. A successful Auth0 web
login alone does not prove that the access token has the right claims.

See: https://developers.openai.com/plugins/build/auth and
https://auth0.com/docs/get-started/applications/dynamic-client-registration

## 2. Set the VPS configuration privately

On the VPS edit `~/atlas-deploy/infra/production.env` (never commit it or
paste it into ChatGPT). **Add exactly these variables:**

```dotenv
ATLAS_MCP_RESOURCE=https://affan-atlas.duckdns.org/mcp
ATLAS_MCP_OAUTH_ISSUER=https://YOUR-TENANT.REGION.auth0.com/
ATLAS_MCP_OAUTH_ALLOWED_SUBJECT=auth0|EXACT-USER-ID
```

Issuer must be exactly Auth0's published `issuer` (including trailing slash),
and subject must match the `sub` of *your* user. Keep the existing database
connection and Caddy login unchanged.

## 3. Deploy the reviewed Git commit

From the Mac repo, review and commit the MCP OAuth changes and push `main`.
Wait until the CI workflow publishes both container images for that commit.
Then run the repository's **Atlas Deploy** GitHub Actions workflow on `main`.
It uploads the current Compose manifest, pulls pinned Server/Web images and
recreates the stack without deleting Postgres volumes. The workflow uses the
commit SHA as an environment override; after deployment, keep the
`ATLAS_IMAGE_TAG` in the **private** VPS environment file in sync with the
deployed commit so future manual Compose operations do not downgrade images.

If the Auth0 variables are absent the new hosted endpoint safely returns 503
until configured, while Atlas Web remains available.

## 4. Verify on the VPS or the Mac

No credentials required for these read-only checks. From your Mac, after
copying the updated `scripts/atlas-vps.sh` helper to the VPS, you can run
`./atlasctl vps mcp` for the same OAuth protection check.

```bash
curl -fsS https://affan-atlas.duckdns.org/.well-known/oauth-protected-resource
```

Expected: JSON including `resource`, `authorization_servers`, and
`scopes_supported`. It should contain **only your chosen Auth0 issuer**.

```bash
curl -sS -D - -o /dev/null -X POST https://affan-atlas.duckdns.org/mcp
```

Expected: **HTTP 401** with `WWW-Authenticate: Bearer resource_metadata=...`
(without any token). A **503** indicates OAuth isn't configured, **404**
suggests old deployment or routing, and **401 Basic** indicates old Caddy
configuration. Never test by making `/mcp` public without authentication.

## 5. Add the direct ChatGPT plugin

In ChatGPT (web), go to **Plugins → + → Add custom MCP server**.

- Name: `Atlas Hosted` (temporary second connector; keep the original alive).
- Server URL: `https://affan-atlas.duckdns.org/mcp`
- Connection: direct **Server URL**, not Tunnel.
- Authentication: **OAuth**.
- If ChatGPT offers static Client ID/Secret inputs, use the new
  **ChatGPT Atlas MCP** application values from Auth0 (not Atlas DB credentials).
- Copy the exact OAuth callback URL shown by ChatGPT into Auth0's Allowed
  Callback URLs, if not already configured.
- Complete Auth0 Universal Login as your designated account and grant
  `atlas:access` as prompted.
- Install the new plugin and test a read-only `get_atlas_status` call.
  The VPS should return your migrated projects/stores/records.
- After migrating the MacBook Node to WSS, verify `list_nodes` and
  `workspace_git_status` against **Atlas Hosted**.

Only after the new plugin is verified should you disconnect the original
tunnel-backed Atlas plugin and stop the old MacBook tunnel/local Server.
Do **not** delete the old database or local private backup yet.

## Troubleshooting

- `401 Bearer`: JWT absent/wrong signature/issuer/audience/user/scope/expiry;
  Auth0 Resource Parameter Compatibility Profile and audience must match.
- `503 MCP_AUTH_PROVIDER_UNAVAILABLE`: Server could not fetch trusted JWKS
  from Auth0; check the Auth0 issuer URL and VPS outbound network.
- `503 MCP_OAUTH_NOT_CONFIGURED`: config missing/incomplete, or old image.
- Invalid OAuth client: check exact ChatGPT callback URI, Auth0 app grant
  types, Client ID/secret and registration options.
- Auth0 login succeeds but tools fail: check `aud`, `sub` and `scope` claims,
  without sharing raw access tokens.
- Keep `/mcp` behind OAuth; don't remove Server validation to fix linking.
