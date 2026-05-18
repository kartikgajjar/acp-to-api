/**
 * Kiro API Bridge Server
 * ──────────────────────
 * Minimal OpenAI-compatible HTTP server over Kiro ACP.
 * One kiro-cli process per request — no pool, no sessions, no jobs, no embeddings.
 *
 * Run:   node kiro-api-bridge-server.js
 * Dev:   DEBUG=1 node kiro-api-bridge-server.js
 *
 * curl http://localhost:3456/v1/chat/completions \
 *   -H "Authorization: Bearer sk-local-dev-key" \
 *   -H "Content-Type: application/json" \
 *   -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import readline from 'readline';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT            = parseInt(process.env.PORT          ?? '3456');
const KIRO_CMD        = process.env.KIRO_CMD               ?? 'kiro-cli';
const KIRO_ARGS       = process.env.KIRO_ARGS              ?? 'acp';
const KIRO_CWD        = process.env.KIRO_CWD               ?? process.cwd();
const DEBUG           = process.env.DEBUG                  === '1';
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL ?? '60000');

const AUTH_TOKENS = (process.env.ACP_API_KEY ?? process.env.AUTH_TOKEN ?? '').split(',').map(t => t.trim()).filter(Boolean);
const ALLOWED_IPS = (process.env.ALLOWED_IPS ?? '').split(',').map(t => t.trim()).filter(Boolean);

// ─── Logging ──────────────────────────────────────────────────────────────────

function ts()                { return new Date().toISOString().replace(/(\.\d{3})Z$/, (_, ms) => ms + '000Z'); }
function log(tag, ...args)   { console.log(`${ts()} [${tag}]`, ...args); }
function dbg(tag, ...args)   { if (DEBUG) process.stderr.write(`${ts()} [${tag}] ${args.join(' ')}\n`); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId()         { return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`; }
function makeToolCallId() { return `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`; }
function makeReqId()      { return `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`; }
function nowSec()         { return Math.floor(Date.now() / 1000); }
function estimateTokens(text) { if (!text) return 0; return Math.ceil(String(text).length / 4); }

function apiError(res, status, message, type = 'invalid_request_error', param = null, code = null) {
  return res.status(status).json({ error: { message, type, param, code } });
}

// ─── ACPSession ───────────────────────────────────────────────────────────────

class ACPSession extends EventEmitter {
  constructor(label = 'req') {
    super();
    this.label      = label;
    this._proc      = null;
    this._rl        = null;
    this._msgId     = 0;
    this._pending   = new Map();
    this.sessionId  = null;
    this._pingTimer = null;
    this._dead      = false;
  }

  async start() {
    this._proc = spawn(KIRO_CMD, KIRO_ARGS.split(' '), {
      cwd:   KIRO_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      env:   process.env,
    });
    this._proc.stderr.on('data', (d) => dbg(`kiro:${this.label}`, String(d).trim()));
    this._proc.once('exit', (code) => {
      this._dead = true;
      this._stopPing();
      for (const [, { reject }] of this._pending) reject(new Error(`kiro-cli exited (${code})`));
      this._pending.clear();
    });
    this._rl = readline.createInterface({ input: this._proc.stdout });
    this._rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      try { this._route(JSON.parse(line)); } catch {}
    });
    await new Promise((res, rej) => {
      let done = false;
      const ok = () => { if (!done) { done = true; res(); } };
      this._proc.stdout.once('readable', ok);
      setTimeout(ok, 600);
      this._proc.once('exit', (c) => { if (!done) { done = true; rej(new Error(`died at startup (${c})`)); } });
    });
  }

  _send(msg) {
    if (this._dead) throw new Error('Cannot send to dead process');
    const line = JSON.stringify(msg) + '\n';
    if (msg.method !== 'ping') dbg(`→${this.label}`, line.length > 300 ? line.slice(0, 300) + '…' : line.trimEnd());
    this._proc.stdin.write(line);
  }

  _req(method, params = {}) {
    const id = ++this._msgId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  close() {
    this._dead = true;
    this._stopPing();
    try { this._proc?.stdin.end(); this._proc?.kill(); } catch {}
  }

  cancel() {
    if (!this.alive || !this.sessionId) return;
    try { this._send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } }); } catch {}
  }

  get alive() { return !this._dead && !!this._proc && !this._proc.killed; }

  _route(msg) {
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'session/request_permission') {
      this._send({ jsonrpc: '2.0', id: msg.id, result: { optionId: 'allow_always', granted: true } });
      return;
    }
    if (msg.method === 'session/update' || msg.method === 'session/notification' ||
        msg.method === '_kiro.dev/session/update') {
      const u    = msg.params?.update ?? msg.params ?? {};
      const type = u.sessionUpdate ?? u.type ?? '';
      switch (type) {
        case 'agent_message_chunk':
        case 'AgentMessageChunk': {
          const text = u.content?.text ?? u.content ?? u.text ?? '';
          if (text) this.emit('chunk', { kind: 'text', text });
          break;
        }
        case 'agent_thought_chunk':
        case 'AgentThoughtChunk': {
          const text = u.content?.text ?? u.content ?? u.text ?? '';
          if (text) this.emit('chunk', { kind: 'thought', text });
          break;
        }
        case 'tool_call':
        case 'tool_call_chunk':
          this.emit('chunk', { kind: 'tool_call_start', toolCallId: u.toolCallId ?? u.id ?? `tc_${Date.now()}`, name: u.name ?? u.title ?? 'unknown' });
          break;
        case 'tool_call_update':
          if (u.toolCallId ?? u.id) {
            this.emit('chunk', { kind: 'tool_call_update', toolCallId: u.toolCallId ?? u.id, output: u.output ?? u.content?.text ?? '' });
          }
          break;
        case 'plan': {
          const entries = (u.entries ?? []).map((e) => e.content ?? e).join('\n');
          if (entries) this.emit('chunk', { kind: 'plan', text: entries });
          break;
        }
      }
    }
  }

  async initialize() {
    await this._req('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'kiro-api-bridge', version: '1.0.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    this._startPing();
  }

  async newSession(cwd = KIRO_CWD) {
    const result = await this._req('session/new', { cwd, mcpServers: [] });
    this.sessionId       = result?.sessionId ?? result?.id;
    this.availableModels = result?.models?.availableModels?.map((m) => m.modelId) ?? [];
    this.currentModel    = result?.models?.currentModelId ?? 'auto';
    return this.sessionId;
  }

  async setModel(modelId) {
    if (!modelId || modelId === 'auto' || modelId === this.currentModel) return;
    try {
      await this._req('session/set_model', { sessionId: this.sessionId, modelId });
      this.currentModel = modelId;
    } catch (e) { log(`model`, `set_model failed (${e.message})`); }
  }

  async prompt(blocks, onChunk) {
    const chunks = [];
    const handler = (c) => { chunks.push(c); onChunk?.(c); };
    this.on('chunk', handler);
    try {
      await this._req('session/prompt', { sessionId: this.sessionId, prompt: blocks, content: blocks });
    } finally {
      this.off('chunk', handler);
    }
    return chunks;
  }

  _startPing() {
    this._pingTimer = setInterval(async () => {
      if (!this.alive) { this._stopPing(); return; }
      try {
        await Promise.race([
          this._req('ping', {}),
          new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 10_000)),
        ]);
      } catch (e) {
        if (e.message.includes('Method not found') || e.message.includes('-32601')) return;
        log('ping', `failed (${e.message})`);
        this.close();
      }
    }, PING_INTERVAL_MS);
    this._pingTimer.unref();
  }

  _stopPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }
}

// ─── Message conversion ───────────────────────────────────────────────────────

function buildAcpBlocks(messages, tools, opts = {}) {
  const { response_format, tool_choice } = opts;
  const system = messages.find((m) => m.role === 'system');
  const turns  = messages.filter((m) => m.role !== 'system');

  let text = '';
  if (system) text += `[System]\n${contentText(system.content)}\n\n`;

  if (response_format?.type === 'json_object') {
    text += `[Output format] Respond ONLY with a valid JSON object. No prose, no markdown fences.\n\n`;
  } else if (response_format?.type === 'json_schema') {
    text += `[Output format] Respond ONLY with a JSON object conforming to this schema:\n`;
    text += `\`\`\`json\n${JSON.stringify(response_format.json_schema?.schema ?? response_format.json_schema, null, 2)}\n\`\`\`\n\n`;
  }

  const effectiveTools = tool_choice === 'none' ? null : tools;
  if (effectiveTools?.length) {
    text += `[Available tools]\nEmit a tool_call ACP notification (not text) when invoking a tool.\n`;
    text += `\`\`\`json\n${JSON.stringify(effectiveTools.map((t) => t.function ?? t), null, 2)}\n\`\`\`\n`;
    if (tool_choice === 'required') {
      text += `[Tool requirement] You MUST call one of the tools above. Do not respond with plain text.\n`;
    } else if (typeof tool_choice === 'object' && tool_choice?.type === 'function') {
      text += `[Tool requirement] You MUST call the "${tool_choice.function.name}" tool.\n`;
    }
    text += '\n';
  } else if (tool_choice === 'none') {
    text += `[Tool restriction] Do not call any tools. Respond with text only.\n\n`;
  }

  for (const m of turns) {
    if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          const args = JSON.parse(tc.function.arguments || '{}');
          text += `[Assistant tool call: ${tc.function.name}]\n${JSON.stringify(args, null, 2)}\n\n`;
        }
      } else {
        text += `[Assistant]\n${contentText(m.content)}\n\n`;
      }
    } else if (m.role === 'tool') {
      text += `[Tool result: ${m.tool_call_id ?? 'result'}]\n${contentText(m.content)}\n\n`;
    } else {
      text += `[User]\n${contentText(m.content)}\n\n`;
    }
  }

  const blocks = [{ type: 'text', text: text.trimEnd() }];

  const lastUser = [...turns].reverse().find((m) => m.role === 'user');
  if (lastUser && Array.isArray(lastUser.content)) {
    for (const part of lastUser.content) {
      if (part.type === 'image_url') {
        const url = part.image_url?.url ?? '';
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) blocks.push({ type: 'image', mimeType: match[1], data: match[2] });
        else if (url.startsWith('file://')) blocks.push({ type: 'resource_link', uri: url, name: url.split('/').pop(), mimeType: 'image/*' });
      } else if (part.type === 'resource_link') {
        blocks.push(part);
      }
    }
  }

  return blocks;
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
  return String(c ?? '');
}

// ─── Response builders ────────────────────────────────────────────────────────

function chunksToResponse(chunks) {
  const textParts = [], thoughtParts = [];
  const toolCallMap = new Map();
  for (const c of chunks) {
    if (c.kind === 'text')    textParts.push(c.text);
    if (c.kind === 'thought') thoughtParts.push(c.text);
    if (c.kind === 'tool_call_start') toolCallMap.set(c.toolCallId, { id: makeToolCallId(), name: c.name, argsParts: [] });
    if (c.kind === 'tool_call_update' && c.toolCallId) {
      const tc = toolCallMap.get(c.toolCallId);
      if (tc && c.output) tc.argsParts.push(c.output);
    }
  }
  const content = textParts.join('') || null;
  const thought = thoughtParts.join('') || null;
  let tool_calls = null;
  if (toolCallMap.size > 0) {
    tool_calls = [...toolCallMap.values()].map((tc) => ({
      id: tc.id, type: 'function',
      function: {
        name: tc.name,
        arguments: tc.argsParts.length
          ? (() => { try { return JSON.stringify(JSON.parse(tc.argsParts.join(''))); } catch { return tc.argsParts.join(''); } })()
          : '{}',
      },
    }));
  }
  return { content, thought, tool_calls };
}

function buildUsage(promptBlocks, content, thought) {
  const promptText        = promptBlocks.map((b) => b.text ?? '').join('');
  const prompt_tokens     = estimateTokens(promptText);
  const completion_tokens = estimateTokens(content) + estimateTokens(thought);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

function nonStreamResponse(id, model, content, tool_calls, thought, usage) {
  const message = { role: 'assistant' };
  if (tool_calls) { message.content = null; message.tool_calls = tool_calls; }
  else { message.content = content; if (thought) message.reasoning_content = thought; }
  return {
    id, object: 'chat.completion', created: nowSec(), model,
    choices: [{ index: 0, message, finish_reason: tool_calls ? 'tool_calls' : 'stop', logprobs: null }],
    usage,
  };
}

function sseChunk(id, model, delta, finish = null) {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: nowSec(), model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  })}\n\n`;
}

function sseUsageChunk(id, model, usage) {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: nowSec(), model,
    choices: [], usage,
  })}\n\n`;
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
}));

app.use(express.json({ limit: '8mb' }));

// Request ID middleware
app.use((req, res, next) => {
  const rid = req.headers['x-request-id'] || makeReqId();
  req.id = rid;
  res.setHeader('X-Request-Id', rid);
  next();
});

// Auth + IP allowlist — /health is unauthenticated
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/') return next();

  if (ALLOWED_IPS.length > 0) {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '').replace('::ffff:', '');
    if (!ALLOWED_IPS.includes(ip)) return apiError(res, 403, `IP ${ip} not in allowlist`, 'forbidden', null, 'ip_not_allowed');
  }

  if (AUTH_TOKENS.length > 0) {
    const m = (req.headers['authorization'] ?? '').match(/^Bearer\s+(.+)$/i);
    if (!m || !AUTH_TOKENS.includes(m[1])) return apiError(res, 401, 'Invalid or missing API key', 'authentication_error', null, 'invalid_api_key');
  }

  next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), kiro: KIRO_CMD, capabilities: ['chat'] });
});
app.get('/', (_, res) => res.redirect('/health'));

// ── Models ────────────────────────────────────────────────────────────────────
app.get('/v1/models', async (_, res) => {
  const session = new ACPSession('models');
  try {
    await session.start();
    await session.initialize();
    const result = await session._req('session/new', { cwd: KIRO_CWD, mcpServers: [] });
    const models = result?.models?.availableModels ?? [];
    const mapped = models.map((m) => ({ id: m.modelId, object: 'model', created: 0, owned_by: 'kiro', description: m.description }));
    const hasAuto = mapped.some((m) => m.id === 'auto');
    const data = hasAuto ? mapped : [
      { id: 'auto', object: 'model', created: 0, owned_by: 'kiro', description: 'Kiro default model selection' },
      ...mapped,
    ];
    res.json({ object: 'list', data });
  } catch (err) { apiError(res, 500, err.message, 'server_error'); }
  finally { session.close(); }
});

app.get('/v1/models/:id', async (req, res) => {
  const session = new ACPSession('models');
  try {
    await session.start();
    await session.initialize();
    const result = await session._req('session/new', { cwd: KIRO_CWD, mcpServers: [] });
    const m = (result?.models?.availableModels ?? []).find((x) => x.modelId === req.params.id);
    if (!m) return apiError(res, 404, `Model '${req.params.id}' not found`, 'invalid_request_error', 'model', 'model_not_found');
    res.json({ id: m.modelId, object: 'model', created: 0, owned_by: 'kiro', description: m.description });
  } catch (err) { apiError(res, 500, err.message, 'server_error'); }
  finally { session.close(); }
});

// ── Chat completions ──────────────────────────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  const {
    messages        = [],
    model           = 'auto',
    stream          = false,
    tools,
    tool_choice     = 'auto',
    response_format,
    stream_options  = {},
    // accepted-and-ignored: temperature, top_p, n, max_tokens, stop,
    // presence_penalty, frequency_penalty, logit_bias, user, seed, parallel_tool_calls
  } = req.body ?? {};

  if (!Array.isArray(messages) || !messages.length) {
    return apiError(res, 400, '`messages` is required and must be a non-empty array', 'invalid_request_error', 'messages');
  }

  const id     = makeId();
  const blocks = buildAcpBlocks(messages, tools, { response_format, tool_choice });

  const session = new ACPSession(id.slice(-8));
  try {
    await session.start();
    await session.initialize();
    await session.newSession(KIRO_CWD);
    await session.setModel(model);
    await handleCompletion(req, res, { session, model, id, stream, blocks, stream_options });
  } catch (err) {
    log('error', err.message);
    if (!res.headersSent) apiError(res, 500, err.message, 'server_error');
  } finally {
    session.close();
  }
});

async function handleCompletion(req, res, { session, model, id, stream, blocks, stream_options }) {
  const includeUsage = stream_options?.include_usage === true;

  if (stream) {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(sseChunk(id, model, { role: 'assistant' }));

    const allChunks = [];
    await session.prompt(blocks, (chunk) => {
      allChunks.push(chunk);
      if (!res.writable) return;
      if (chunk.kind === 'text')    res.write(sseChunk(id, model, { content: chunk.text }));
      if (chunk.kind === 'thought') res.write(sseChunk(id, model, { reasoning_content: chunk.text }));
    });

    const { content, thought, tool_calls } = chunksToResponse(allChunks);

    if (tool_calls) {
      tool_calls.forEach((tc, idx) => {
        res.write(sseChunk(id, model, { tool_calls: [{ index: idx, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] }));
      });
      res.write(sseChunk(id, model, {}, 'tool_calls'));
    } else {
      res.write(sseChunk(id, model, {}, 'stop'));
    }

    if (includeUsage) {
      res.write(sseUsageChunk(id, model, buildUsage(blocks, content, thought)));
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    const chunks = await session.prompt(blocks);
    const { content, thought, tool_calls } = chunksToResponse(chunks);
    const usage = buildUsage(blocks, content, thought);
    res.json(nonStreamResponse(id, model, content, tool_calls, thought, usage));
  }
}

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log('uncaught', err.message);
  if (!res.headersSent) apiError(res, 500, err.message, 'server_error');
});

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  const tokenDisplay = AUTH_TOKENS.length
    ? AUTH_TOKENS.join(', ')
    : 'OPEN (no ACP_API_KEY set)';
  console.log(`┌──────────────────────────────────────────────────────────────┐
│  Kiro ACP Bridge  —  http://localhost:${PORT}
│  Auth:  ${tokenDisplay}
│  IP ACL: ${ALLOWED_IPS.length ? ALLOWED_IPS.join(', ') : 'open'}
│  Mode:  ${DEBUG ? 'DEBUG' : 'production'}  |  Kiro: ${KIRO_CMD} ${KIRO_ARGS}
│  CWD:   ${KIRO_CWD}
└──────────────────────────────────────────────────────────────┘`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[start] Port ${PORT} already in use`);
  } else {
    console.error('[start] Server error:', err.message);
  }
  process.exit(1);
});
