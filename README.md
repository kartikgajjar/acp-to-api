# acp-openai-proxy

Exposes [Kiro](https://kiro.dev) ACP agents through an OpenAI-compatible REST API.
Point any OpenAI SDK or tool at this server and it talks to Kiro transparently.

## Prerequisites

- Windows 11 with WSL2 (Ubuntu recommended)
- Node.js 18+ inside WSL
- Kiro installed in WSL — binary at `~/.local/bin/kiro-cli` (default install location)
- Authenticated: `kiro auth login`

## Quick start

```bash
npm install
npm start           # minimal — 1 kiro-cli process per request
npm run full        # full — sessions, jobs, POOL_SIZE=1
npm run full_pool   # full — same, with POOL_SIZE=4 pre-warmed workers
npm run dev         # minimal + DEBUG=1 verbose logging
```

Server listens on **http://localhost:3456** by default.

## Servers

| Script | File | Pool | Sessions | Jobs |
|---|---|---|---|---|
| `npm start` | `kiro-api-bridge-server.js` | — | — | — |
| `npm run full` | `kiro-api-bridge-server-full.js` | 1 | ✓ | ✓ |
| `npm run full_pool` | `kiro-api-bridge-server-full.js` | 4 | ✓ | ✓ |

## Chat client

```bash
node kiro-openai-chat-client.mjs                          # interactive REPL
node kiro-openai-chat-client.mjs --once "Hello"           # single shot
node kiro-openai-chat-client.mjs --model claude-sonnet-4-5
node kiro-openai-chat-client.mjs --system "You are a Rust expert"
```

REPL commands: `/model`, `/system <text>`, `/clear`, `/history`, `/exit`

## Configuration

All variables are optional — the server works with no `.env` at all.

```bash
cp .env.example .env   # then edit as needed
```

| Variable | Default | Notes |
|---|---|---|
| `ACP_API_KEY` | *(none — open)* | Bearer token(s), comma-separated. Leave unset for localhost dev. |
| `PORT` | `3456` | |
| `KIRO_CMD` | `kiro-cli` | Path to kiro-cli — on WSL: `~/.local/bin/kiro-cli` |
| `KIRO_ARGS` | `acp` | |
| `KIRO_CWD` | cwd at launch | Working directory for Kiro processes |
| `POOL_SIZE` | `4` | Workers pre-warmed (full server only) |
| `DEBUG` | `0` | Set to `1` for verbose JSON-RPC logging |

## API

```bash
# Health — no auth required, includes capability list
curl http://localhost:3456/health
# → {"status":"ok","capabilities":["chat"],...}
# → {"status":"ok","capabilities":["chat","sessions","background_jobs"],...}  (full server)

# List models
curl http://localhost:3456/v1/models \
  -H "Authorization: Bearer sk-local-dev-key"

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer sk-local-dev-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer sk-local-dev-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

### Use with OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="sk-local-dev-key",   # matches ACP_API_KEY in .env
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3456/v1',
  apiKey: 'sk-local-dev-key',
});

const response = await client.chat.completions.create({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(response.choices[0].message.content);
```
