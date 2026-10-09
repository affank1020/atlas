#!/usr/bin/env bash
# Atlas production diagnostics. Safe by default: does not print Compose configuration or secrets.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/infra/docker-compose.production.yml" ]]; then
  ROOT="$SCRIPT_DIR"       # copied to ~/atlas-deploy/atlas-vps.sh
elif [[ -f "$SCRIPT_DIR/../infra/docker-compose.production.yml" ]]; then
  ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"  # in monorepo scripts/
else
  echo "Cannot find infra/docker-compose.production.yml next to this script." >&2
  exit 2
fi

ENV_FILE="$ROOT/infra/production.env"
COMPOSE_FILE="$ROOT/infra/docker-compose.production.yml"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Production env file is missing: $ENV_FILE" >&2
  exit 2
fi

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
domain() {
  # Only read the public hostname. Never source production.env or echo secrets.
  awk -F= '$1 == "ATLAS_SITE_ADDRESS" { print $2; exit }' "$ENV_FILE" | tr -d '\r'
}

health() {
  printf '%s\n' 'Atlas server health (VPS loopback):'
  curl --fail --silent --show-error --connect-timeout 3 --max-time 8 \
    http://127.0.0.1:3000/health
  printf '\n'
}

https() {
  local host status
  host="$(domain)"
  if [[ -z "$host" || "$host" == "atlas.invalid" || "$host" == "atlas.example.com" ]]; then
    echo "A real ATLAS_SITE_ADDRESS is not configured." >&2
    return 1
  fi
  printf 'HTTPS certificate/auth check: https://%s/\n' "$host"
  # Do not use --insecure; certificate verification must succeed.
  status="$(curl --silent --show-error --connect-timeout 4 --max-time 12 \
    --output /dev/null --write-out '%{http_code}' "https://$host/")" || return
  printf 'HTTP status: %s (401 is expected without a Basic Auth login)\n' "$status"
  [[ "$status" == "401" ]] || {
    echo "Unexpected response: check DNS, Caddy routing, and Basic Auth." >&2
    return 1
  }
}

mcp() {
  local host metadata status challenge
  host="$(domain)"
  [[ -n "$host" ]] || { echo "Atlas site hostname is missing." >&2; return 1; }
  printf 'MCP OAuth resource discovery: https://%s/.well-known/oauth-protected-resource\n' "$host"
  metadata="$(curl --fail --silent --show-error --connect-timeout 4 --max-time 12 "https://$host/.well-known/oauth-protected-resource")" || return
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$metadata" | jq '{resource, authorization_servers, scopes_supported}'
  else
    printf '%s\n' "$metadata"
  fi
  printf '\nUnauthenticated MCP POST (should be 401 Bearer):\n'
  status="$(curl --silent --show-error --connect-timeout 4 --max-time 12 \
    --output /dev/null --write-out '%{http_code}' -X POST "https://$host/mcp")" || return
  printf 'HTTP status: %s\n' "$status"
  [[ "$status" == "401" ]] || { echo "Unexpected MCP status: expected 401 Bearer." >&2; return 1; }
}

nodes() {
  printf '%s\n' 'Node registrations/presence (VPS loopback):'
  local response
  response="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 8 \
    -H 'Content-Type: application/json' --data '{}' \
    http://127.0.0.1:3000/api/tools/list_nodes)"
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$response" | jq '[.[] | {id, name, status, credentialState, hostedWorkspaceCount}]'
  else
    printf '%s\n' "$response"
  fi
}

usage() {
  cat <<'EOF'
Atlas VPS diagnostics (run on the VPS, no sudo needed for a Docker-enabled account)

  ./atlas-vps.sh status                  Docker container status and health
  ./atlas-vps.sh health                  Check local Atlas Server and migrated counts
  ./atlas-vps.sh https                   Check TLS and Basic Auth protection
  ./atlas-vps.sh mcp                     Inspect OAuth discovery and tokenless MCP rejection
  ./atlas-vps.sh nodes                   Inspect live Node presence
  ./atlas-vps.sh migrations              Check applied database migrations
  ./atlas-vps.sh logs [server|ingress|postgres]
                                        Show last 80 lines of logs
  ./atlas-vps.sh follow [server|ingress|postgres]
                                        Follow live container logs
  ./atlas-vps.sh diagnose                Combined safe read-only checks

IMPORTANT: Never paste infra/production.env, raw Docker Compose config, or credentials.
Do not use docker compose down -v on production.
EOF
}
case "${1:-help}" in
  status) compose ps ;;
  health) health ;;
  https) https ;;
  mcp) mcp ;;
  nodes) nodes ;;
  migrations) compose exec -T server node scripts/db.mjs status ;;
  logs|follow)
    action="$1"
    name="${2:-server}"
    case "$name" in server|ingress|postgres) ;; *) echo "Invalid service: $name" >&2; exit 2;; esac
    if [[ "$action" == "follow" ]]; then
      compose logs --tail=80 --follow "$name"
    else
      compose logs --tail=80 "$name"
    fi
    ;;
  diagnose)
    compose ps
    printf '\n'
    health
    printf '\n'
    https
    printf '\n'
    nodes
    printf '\n'
    compose exec -T server node scripts/db.mjs status
    ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
