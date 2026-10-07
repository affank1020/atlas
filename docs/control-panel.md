# Atlas Control

Atlas Control is the lightweight launcher for the local Atlas stack. It keeps
the commands, process IDs, and logs in one place so the stack can be restarted
without reconstructing terminal history.

Each long-running service opens in its own Terminal window, where its live
output remains visible. The original terminal stays available for control
commands.

From the Atlas repository:

```bash
./atlasctl up
```

This starts PostgreSQL, Atlas Server, Atlas Node, Atlas Web, and the OpenAI MCP tunnel in
dependency order. To use Ask Atlas, include Ollama:

```bash
./atlasctl up --ask
```

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
./atlasctl restart --ask
./atlasctl start ollama
./atlasctl stop ollama
./atlasctl down
./atlasctl down --all
```

`down` leaves PostgreSQL running so routine restarts are quick. `down --all`
also stops its Docker Compose service. Processes that were already running in
another terminal are shown as `RUNNING*` and are never stopped by Atlas
Control. The old `atlas` and `observatory` service names remain accepted as
legacy aliases for `server` and `web`.

Atlas Web is at <http://127.0.0.1:5173>. The tunnel's own diagnostics are at
<http://127.0.0.1:8080/ui>.

## Requirements

- Docker Desktop for PostgreSQL
- Node.js and installed dependencies in the monorepo root
- `tunnel-client` with the existing `atlas-local` profile
- Ollama and the Atlas models for `--ask`

The tunnel profile reads its control-plane key from `CONTROL_PLANE_API_KEY`
(or `OPENAI_API_KEY`). An Atlas key saved in macOS Keychain takes priority over
those variables, preventing an old exported key from overriding the key chosen
with `./atlasctl configure tunnel-key`.
