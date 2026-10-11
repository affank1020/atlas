# Atlas Control

Atlas Control manages the hosted MacBook Node and the optional local development
stack as separate lifecycles. It keeps owned process IDs and logs in one place
without claiming or stopping unrelated processes.

Terminal-managed services open in their own window, where live output remains
visible. A launchd-managed hosted Node runs in the background and writes to the
log paths reported by `./atlasctl launchd status`.

From the Atlas repository:

```bash
./atlasctl up
```

This builds and starts only the compiled MacBook Node configured by
`apps/node/.env.node` for the hosted VPS. It has no file watcher. For automatic
login startup and unexpected-exit recovery, install the user LaunchAgent:

```bash
./atlasctl launchd install
./atlasctl launchd status
```

The plist refers to `.env.node` but contains no Node ID or credential. Remove
it without deleting credentials, Workspace configuration, or logs with
`./atlasctl launchd uninstall`.

## Local development

The local stack is always explicit and keeps the watcher-based Node:

```bash
./atlasctl dev up
./atlasctl dev up --ask
./atlasctl dev down
./atlasctl dev down --all
```

`dev down` stops only managed development processes. `--all` additionally
stops managed Compose PostgreSQL; neither form stops the hosted Node.

## One-time tunnel setup

The MCP tunnel needs an OpenAI control-plane API key. Save it securely in the
macOS Keychain once:

```bash
./atlasctl configure tunnel-key
```

Paste the key at the visible prompt so you can verify its ending. Future tunnel windows retrieve it from the
Keychain automatically; the key is not written to shell configuration, logs,
or this repository.

Useful commands:

```bash
./atlasctl status
./atlasctl start server
./atlasctl stop server
./atlasctl start node
./atlasctl stop node
./atlasctl start web
./atlasctl stop web
./atlasctl logs
./atlasctl logs tunnel
./atlasctl restart
./atlasctl start ollama
./atlasctl stop ollama
./atlasctl down
./atlasctl vps diagnose
```

`up`, `down`, and `restart` affect only the hosted Node. Processes started by
another terminal or supervisor are shown separately as unmanaged and are never
stopped by Atlas Control. The old `atlas` and `observatory` service names remain
accepted as legacy aliases for `server` and `web`.

Atlas Web is at <http://127.0.0.1:5173>. The tunnel's own diagnostics are at
<http://127.0.0.1:8080/ui>.

## Native macOS menu-bar UI

On macOS 13 or later, run `./atlasctl ui` from the Atlas repository.
It builds `.build/Atlas Node.app` and opens the menu-bar utility. The UI delegates
Start, Stop, Restart and LaunchAgent installation to `atlasctl` rather than
running a second process supervisor. No Node credentials are read by the UI.

The control window shows local process/launchd state, actual Node connection
state, last connection transition and bounded logs. The Node publishes a
credential-free heartbeat at
`~/Library/Application Support/Atlas/node-status.json`.
An absent or stale heartbeat is **unverified**, never treated as connected.
To enable diagnostics for an already running older Node, choose a safe time
to build and restart it with `./atlasctl restart` (it can interrupt Node work).
`./atlasctl status --json` is the corresponding read-only machine interface.
WebSocket close codes are recorded so deploy/network/process issues are easier
to distinguish. The app is local-built with Swift Command Line Tools and is
not code-signed or notarised.

Use `./atlasctl launchd install` for login startup and process crash recovery.
Do not start a second supervisor under the same Node ID; a later connection
replaces an earlier one.
## Requirements

- Docker Desktop for PostgreSQL
- Node.js and installed dependencies in the monorepo root
- `tunnel-client` with the existing `atlas-local` profile
- Ollama and the Atlas models for `--ask`

The tunnel profile reads its control-plane key from `CONTROL_PLANE_API_KEY`
(or `OPENAI_API_KEY`). An Atlas key saved in macOS Keychain takes priority over
those variables, preventing an old exported key from overriding the key chosen
with `./atlasctl configure tunnel-key`.
