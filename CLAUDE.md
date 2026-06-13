# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two standalone ACP-to-HTTP shims. **The file name = the REST interface it exposes; the ACP backend is decoupled and selected at startup** via `--backend=<name>`. Either interface can drive either backend.

**Interfaces** (the file = the REST surface):

| File | REST surface | Default port | Default backend |
|---|---|---|---|
| `acp-server-ollama.js` | Ollama REST (`/api/chat`, `/api/tags`, embeddings, …) | 11434 | `kiro` |
| `acp-server-openai.js` | OpenAI REST (`/v1/chat/completions`, `/v1/models`) | 3456 | `codex` |

**Backends** (`--backend=kiro|codex`): defined as a single `BACKENDS` map that is kept **byte-identical** in both files (a regression test enforces this — edit both copies together; markers `// >>> BACKENDS` … `// <<< BACKENDS`). The map is the source of truth for every per-backend quirk (spawn cmd/args, `notifications/initialized`, `session/set_mode`, model-switch method, notification parsing, debug filtering). A single `ACPSession` consumes the selected `PROFILE` with no backend `if`-branches.

`acp-server-codex.js` is a **deprecated forwarding shim** for `acp-server-openai.js` (removed next release).

Both spawn the selected ACP backend as child processes, speak JSON-RPC 2.0 over stdio, and translate between that protocol and the target REST shape.

## Commands

```bash
npm install

# Ollama interface (default backend: kiro)
npm start                          # node acp-server-ollama.js
npm run start:dev                  # DEBUG=1 node acp-server-ollama.js
node acp-server-ollama.js --backend=codex   # Ollama surface over Codex (needs OPENAI_API_KEY)

# OpenAI interface (default backend: codex)
OPENAI_API_KEY=sk-... npm run openai        # node acp-server-openai.js
OPENAI_API_KEY=sk-... npm run openai:dev    # DEBUG=1 node acp-server-openai.js
node acp-server-openai.js --backend=kiro    # OpenAI surface over Kiro (no OPENAI_API_KEY)
# `npm run codex` / `codex:dev` remain as deprecated aliases.

npm test         # node --test test/*.test.js (regression + cross-backend, mock subprocess)
npm run format   # biome format --write .
npm run check    # biome check --write . (format + lint)
```

### Backend selection & decoupled requirements

- `--backend=<name>` (case-insensitive, trimmed). Unknown/missing-map → exit 1. Empty `--backend=` → interface default.
- `OPENAI_API_KEY` is a **backend** requirement: asserted in the codex profile's `buildEnv` whenever `--backend=codex` (either interface); not needed for `kiro`.
- The remote-binding safety gate **follows the backend**: it fires only when `PROFILE.requiresAuthWhenRemote` (codex) and `HOST` is non-localhost and the interface's token list (`ACP_API_KEY` for openai, `AUTH_TOKEN` for ollama) is empty and `ALLOW_INSECURE_REMOTE≠1`.

## acp-server-ollama.js — Kiro / Ollama surface

### Runtime

`kiro-cli` is a Linux binary. On Windows, develop under **WSL2** with `KIRO_CMD=~/.local/bin/kiro-cli`. Kiro must be authenticated (`kiro auth login`) before spawning sessions. Server defaults to **http://localhost:11434**.

### Key env vars

| Var | Default | Notes |
|---|---|---|
| `PORT` | `11434` | |
| `KIRO_CMD` | `kiro-cli` | |
| `POOL_SIZE` | `4` | Pre-warmed processes |
| `AUTH_TOKEN` | _(none)_ | Bearer tokens (comma-sep); unset = open |
| `ALLOWED_IPS` | _(none)_ | IP allowlist |
| `AUTO_SESSION_HASH` | `0` | `1` = hash system prompt → session id |
| `DEBUG` | `0` | `1` = verbose stderr + monolithic log file under `logs/` |
| `LOG_DIR` | `./logs` | Override log file directory (only used when `DEBUG=1`) |

