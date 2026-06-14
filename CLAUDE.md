# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two standalone ACP-to-HTTP shims. **The file name = the REST interface it exposes; the ACP backend is decoupled and selected at startup** via `--backend=<name>`. Either interface can drive either backend.

**Interfaces** (the file = the REST surface):

| File | REST surface | Default port | Default backend |
|---|---|---|---|
| `acp-server-ollama.js` | Ollama REST (`/api/chat`, `/api/tags`, embeddings, …) | 11434 | `kiro` |
| `acp-server-openai.js` | OpenAI REST (`/v1/chat/completions`, `/v1/responses`, `/v1/models`) | 3456 | `codex` |

**Backends** (`--backend=kiro|codex`): defined as a single `BACKENDS` map that is kept **byte-identical** in both files (a regression test enforces this — edit both copies together; markers `// >>> BACKENDS` … `// <<< BACKENDS`). The map is the source of truth for every per-backend quirk (spawn cmd/args, `notifications/initialized`, `session/set_mode`, model-switch method, notification parsing, debug filtering). A single `ACPSession` consumes the selected `PROFILE` with no backend `if`-branches.

`acp-server-codex.js` is a **deprecated forwarding shim** for `acp-server-openai.js` (removed next release).

Both spawn the selected ACP backend as child processes, speak JSON-RPC 2.0 over stdio, and translate between that protocol and the target REST shape.

## Commands

```bash
npm install

# Ollama interface (default backend: kiro)
npm start                          # node acp-server-ollama.js
npm run start:dev                  # DEBUG=1 node acp-server-ollama.js
node acp-server-ollama.js --backend=codex   # Ollama surface over Codex (codex-acp self-auths)

# OpenAI interface (default backend: codex) — codex-acp uses codex's own login; no API key needed
npm run openai                     # node acp-server-openai.js
npm run openai:dev                 # DEBUG=1 node acp-server-openai.js
node acp-server-openai.js --backend=kiro    # OpenAI surface over Kiro
# `npm run codex` / `codex:dev` remain as deprecated aliases.

npm test         # node --test test/*.test.js (regression + cross-backend, mock subprocess)
npm run format   # biome format --write .
npm run check    # biome check --write . (format + lint)
```

### Backend selection & decoupled requirements

- `--backend=<name>` (case-insensitive, trimmed). Unknown/missing-map → exit 1. Empty `--backend=` → interface default.
- `OPENAI_API_KEY` is **optional** for the codex backend: codex-acp authenticates via codex's own login (ChatGPT/ACP). `buildEnv` passes the key through only when present (API-key auth); it is **not** required to spawn. Not used by `kiro`.
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
| `POOL_PRECREATE` | `0` | `1` = pre-create + recycle pool sessions (see OpenAI section — situational). |
| `CODEX_REASONING_EFFORT` | `low` | Default reasoning effort (codex backend; no-op for kiro). The Ollama `think` field, when a level string (`low`/`medium`/`high`/…), overrides per-request; otherwise this default applies. Empty disables. |
| `AUTH_TOKEN` | _(none)_ | Bearer tokens (comma-sep); unset = open |
| `ALLOWED_IPS` | _(none)_ | IP allowlist |
| `AUTO_SESSION_HASH` | `0` | `1` = hash system prompt → session id |
| `DEBUG` | `0` | `1` = verbose stderr + monolithic log file under `logs/`; also enables `GET /debug/timings` |
| `LOG_DIR` | `./logs` | Override log file directory (only used when `DEBUG=1`) |

### Implemented endpoints

`POST /api/chat`, `POST /api/generate`, `GET /api/tags`, `POST /api/show`, `GET /api/ps`, `POST /api/embed`, `POST /api/embeddings`, `GET /api/version`, `GET /health`, `GET /health/agents`, `GET /debug/timings` (DEBUG), `DELETE /v1/sessions/:id`

### Latency features (parity with the OpenAI server)

Both servers share the same latency tooling and controls: per-request timing split (`[DBG:timing]` + `GET /debug/timings` under `DEBUG`), `POOL_PRECREATE`, `CODEX_REASONING_EFFORT` (Ollama sources the per-request effort from the `think` level), and **`X-Clear-Context: 1`** to reset a persistent `X-Session-Id` between logical sessions without respawn (codex thread restart on the warm process). See the OpenAI section for the measured latency reality and the `reasoning_effort`/`X-Clear-Context` semantics — they apply identically here.

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

The default codex backend does **not** require `OPENAI_API_KEY` — codex-acp authenticates via codex's own login (ChatGPT/ACP). The `@zed-industries/codex-acp` npm package provides the `codex-acp` binary (ACP adapter for OpenAI Codex, stdio-based; pinned 0.16.0). Server defaults to **http://127.0.0.1:3456**. (Renamed from `acp-server-codex.js`, which remains as a deprecated shim.)

### Latency reality (measured against codex-acp 0.16.0, no API key)

