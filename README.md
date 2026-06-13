# acp-to-api

Two HTTP shims that expose ACP agent backends through standard REST APIs. **The file name reflects the REST interface it exposes; the ACP backend is chosen at startup** with `--backend=<name>`, so either interface can drive either backend.

**Interfaces** (the file = the REST surface):

| File | REST API | Default port | Default backend |
|---|---|---|---|
| `acp-server-ollama.js` | Ollama REST | 11434 | `kiro` |
| `acp-server-openai.js` | OpenAI REST | 3456 | `codex` |

**Backends** (`--backend=<name>`):

| `--backend` | ACP child | Quirks | Required env |
|---|---|---|---|
| `kiro` | `kiro-cli acp` | no `notifications/initialized`; `session/set_model`; auto-grants permissions | — |
| `codex` | `codex-acp` | sends `notifications/initialized`; `session/set_mode` full-access; `session/set_config_option`; **full-access** | `OPENAI_API_KEY` |

Point any Ollama-compatible tool at the ollama server, or any OpenAI SDK at the openai server, and requests are transparently routed to the selected ACP agent.

### Mix and match

```bash
node acp-server-ollama.js                  # Ollama + kiro   (defaults)
node acp-server-openai.js                  # OpenAI + codex  (defaults)
node acp-server-ollama.js --backend=codex  # Ollama surface over Codex (needs OPENAI_API_KEY)
node acp-server-openai.js --backend=kiro   # OpenAI surface over Kiro
```

`OPENAI_API_KEY` is a **backend** requirement: needed whenever `--backend=codex` (on either interface), not needed for `kiro`. Likewise the remote-binding safety gate **follows the backend** — it fires only when the full-access `codex` backend is selected on a non-localhost host without auth.

> **Note:** `acp-server-codex.js` was renamed to `acp-server-openai.js`. The old path still works as a thin deprecated shim (and `npm run codex` is a deprecated alias for `npm run openai`); both will be removed in a future release.

---

## acp-server-ollama.js — Ollama surface (Kiro backend by default)

> Add `--backend=codex` to drive Codex instead (requires `OPENAI_API_KEY`). Embeddings require the optional `fastembed` peer dep (`npm install fastembed`); without it the server still runs and the `/api/embed*` endpoints return 503.

### Prerequisites

- Node.js 18+
- Kiro CLI installed and authenticated (`kiro auth login`)
- On Windows: WSL2 with `KIRO_CMD=~/.local/bin/kiro-cli`

### Start

```bash
npm install
npm start                              # http://localhost:11434
AUTH_TOKEN=sk-mykey npm start          # with bearer auth
DEBUG=1 npm start                      # verbose JSON-RPC logging
```

### Env vars

| Var | Default | Notes |
|---|---|---|
| `PORT` | `11434` | |
| `HOST` | `0.0.0.0` | Safety gate applies only with `--backend=codex` |
| `KIRO_CMD` | `kiro-cli` | |
| `KIRO_ARGS` | `acp` | Space-split, no shell quoting |
| `POOL_SIZE` | `4` | Pre-warmed processes |
| `SESSION_TTL_MS` | `1800000` | 30-min stateful session TTL |
| `AUTH_TOKEN` | *(open)* | Comma-separated bearer tokens |
| `ALLOWED_IPS` | *(open)* | IP allowlist |
| `AUTO_SESSION_HASH` | `0` | `1` = derive session from system-prompt hash |
| `DEBUG` | `0` | |

### Usage

```bash
# Chat completion
curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}],"stream":false}'

# Streaming
curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}],"stream":true}'

# Health
curl http://localhost:11434/health
```

---

## acp-server-openai.js — OpenAI surface (Codex backend by default)

### Prerequisites

- Node.js 18+
- `OPENAI_API_KEY` set when using the codex backend (passed to the codex-acp child process)
- `codex-acp` binary available (`npm install @zed-industries/codex-acp`)

### Start