### Implemented endpoints

`POST /api/chat`, `POST /api/generate`, `GET /api/tags`, `POST /api/show`, `GET /api/ps`, `POST /api/embed`, `POST /api/embeddings`, `GET /api/version`, `GET /health`, `GET /health/agents`, `DELETE /v1/sessions/:id`

### Protocol quirks

Per-backend quirks live in the `BACKENDS` profile map (source of truth), not scattered through `ACPSession`. For `kiro`: `notifications/initialized` omitted (kiro rejects it); model switch via `session/set_model`; `session/update` arrives under `session/update` / `session/notification` / `_kiro.dev/session/update`. Shared across both backends: `session/request_permission` auto-granted `{ optionId: 'allow_always', granted: true }`; `ping` `-32601` treated as alive. Tool-call argument **output** format is interface-determined (Ollama = plain object, OpenAI = JSON string), independent of backend.

### Embeddings

Local embeddings via `fastembed` (`EmbeddingRegistry`). Optional peer dep — `npm install fastembed`. It is loaded **lazily**: the server boots (and chat/generate work over any backend) even when fastembed is absent; the `/api/embed*` endpoints then return 503. `embeddings.installed` in `/health` reflects availability.

GPU is auto-detected at startup via `wmic` (Windows → `dml,cpu`) or `nvidia-smi` (Linux → `cuda,cpu`); falls back to `cpu` if neither is found. Override with `EMBEDDING_PROVIDERS`. Default model auto-selects based on detected providers: `BGEBaseENV15` when GPU is active, `BGESmallENV15` on CPU. Override with `EMBEDDING_MODEL_DEFAULT`.

| Var | Default | Notes |
|---|---|---|
| `EMBEDDING_MODEL_DEFAULT` | _(auto)_ | `BGESmallENV15` (CPU) or `BGEBaseENV15` (GPU). Explicit value overrides auto-select. |
| `EMBEDDING_MODELS_ENABLED` | same as default | CSV; only listed models are loadable at runtime |
| `EMBEDDING_PROVIDERS` | _(auto-detected)_ | CSV of ONNX execution providers. Overrides auto-detection. `dml,cpu` (Windows DirectML), `cuda,cpu` (Linux NVIDIA), `cpu` (default) |
| `EMBEDDING_CACHE_DIR` | _(none)_ | Directory for downloaded ONNX model files |
| `EMBEDDING_BATCH_SIZE` | `32` | Inference batch size |
| `EMBEDDING_MAX_INPUTS` | `2048` | Max array length for `/api/embed` |

---

## acp-server-openai.js — OpenAI surface (codex backend by default)

### Runtime

With the default codex backend, requires `OPENAI_API_KEY`. The `@zed-industries/codex-acp` npm package provides the `codex-acp` binary (ACP adapter for OpenAI Codex, stdio-based). Server defaults to **http://127.0.0.1:3456**. (Renamed from `acp-server-codex.js`, which remains as a deprecated shim.)

**Pre-implementation spike** (run before deploying against real codex-acp): manually probe JSON-RPC methods to verify `initialize`, `session/new`, `session/set_mode`, `session/set_config_option`, streaming notifications, and `UsageUpdate` against the installed version.

### Remote binding safety gate

On startup, if `HOST ≠ 127.0.0.1/localhost` and `ACP_API_KEY` is empty and `ALLOW_INSECURE_REMOTE ≠ 1`, the server exits with code 1. A full-access agent proxy must have auth when exposed beyond loopback.