A trivial "say ok" request floors at **~8 s prefill** (prompt-sent → first token, inside codex-acp's agent harness + OpenAI prefill) plus **~5 s `session/new`** when cold. Measured TTFT:
- **Cold stateless**: ~13 s (5 s session/new + 8 s prefill).
- **Warm stateful** (reuse `X-Session-Id`, OpenAI prompt cache hit): **~3 s** — the only large win (4–5×), via the registry path.
- `reasoning_effort` is real and applied (`reasoning_gap` → 0 at `low`), but reasoning is **not** the bottleneck for short prompts — prefill is.

**TTFT < 1 s is not achievable through codex-acp**: the fixed agent + model overhead (~3 s warm floor) lives downstream of this proxy. For latency-sensitive callers, **reuse a persistent `X-Session-Id`** rather than stateless calls. Use `DEBUG=1` + `GET /debug/timings` (or `node test/poc-latency.mjs --ttft`/`--split`) to see the per-stage split for your model.

**Pre-implementation spike** (run before deploying against real codex-acp): manually probe JSON-RPC methods to verify `initialize`, `session/new`, `session/set_mode`, `session/set_config_option`, streaming notifications, and `UsageUpdate` against the installed version.

### Remote binding safety gate

On startup, if `HOST ≠ 127.0.0.1/localhost` and `ACP_API_KEY` is empty and `ALLOW_INSECURE_REMOTE ≠ 1`, the server exits with code 1. A full-access agent proxy must have auth when exposed beyond loopback.

### Key env vars

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3456` | |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` only with `ACP_API_KEY` set or `ALLOW_INSECURE_REMOTE=1` |
| `ALLOW_INSECURE_REMOTE` | `0` | `1` = allow HOST=0.0.0.0 with no auth (explicit opt-in) |
| `OPENAI_API_KEY` | _(optional)_ | codex-acp self-authenticates via codex login; passed through only if set (API-key auth). Never logged. Not used by `--backend=kiro` |
| `CODEX_REASONING_EFFORT` | `low` | Default reasoning effort applied when a request omits `reasoning_effort`. `low` = low-TTFT default (codex-acp 0.16.0 rejects `minimal`/`none` for the default preset). Set empty to disable, or `medium`/`high`/`xhigh` for depth. Per-request `reasoning_effort` overrides. |
| `CODEX_CMD` | `codex-acp` | Binary path — pin to version verified by spike |
| `CODEX_MODE` | `full-access` | Permission mode |
| `CODEX_MODEL_DEFAULT` | `gpt-5.5` | For lowest latency set a lean model (e.g. `gpt-5.4-mini`); quality default kept at `gpt-5.5` |
| `CODEX_AVAILABLE_MODELS` | `gpt-5.5,gpt-5.4,gpt-5.4-mini` | CSV for `/v1/models` |
| `POOL_SIZE` | `4` | |
| `POOL_PRECREATE` | `0` | `1` = pool pre-creates `session/new`+`set_mode` at warmup and recycles after each turn. **Situational/experimental**: real-binary benchmarks showed the recycle's `session/new` (~5 s) resurfaces as acquire-wait under back-to-back load, so it rarely helps net; the effective latency lever is **stateful session reuse** (see below). Only useful when `POOL_SIZE` ≫ peak concurrency. |
| `SESSION_TTL_MS` | `1800000` | |
| `MAX_EXEC_MS` | `600000` | Prompt timeout → cancel + 504 |
| `ACP_API_KEY` | _(none)_ | Bearer tokens (comma-sep); unset = open on localhost |
| `ALLOWED_IPS` | _(none)_ | IP allowlist |
| `AUTO_SESSION_HASH` | `0` | |

### Protocol differences vs kiro-cli (codex-acp)

- `notifications/initialized` **is sent** after `initialize` (standard ACP; kiro rejects it).
- Model switching: `session/set_config_option { config_id: 'model', value }` (not `session/set_model`).
- Reasoning effort: OpenAI `reasoning_effort` maps to `session/set_config_option { config_id: 'reasoning_effort', value }` (codex accepts `none|minimal|low|medium|high|xhigh`). Applied via the `setReasoning` profile method (no-op for kiro). codex-acp **rejects** the effort unless the active model preset's `supported_reasoning_efforts` includes it; the call is best-effort (`_reqSafe`) so an unsupported effort silently no-ops. Unknown values are dropped client-side.
- Permission mode: `session/set_mode { modeId: 'full-access' }` (called after every `session/new`). codex modes are only `read-only|auto|full-access` and gate approval/sandbox policy **only** — they do not change the tool surface.
- Tool call arguments in output: JSON string (OpenAI format), not plain object (Ollama format).

### ACP notification formats

Both serialization styles are handled in `_route`:
- Style A: `{ type: "AgentMessageChunk", content: { text: "..." } }` 
- Style B: `{ AgentMessageChunk: { content: { text: "..." } } }`

`UsageUpdate` notification provides real token counts (falls back to `chars/4` estimate).

### Session / concurrency

- **Pool (stateless)**: `session/new` called per-request on the acquired slot; slot released in `finally`. With `POOL_PRECREATE=1`, the slot pre-creates the session at warmup and recycles it in the background on release, so the request reuses a warm session for the default cwd (a custom `X-Working-Dir` still pays `session/new`); isolation is preserved because a consumed session is always re-created before reuse.
- **Registry (stateful, `X-Session-Id`)**: per-session FIFO lock (`_busy` + `_queue`) prevents concurrent turns on the same session. On disconnect: `session/cancel` notification + 3 s grace period before releasing lock.
- **Logical-session boundary — `X-Clear-Context: 1`** (also `reset`/`true`/`yes`): clears the conversation on a persistent `X-Session-Id` between unrelated tasks **without** respawning the process. codex-acp 0.16.0 has no `/clear` command (only `/compact`, which summarizes), so the proxy resets by starting a fresh codex thread (`session/new`) on the same warm process — clean context, no cross-task bleed, and the OpenAI system-prompt prefix cache survives. Skipped on a just-created session. Verified end-to-end: warm turn recalls a fact, the post-clear turn does not. The cleared turn pays `session/new` (~5 s) but avoids process spawn + initialize.
- `MAX_EXEC_MS` enforced via `Promise.race([promptPromise, timeoutPromise])` → cancel + 504 on timeout.

### Endpoints

- `POST /v1/chat/completions` — Chat Completions (streaming + non-streaming).
- `POST /v1/responses` and `POST /responses` — **OpenAI Responses API** (used by clients like Langflow). Translates `input` (string or array of `{type:'message',role,content}` items) + optional top-level `instructions` into the same ACP turn; returns a `response` object with `output[]` + `output_text` + `usage` (non-stream) or the `response.created → response.output_text.delta* → response.completed` SSE event sequence (stream). Honors `reasoning.effort`, `X-Session-Id`, and `X-Clear-Context`.
- `GET /v1/models` and `GET /models` (alias) — model list.
- `GET /health`, `GET /` (open); `GET /debug/timings` (DEBUG).

### OpenAI compatibility

Supported (chat + responses): `model`, `messages`/`input`, `instructions` (responses), `stream`, `tools`, `tool_choice`, `response_format.type = 'json_object'`, `reasoning_effort` / `reasoning.effort` (codex backend; mapped to a reasoning config option — see Protocol differences).

Accepted and **silently ignored** (off-the-shelf clients don't 400): `temperature`, `max_tokens`, `top_p`, `seed`, `stop`, `n`, `logprobs`, `parallel_tool_calls`, `stream_options`, `user`, `service_tier`.

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

- `test/regression.test.js` — OpenAI-interface + codex-backend regression suite, using `test/mock-codex-acp.mjs` as `CODEX_ARGS`. Includes the `POOL_PRECREATE` reuse/recycle behavior.
- `test/cross-backend.test.js` — the 2×2 interface×backend matrix against the recording mock `test/mock-acp.mjs`: asserts each backend's protocol (initialized / set_mode / set_model vs set_config_option), `reasoning_effort` forwarding (codex maps it, kiro no-ops), that tool-arg format tracks the interface, the backend-following safety gate, auth enforcement, `--backend` parsing, the deprecated shim boot, and the `BACKENDS` byte-identity guard.

### Latency instrumentation

When `DEBUG=1`, each chat request emits a `[DBG:timing]` line and pushes a per-request split to an in-memory ring buffer exposed at **`GET /debug/timings`** (unauthenticated, DEBUG-only): `acquire / session_new / set_mode / set_model / prefill / thought_gap / reasoning_gap / gen / total` (ms). `prefill_ms` = prompt-sent → first update; `reasoning_gap_ms` = first update → first text chunk (the reasoning pass for codex reasoning models). A skipped stage is `null` (e.g. `session_new_ms` is null when `POOL_PRECREATE` reuses a warm session).

`test/poc-latency.mjs` is the evidence-gathering harness: Probe 1 fires N "say ok" requests at a running `DEBUG=1` server and prints the median split; Probe 2 spawns `codex-acp` directly and reports which `session/set_config_option` config_ids (× value envelopes) and `session/set_mode` modeIds the installed binary accepts/rejects. Run it against the real binary before relying on `reasoning_effort` (the effort only sticks for model presets that support it).

---

## Shared conventions

- Auth: `ACP_API_KEY` (openai interface) / `AUTH_TOKEN` (ollama interface), comma-separated bearer tokens. `/health` and `/` are always unauthenticated.
- Errors: OpenAI-envelope `{ error: { message, type, param, code } }` in the openai server; `{ error: <string> }` Ollama format in the ollama server.
- No build step — plain ESM (`"type": "module"`), Node 18+.
- Biome (`biome.json`) — tabs, single quotes. Run `npm run check` before committing.