```bash
npm install
OPENAI_API_KEY=sk-... npm run openai             # http://127.0.0.1:3456
OPENAI_API_KEY=sk-... npm run openai:dev         # verbose
node acp-server-openai.js --backend=kiro         # OpenAI surface over Kiro (no OPENAI_API_KEY needed)
```

### Security defaults

- Binds to **127.0.0.1** (localhost only) by default.
- When the **codex** backend is selected, startup exits with code 1 if `HOST=0.0.0.0` and `ACP_API_KEY` is not set and `ALLOW_INSECURE_REMOTE` is not `1`. This is a hard safety gate — Codex runs in full-access mode. The gate does not apply to the `kiro` backend.

### Env vars

| Var | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | **required for `--backend=codex`** | Passed to child process; never logged. Not needed for `--backend=kiro` |
| `PORT` | `3456` | |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` only with auth (see above) |
| `ALLOW_INSECURE_REMOTE` | `0` | `1` = allow remote binding without auth |
| `CODEX_CMD` | `codex-acp` | Binary path |
| `CODEX_MODE` | `full-access` | Agent permission mode |
| `CODEX_MODEL_DEFAULT` | `gpt-5.5` | Default model |
| `CODEX_AVAILABLE_MODELS` | `gpt-5.5,gpt-5.4,gpt-5.4-mini` | CSV for `/v1/models` |
| `POOL_SIZE` | `4` | |
| `MAX_EXEC_MS` | `600000` | Prompt timeout → cancel + 504 |
| `ACP_API_KEY` | *(open on localhost)* | Comma-separated bearer tokens |
| `ALLOWED_IPS` | *(open)* | IP allowlist |
| `AUTO_SESSION_HASH` | `0` | |
| `DEBUG` | `0` | `1` = verbose stderr **+ monolithic log file** written to `logs/acp-codex-<timestamp>.log` |
| `LOG_DIR` | `./logs` | Override log directory (only used when `DEBUG=1`) |

### OpenAI compatibility

**Supported:** `model`, `messages`, `stream`, `tools`, `tool_choice`, `response_format: {type: "json_object"}`

**Accepted and ignored** (clients don't get 400): `temperature`, `max_tokens`, `top_p`, `seed`, `stop`, `n`, `logprobs`, `parallel_tool_calls`, `stream_options`, `reasoning_effort`, `user`, `service_tier`

**Not supported:** `response_format: {type: "json_schema"}`, `n > 1`, audio, `stream_options.include_usage`

### Usage

```bash
# Health (no auth required)
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}],"stream":true}'

# With bearer auth (when ACP_API_KEY is set)
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer sk-mykey" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

### Use with OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3456/v1", api_key="unused")
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

```javascript
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:3456/v1', apiKey: 'unused' });
const response = await client.chat.completions.create({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(response.choices[0].message.content);
```

### Stateful sessions (multi-turn)

Pass `X-Session-Id: <any-string>` to maintain conversation context across requests. Without the header, each request gets a fresh pool slot.

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: my-project-session" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Remember this: foo=42"}]}'
```

---

## Development

```bash
npm test          # regression + cross-backend suites (mock subprocess, no real key needed)
npm run check     # biome format + lint
```

The test suite covers the full 2×2 matrix (Ollama/OpenAI interface × kiro/codex backend) against `test/mock-acp.mjs`, plus auth enforcement, the backend-following safety gate, `--backend` selection, the deprecated shim, and a guard that keeps the duplicated `BACKENDS` block byte-identical across both server files.

## Changelog

- **Backend decoupling + rename.** The ACP backend is now selected with `--backend=kiro|codex` (defaults preserve prior behavior: ollama→kiro, openai→codex). `acp-server-codex.js` was renamed to **`acp-server-openai.js`** so the file name reflects the REST interface, not the backend.
  - Deprecated (removed next release): the old `acp-server-codex.js` path (now a forwarding shim) and the `npm run codex` / `codex:dev` script aliases. Use `acp-server-openai.js` / `npm run openai`.
  - `OPENAI_API_KEY` and the remote-binding safety gate now follow the **backend** (codex), not the file.