### Key env vars

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3456` | |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` only with `ACP_API_KEY` set or `ALLOW_INSECURE_REMOTE=1` |
| `ALLOW_INSECURE_REMOTE` | `0` | `1` = allow HOST=0.0.0.0 with no auth (explicit opt-in) |
| `OPENAI_API_KEY` | _(required for codex backend)_ | Passed to child process env; never logged. Not needed for `--backend=kiro` |
| `CODEX_CMD` | `codex-acp` | Binary path — pin to version verified by spike |
| `CODEX_MODE` | `full-access` | Permission mode |
| `CODEX_MODEL_DEFAULT` | `gpt-5.5` | |
| `CODEX_AVAILABLE_MODELS` | `gpt-5.5,gpt-5.4,gpt-5.4-mini` | CSV for `/v1/models` |
| `POOL_SIZE` | `4` | |
| `SESSION_TTL_MS` | `1800000` | |
| `MAX_EXEC_MS` | `600000` | Prompt timeout → cancel + 504 |
| `ACP_API_KEY` | _(none)_ | Bearer tokens (comma-sep); unset = open on localhost |
| `ALLOWED_IPS` | _(none)_ | IP allowlist |
| `AUTO_SESSION_HASH` | `0` | |

### Protocol differences vs kiro-cli (codex-acp)

- `notifications/initialized` **is sent** after `initialize` (standard ACP; kiro rejects it).
- Model switching: `session/set_config_option { config_id: 'model', value }` (not `session/set_model`).
- Permission mode: `session/set_mode { modeId: 'full-access' }` (called after every `session/new`).
- Tool call arguments in output: JSON string (OpenAI format), not plain object (Ollama format).

### ACP notification formats

Both serialization styles are handled in `_route`:
- Style A: `{ type: "AgentMessageChunk", content: { text: "..." } }` 
- Style B: `{ AgentMessageChunk: { content: { text: "..." } } }`

`UsageUpdate` notification provides real token counts (falls back to `chars/4` estimate).

### Session / concurrency

- **Pool (stateless)**: `session/new` called per-request on the acquired slot; slot released in `finally`.
- **Registry (stateful, `X-Session-Id`)**: per-session FIFO lock (`_busy` + `_queue`) prevents concurrent turns on the same session. On disconnect: `session/cancel` notification + 3 s grace period before releasing lock.
- `MAX_EXEC_MS` enforced via `Promise.race([promptPromise, timeoutPromise])` → cancel + 504 on timeout.

### OpenAI compatibility

Supported: `model`, `messages`, `stream`, `tools`, `tool_choice`, `response_format.type = 'json_object'`.

Accepted and **silently ignored** (off-the-shelf clients don't 400): `temperature`, `max_tokens`, `top_p`, `seed`, `stop`, `n`, `logprobs`, `parallel_tool_calls`, `stream_options`, `reasoning_effort`, `user`, `service_tier`.

Not supported: `response_format.type = 'json_schema'` (no enforcement), `n > 1`, audio, `stream_options.include_usage`.

### Testing

```bash
npm test   # node --test test/*.test.js

# Manual smoke test (requires real OPENAI_API_KEY + codex-acp installed)
OPENAI_API_KEY=sk-... node acp-server-openai.js &
curl http://localhost:3456/health
curl http://localhost:3456/v1/models
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

- `test/regression.test.js` — OpenAI-interface + codex-backend regression suite, using `test/mock-codex-acp.mjs` as `CODEX_ARGS`.
- `test/cross-backend.test.js` — the 2×2 interface×backend matrix against the recording mock `test/mock-acp.mjs`: asserts each backend's protocol (initialized / set_mode / set_model vs set_config_option), that tool-arg format tracks the interface, the backend-following safety gate, auth enforcement, `--backend` parsing, the deprecated shim boot, and the `BACKENDS` byte-identity guard.

---

## Shared conventions

- Auth: `ACP_API_KEY` (openai interface) / `AUTH_TOKEN` (ollama interface), comma-separated bearer tokens. `/health` and `/` are always unauthenticated.
- Errors: OpenAI-envelope `{ error: { message, type, param, code } }` in the openai server; `{ error: <string> }` Ollama format in the ollama server.
- No build step — plain ESM (`"type": "module"`), Node 18+.
- Biome (`biome.json`) — tabs, single quotes. Run `npm run check` before committing.
