# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Ollama-compatible HTTP shim in front of [Kiro](https://kiro.dev) ACP agents. It spawns `kiro-cli acp` as a child process, speaks JSON-RPC 2.0 over its stdio, and translates between that protocol and the Ollama REST API shape. Any tool that talks to Ollama (LangChain, Continue.dev, Open WebUI, LangFlow, etc.) can point at this server and transparently route to Kiro ACP agents.

## Commands

```bash
npm install
node acp-server-ollama.js               # start the server (default port 11434)
DEBUG=1 node acp-server-ollama.js       # verbose JSON-RPC logging to stderr
AUTH_TOKEN=sk-mykey node acp-server-ollama.js

npm run format   # biome format --write .
npm run check    # biome check --write . (format + lint)
npm test         # node --test test/regression.test.js  (NOTE: test/ does not exist yet)
```

> **Note:** `npm start` / `npm run full` in package.json still reference the old deleted bridge server files and do not work. Run `node acp-server-ollama.js` directly.

Server defaults to **http://localhost:11434**. No build step — plain ESM (`"type": "module"`), Node 18+.

## Runtime environment

`kiro-cli` is a Linux binary. On Windows, develop under **WSL2** with `KIRO_CMD=~/.local/bin/kiro-cli`. Kiro must be authenticated (`kiro auth login`) before the server can spawn working sessions.

Config is via env vars / `.env`:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `11434` | HTTP listen port |
| `KIRO_CMD` | `kiro-cli` | Path to kiro-cli binary |
| `POOL_SIZE` | `4` | Pre-warmed kiro-cli processes |
| `SESSION_TTL_MS` | `1800000` | 30-min session TTL |
| `AUTH_TOKEN` | _(none)_ | Comma-sep bearer tokens; unset = open |
| `ALLOWED_IPS` | _(none)_ | IP allowlist |
| `AUTO_SESSION_HASH` | `0` | `1` = auto-derive session ID from system-prompt hash (for callers like LangFlow that don't send `x-session-id`) |
| `EMBEDDING_MODEL_DEFAULT` | `BGESmallENV15` | Default fastembed model |
| `EMBEDDING_MODELS_ENABLED` | same | Comma-sep list of enabled embedding models |
| `DEBUG` | `0` | `1` = verbose |

## Architecture

A single server file (`acp-server-ollama.js`) implements the full Ollama REST surface backed by Kiro ACP agents.

### Implemented endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/chat` | Multi-turn chat, streaming NDJSON or JSON |
| `POST` | `/api/generate` | Single-turn raw generation |
| `GET` | `/api/tags` | List available models |
| `POST` | `/api/show` | Model metadata |
| `GET` | `/api/ps` | Running models |
| `POST` | `/api/embed` | Embeddings (new API) |
| `POST` | `/api/embeddings` | Embeddings (legacy API) |
| `GET` | `/api/version` | Version string |
| `GET` | `/health` | Pool / registry / embedding stats |
| `GET` | `/health/agents` | Per-slot detail |
| `DELETE` | `/v1/sessions/:id` | Tear down a stateful session |
| `POST` | `/api/pull`, `/api/push`, etc. | Stub no-ops |

### Core data flow

1. **`ACPSession`** (an `EventEmitter`) wraps one spawned `kiro-cli` process. It frames JSON-RPC by line (`readline` over stdout), tracks pending requests by id in `_pending`, and emits normalized `chunk` events.
2. **`buildAcpBlocksFromOllama(messages, tools, opts)`** converts the Ollama message array into a single plain-text ACP prompt block. Differences from OpenAI format: `images` is an array on the message object (not content parts); `tool_calls[].function.arguments` is a plain object (not a JSON string); `format: 'json' | <schema>` maps to output-format injection; `think: true` prepends a reasoning instruction.
3. `session/prompt` is sent; Kiro streams back `session/update` notifications routed into `chunk` events of kind `text`, `thought`, `tool_call_start`, `tool_call_update`, `plan`.
4. **`chunksToOllamaMessage(chunks)`** reassembles chunks into an Ollama message object with `content`, optional `thinking`, and optional `tool_calls`.
5. **`coerceToolCall(message, tools)`** post-processes the response to detect and extract tool calls from several formats the model may emit: `{"tool_call": {...}}` wrapper, ` ```tool_call\nfn(args)\n``` ` fence, natural language "Tool call: name\nkey: value", or plain JSON matching a tool's schema.

### Protocol quirks specific to kiro-cli (important — easy to break)

- **Permission requests are auto-granted.** `session/request_permission` is answered with `{ optionId: 'allow_always', granted: true }`. The agent runs unattended with full access.
- **`notifications/initialized` is deliberately omitted** — kiro-cli rejects it.
- **`ping` is not implemented by kiro-cli.** The keepalive timer treats `Method not found` / `-32601` as "alive"; any other ping failure kills the session.
- **Model `"auto"` is a passthrough** — `setModel` skips `session/set_model` for `auto` or the already-current model.
- `session/update` notifications arrive under several method names and use varying field names; `_route` defensively handles all observed shapes.

### Session / pool constructs

- **`ACPPool`**: fixed-size slots warmed at startup; `acquire`/`release` with a FIFO wait queue; dead slots re-initialized lazily. Stateless requests use the pool.
- **`SessionRegistry`**: maps client-supplied `X-Session-Id` header (or `AUTO_SESSION_HASH`-derived id) → a persistent `ACPSession` for multi-turn conversations; TTL-reaped.
- When `tools` are present in a streaming request, text chunks are **not** streamed incrementally — the full response is held until done so `coerceToolCall` can inspect it before writing. This prevents callers (e.g. LangFlow) from seeing content twice.

### Embeddings

Local embeddings via `fastembed` (`EmbeddingRegistry`). Models are lazily loaded and cached in memory. The default model (`BGESmallENV15`) is pre-loaded at startup. `fastembed` is an optional peer dependency — install with `npm install fastembed` if embeddings are needed.

## Linting

Biome (`biome.json`) — tabs, single quotes. Run `npm run check` before committing. No TypeScript; plain ESM throughout.

## Conventions

- Auth: optional bearer token(s) via `AUTH_TOKEN` (comma-separated), optional `ALLOWED_IPS`. `/`, `/api/version`, and `/health` are always unauthenticated.
- Unsupported Ollama params (`keep_alive`, `options`, `suffix`, `raw`) are accepted and silently ignored so off-the-shelf clients don't 400.
- Errors use `{ error: <message string> }` (Ollama format) via the `ollamaError` helper.
- Timing stats (`total_duration`, `prompt_eval_count`, etc.) use `process.hrtime.bigint()` for wall-clock time; token counts are `chars/4` estimates — not a real tokenizer.
