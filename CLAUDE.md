# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two standalone ACP-to-HTTP shims:

| File | API surface | Backend | Port |
|---|---|---|---|
| `acp-server-ollama.js` | Ollama REST (`/api/chat`, `/api/tags`, embeddings, …) | `kiro-cli acp` (Kiro ACP) | 11434 |
| `acp-server-codex.js` | OpenAI REST (`/v1/chat/completions`, `/v1/models`) | `codex-acp` (Codex ACP) | 3456 |

Both spawn their respective ACP backends as child processes, speak JSON-RPC 2.0 over stdio, and translate between that protocol and the target REST shape.

## Commands

```bash
npm install

# Ollama-compatible server (Kiro backend)
npm start                          # node acp-server-ollama.js
npm run start:dev                  # DEBUG=1 node acp-server-ollama.js

# OpenAI-compatible server (Codex backend)
OPENAI_API_KEY=sk-... npm run codex        # node acp-server-codex.js
OPENAI_API_KEY=sk-... npm run codex:dev    # DEBUG=1 node acp-server-codex.js

npm test         # node --test test/regression.test.js (runs against mock subprocess)
npm run format   # biome format --write .
npm run check    # biome check --write . (format + lint)
```

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

### Protocol quirks (kiro-cli)

- `notifications/initialized` is **deliberately omitted** — kiro-cli rejects it.
- `session/request_permission` is auto-granted with `{ optionId: 'allow_always', granted: true }`.
- `ping` returns `-32601` from kiro-cli; the keepalive timer treats this as "alive".
- `session/update` notifications arrive under several method names with varying field names; `_route` handles all observed shapes.
- Tool call arguments from kiro: plain objects (not JSON strings) — Ollama format.

### Embeddings

Local embeddings via `fastembed` (`EmbeddingRegistry`). Optional peer dep — `npm install fastembed`.

Default model auto-selects based on `EMBEDDING_PROVIDERS`: `BGESmallENV15` on CPU, `BGEBaseENV15` when a GPU provider (`dml`, `cuda`, etc.) is configured. Override with `EMBEDDING_MODEL_DEFAULT`.

| Var | Default | Notes |
|---|---|---|
| `EMBEDDING_MODEL_DEFAULT` | _(auto)_ | `BGESmallENV15` (CPU) or `BGEBaseENV15` (GPU). Explicit value overrides auto-select. |
| `EMBEDDING_MODELS_ENABLED` | same as default | CSV; only listed models are loadable at runtime |
| `EMBEDDING_PROVIDERS` | `cpu` | CSV of ONNX execution providers: `dml,cpu` (Windows DirectML), `cuda,cpu` (Linux NVIDIA), `cpu` (default) |
| `EMBEDDING_CACHE_DIR` | _(none)_ | Directory for downloaded ONNX model files |
| `EMBEDDING_BATCH_SIZE` | `32` | Inference batch size |
| `EMBEDDING_MAX_INPUTS` | `2048` | Max array length for `/api/embed` |

---

## acp-server-codex.js — Codex / OpenAI surface

### Runtime

Requires `OPENAI_API_KEY`. The `@zed-industries/codex-acp` npm package provides the `codex-acp` binary (ACP adapter for OpenAI Codex, stdio-based). Server defaults to **http://127.0.0.1:3456**.

**Pre-implementation spike** (run before deploying against real codex-acp): manually probe JSON-RPC methods to verify `initialize`, `session/new`, `session/set_mode`, `session/set_config_option`, streaming notifications, and `UsageUpdate` against the installed version.

### Remote binding safety gate

On startup, if `HOST ≠ 127.0.0.1/localhost` and `ACP_API_KEY` is empty and `ALLOW_INSECURE_REMOTE ≠ 1`, the server exits with code 1. A full-access agent proxy must have auth when exposed beyond loopback.

### Key env vars

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3456` | |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` only with `ACP_API_KEY` set or `ALLOW_INSECURE_REMOTE=1` |
| `ALLOW_INSECURE_REMOTE` | `0` | `1` = allow HOST=0.0.0.0 with no auth (explicit opt-in) |
| `OPENAI_API_KEY` | _(required)_ | Passed to child process env; never logged |
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
npm test   # node:test suite using test/mock-codex-acp.mjs as CODEX_CMD

# Manual smoke test (requires real OPENAI_API_KEY + codex-acp installed)
OPENAI_API_KEY=sk-... node acp-server-codex.js &
curl http://localhost:3456/health
curl http://localhost:3456/v1/models
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

---

## Shared conventions

- Auth: `ACP_API_KEY` / `AUTH_TOKEN` (comma-separated bearer tokens). `/health` and `/` are always unauthenticated.
- Errors: OpenAI-envelope `{ error: { message, type, param, code } }` in codex server; `{ error: <string> }` Ollama format in ollama server.
- No build step — plain ESM (`"type": "module"`), Node 18+.
- Biome (`biome.json`) — tabs, single quotes. Run `npm run check` before committing.
