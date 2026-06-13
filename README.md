# acp-to-api

Two HTTP shims that expose ACP agent backends through standard REST APIs.

| Server | API | Backend | Default port |
|---|---|---|---|
| `acp-server-ollama.js` | Ollama REST | Kiro (`kiro-cli acp`) | 11434 |
| `acp-server-codex.js` | OpenAI REST | Codex (`codex-acp`) | 3456 |

Point any Ollama-compatible tool at the ollama server, or any OpenAI SDK at the codex server, and requests are transparently routed to the underlying ACP agent.

---

## acp-server-ollama.js — Ollama surface (Kiro backend)

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
| `KIRO_CMD` | `kiro-cli` | |
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

## acp-server-codex.js — OpenAI surface (Codex backend)

### Prerequisites

- Node.js 18+
- `OPENAI_API_KEY` set (passed to the codex-acp child process)
- `codex-acp` binary available (`npm install @zed-industries/codex-acp`)

### Start

```bash
npm install
OPENAI_API_KEY=sk-... npm run codex             # http://127.0.0.1:3456
OPENAI_API_KEY=sk-... DEBUG=1 npm run codex:dev # verbose
```

### Security defaults

- Binds to **127.0.0.1** (localhost only) by default.
- Startup exits with code 1 if `HOST=0.0.0.0` and `ACP_API_KEY` is not set and `ALLOW_INSECURE_REMOTE` is not `1`. This is a hard safety gate — the server runs Codex in full-access mode.

### Env vars

| Var | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | **required** | Passed to child process; never logged |
| `PORT` | `3456` | |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` only with auth (see above) |
| `ALLOW_INSECURE_REMOTE` | `0` | `1` = allow remote binding without auth |
| `CODEX_CMD` | `codex-acp` | Binary path |
| `CODEX_MODE` | `full-access` | Agent permission mode |
| `CODEX_MODEL_DEFAULT` | `auto` | Default model |
| `CODEX_AVAILABLE_MODELS` | `auto,o4-mini,gpt-4o,o3,o3-mini` | CSV for `/v1/models` |
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
npm test          # regression suite (uses mock subprocess, no real API key needed)
npm run check     # biome format + lint
```
