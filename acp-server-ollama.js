/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ⚠️  DEPRECATED — DO NOT USE  ⚠️                                   ║
 * ║  Replaced by acp-server-ollama.js (unified Windows+POSIX build    ║
 * ║  with session persistence, delta sends, and tool-call fixes).    ║
 * ║  This file is kept for reference only and is NOT maintained.     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Ollama-Compatible HTTP Server over Kiro ACP
 * ─────────────────────────────────────────────
 * Drop-in replacement for the Ollama daemon. Any tool that talks to Ollama
 * (LangChain, Continue.dev, Open WebUI, llama-index, …) can point at this
 * server and transparently route to Kiro ACP agents.
 *
 * Implements the full Ollama REST API:
 *   POST /api/chat           multi-turn chat (streaming NDJSON or JSON)
 *   POST /api/generate       single-turn raw generation
 *   GET  /api/tags           list available models
 *   POST /api/show           model metadata
 *   GET  /api/ps             running models
 *   POST /api/embed          embeddings (new API)
 *   POST /api/embeddings     embeddings (legacy API)
 *   GET  /api/version        version string
 *   POST /api/pull           stub (no-op)
 *   POST /api/push           stub (no-op)
 *   DELETE /api/delete       stub (no-op)
 *   POST /api/copy           stub (no-op)
 *   POST /api/create         stub (no-op)
 *   GET  /health             pool / registry / embedding stats
 *   GET  /health/agents      per-slot details
 *   DELETE /v1/sessions/:id  tear down a stateful session
 *
 * Install:  npm install express cors fastembed dotenv
 * Run:      AUTH_TOKEN=sk-mykey node acp-ollama-server.js
 *
 * Standard call:
 *   curl http://localhost:11434/api/chat \
 *     -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
 */

console.error('╔════════════════════════════════════════════════════════════╗');
console.error('║  DEPRECATED: acp-ollama-server.js is no longer maintained.  ║');
console.error('║  Use acp-server-ollama.js instead.                          ║');
console.error('╚════════════════════════════════════════════════════════════╝');

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import readline from 'readline';
import { EventEmitter } from 'events';
import { randomUUID, createHash } from 'crypto';
import path from 'path';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT             = parseInt(process.env.PORT             ?? '11434');
const KIRO_CMD         = process.env.KIRO_CMD                  ?? 'kiro-cli';
const KIRO_ARGS        = process.env.KIRO_ARGS                 ?? 'acp';
const KIRO_CWD         = process.env.KIRO_CWD                  ?? process.cwd();
const DEBUG            = process.env.DEBUG                     === '1';

const POOL_SIZE        = parseInt(process.env.POOL_SIZE        ?? '4');
const SESSION_TTL_MS   = parseInt(process.env.SESSION_TTL_MS   ?? String(30 * 60 * 1000));
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL    ?? '60000');
const MAX_EXEC_MS      = parseInt(process.env.MAX_EXEC_MS      ?? String(10 * 60 * 1000));

const AUTH_TOKENS = (process.env.AUTH_TOKEN ?? '').split(',').map(t => t.trim()).filter(Boolean);
const ALLOWED_IPS = (process.env.ALLOWED_IPS ?? '').split(',').map(t => t.trim()).filter(Boolean);

// When AUTO_SESSION_HASH=1, requests without x-session-id are routed to a persistent session
// derived from the system-prompt hash. This preserves conversation context across turns for
// callers (e.g. LangFlow) that don't send x-session-id themselves.
const AUTO_SESSION_HASH = process.env.AUTO_SESSION_HASH === '1';

const EMBEDDING_MODEL_DEFAULT  = process.env.EMBEDDING_MODEL_DEFAULT  ?? 'BGESmallENV15';
const EMBEDDING_MODELS_ENABLED = (process.env.EMBEDDING_MODELS_ENABLED ?? EMBEDDING_MODEL_DEFAULT)
                                   .split(',').map(t => t.trim()).filter(Boolean);
const EMBEDDING_CACHE_DIR      = process.env.EMBEDDING_CACHE_DIR      ?? undefined;
const EMBEDDING_BATCH_SIZE     = parseInt(process.env.EMBEDDING_BATCH_SIZE ?? '32');
const EMBEDDING_MAX_INPUTS     = parseInt(process.env.EMBEDDING_MAX_INPUTS ?? '2048');

// ─── Logging ──────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString().replace(/(\.\d{3})Z$/, (_, ms) => ms + '000Z'); }
function log(tag, ...args) { console.log(`${ts()} [${tag}]`, ...args); }
function dbg(tag, ...args) { if (DEBUG) process.stderr.write(`${ts()} [${tag}] ${args.join(' ')}\n`); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId()         { return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`; }
function makeToolCallId() { return `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`; }
function makeReqId()      { return `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`; }
function nowSec()         { return Math.floor(Date.now() / 1000); }

// Derive a stable session ID from the system message content.
// Same system prompt → same session, so conversation context survives across turns.
function autoSessionId(messages) {
  const sys = messages?.find?.(m => m.role === 'system');
  const key = sys ? contentText(sys.content) : '__no_system__';
  return 'auto:' + createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function pickCwd(blocks, fallback) {
  const dirs = blocks
    .filter((b) => b.type === 'resource_link' && typeof b.uri === 'string')
    .map((b) => b.uri.replace(/^file:\/\//, ''))
    .map((p) => path.posix.dirname(p));
  if (!dirs.length) return fallback;
  if (dirs.length === 1) return dirs[0];
  const split = dirs.map((d) => d.split('/'));
  const common = [];
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i];
    if (split.every((s) => s[i] === seg)) common.push(seg); else break;
  }
  return common.join('/') || fallback;
}

function ollamaError(res, status, message) {
  return res.status(status).json({ error: message });
}

function inferMimeType(b64) {
  const head = b64.slice(0, 8);
  if (head.startsWith('/9j/'))      return 'image/jpeg';
  if (head.startsWith('iVBORw0K')) return 'image/png';
  if (head.startsWith('R0lGOD'))   return 'image/gif';
  if (head.startsWith('UklGR'))    return 'image/webp';
  return 'image/jpeg';
}

// ─── ACPSession ───────────────────────────────────────────────────────────────

class ACPSession extends EventEmitter {
  constructor(label = 'anon') {
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
      cwd: KIRO_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this._proc.stderr.on('data', (d) => dbg(`kiro:${this.label}`, String(d).trim()));
    this._proc.once('exit', (code) => {
      this._dead = true;
      this._stopPing();
      log(`proc:${this.label}`, `exited (${code}), failing ${this._pending.size} pending`);
      for (const [, { reject }] of this._pending) reject(new Error(`kiro-cli exited (${code})`));
      this._pending.clear();
      this.emit('dead');
    });
    this._rl = readline.createInterface({ input: this._proc.stdout });
    this._rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      try {
        const msg = JSON.parse(line);
        this._dbgLine(msg);
        this._route(msg);
      } catch (e) { dbg('parse', e.message); }
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
    if (msg.method !== 'ping')
      dbg(`→${this.label}`, line.length > 300 ? line.slice(0, 300) + '…' : line.trimEnd());
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
    try {
      this._send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    } catch {}
  }

  get alive() { return !this._dead && this._proc && !this._proc.killed; }

  _dbgLine(msg) {
    if (!DEBUG) return;
    const m = msg.method;
    if (m === 'session/update' || m === 'session/notification' || m === '_kiro.dev/session/update') return;
    if (m === '_kiro.dev/commands/available') {
      const p = msg.params ?? {};
      dbg(`←${this.label}`, `commands/available  commands=${p.commands?.length ?? 0}  tools=${p.tools?.length ?? 0}  mcp=${p.mcpServers?.length ?? 0}`);
      return;
    }
    if (m === '_kiro.dev/subagent/list_update') return;
    if (!m && msg.error?.data === 'ping') return;
    const raw = JSON.stringify(msg);
    dbg(`←${this.label}`, raw.length > 300 ? raw.slice(0, 300) + '…' : raw);
  }

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
          this.emit('chunk', { kind: 'thought', text: `[tool: ${u.title ?? u.name ?? 'unknown'}]\n` });
          break;
        case 'tool_call_update':
          if (u.output ?? u.content?.text) {
            this.emit('chunk', { kind: 'thought', text: u.output ?? u.content?.text });
          }
          break;
        case 'plan': {
          const entries = (u.entries ?? []).map((e) => e.content ?? e).join('\n');
          if (entries) this.emit('chunk', { kind: 'plan', text: entries });
          break;
        }
        default: dbg(`update:${this.label}`, `unhandled "${type}"`);
      }
    }
  }

  async initialize() {
    const result = await this._req('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'acp-ollama-proxy', version: '1.0.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    const caps = result?.agentCapabilities?.promptCapabilities ?? {};
    this.promptCapabilities = caps;
    dbg(`init:${this.label}`, `promptCapabilities=${JSON.stringify(caps)}`);
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
    } catch (e) { log(`model:${this.label}`, `set_model failed (${e.message})`); }
  }

  async prompt(blocks, onChunk) {
    const chunks = [];
    let textLen = 0;
    const handler = (c) => {
      chunks.push(c);
      if (c.kind === 'text') textLen += c.text.length;
      onChunk?.(c);
    };
    this.on('chunk', handler);
    dbg(`prompt:${this.label}`, `streaming…`);
    try {
      await this._req('session/prompt', {
        sessionId: this.sessionId,
        prompt:    blocks,
        content:   blocks,
      });
    } finally {
      this.off('chunk', handler);
    }
    dbg(`prompt:${this.label}`, `done  chunks=${chunks.length}  textChars=${textLen}`);
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
        log(`ping:${this.label}`, `failed (${e.message})`);
        this.close();
      }
    }, PING_INTERVAL_MS);
    this._pingTimer.unref();
  }

  _stopPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }
}

// ─── Pool & Registry ──────────────────────────────────────────────────────────

class ACPPool {
  constructor(size) {
    this._size  = size;
    this._slots = [];
    this._queue = [];
  }
  async warmup() {
    log('pool', `warming ${this._size} kiro-cli processes…`);
    this._slots = Array.from({ length: this._size }, () => ({ client: null, busy: false }));
    await Promise.all(this._slots.map((s) => this._initSlot(s)));
    log('pool', `ready (${this._slots.filter((s) => s.client?.alive).length}/${this._size} live)`);
  }
  async _initSlot(slot) {
    try {
      const c = new ACPSession(`pool-${this._slots.indexOf(slot)}`);
      await c.start(); await c.initialize();
      c.once('dead', () => { slot.client = null; });
      slot.client = c;
    } catch (e) { log('pool', `slot init failed: ${e.message}`); slot.client = null; }
  }
  async acquire() {
    const free = this._slots.find((s) => !s.busy);
    if (free) { free.busy = true; if (!free.client?.alive) await this._initSlot(free); return free; }
    return new Promise((resolve) => this._queue.push(resolve));
  }
  release(slot) {
    slot.busy = false;
    const next = this._queue.shift();
    if (next) {
      slot.busy = true;
      if (!slot.client?.alive) this._initSlot(slot).then(() => next(slot));
      else next(slot);
    }
  }
  shutdown() { this._slots.forEach((s) => s.client?.close()); }
  get stats() {
    return {
      size:   this._size,
      busy:   this._slots.filter((s) => s.busy).length,
      alive:  this._slots.filter((s) => s.client?.alive).length,
      queued: this._queue.length,
    };
  }
}

class SessionRegistry {
  constructor() {
    this._map   = new Map();
    this._timer = setInterval(() => this._reap(), 60_000);
    this._timer.unref();
  }
  async acquire(sessionId, cwd) {
    let entry = this._map.get(sessionId);
    if (entry && !entry.client.alive) {
      entry.client.close();
      this._map.delete(sessionId);
      entry = null;
    }
    if (!entry) {
      const c = new ACPSession(`reg-${sessionId.slice(0, 8)}`);
      await c.start(); await c.initialize(); await c.newSession(cwd);
      entry = { client: c, lastUsed: Date.now() };
      this._map.set(sessionId, entry);
    } else {
      entry.lastUsed = Date.now();
    }
    return entry.client;
  }
  delete(sessionId) {
    const entry = this._map.get(sessionId);
    if (entry) { entry.client.close(); this._map.delete(sessionId); }
  }
  _reap() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, entry] of this._map) {
      if (entry.lastUsed < cutoff) { log('registry', `TTL reap ${id}`); entry.client.close(); this._map.delete(id); }
    }
  }
  get stats() { return { sessions: this._map.size }; }
}

// ─── EmbeddingRegistry ────────────────────────────────────────────────────────

const EMBEDDING_MODEL_MAP = {
  BGESmallENV15: EmbeddingModel.BGESmallENV15,
  BGEBaseENV15:  EmbeddingModel.BGEBaseENV15,
  BGESmallEN:    EmbeddingModel.BGESmallEN,
  BGEBaseEN:     EmbeddingModel.BGEBaseEN,
  BGESmallZH:    EmbeddingModel.BGESmallZH,
  AllMiniLML6V2: EmbeddingModel.AllMiniLML6V2,
  MLE5Large:     EmbeddingModel.MLE5Large,
};

class ModelNotEnabledError extends Error {}

class EmbeddingRegistry {
  constructor() { this._cache = new Map(); }

  async init() {
    const t0 = Date.now();
    await this.getModel(EMBEDDING_MODEL_DEFAULT);
    log('embeddings', `default model ${EMBEDDING_MODEL_DEFAULT} loaded in ${Date.now() - t0}ms`);
  }

  async getModel(name) {
    if (!EMBEDDING_MODELS_ENABLED.includes(name)) throw new ModelNotEnabledError(name);
    if (this._cache.has(name)) return this._cache.get(name);
    const enumVal = EMBEDDING_MODEL_MAP[name];
    if (!enumVal) throw new ModelNotEnabledError(name);
    dbg('embeddings', `loading model ${name}`);
    const opts = { model: enumVal };
    if (EMBEDDING_CACHE_DIR) opts.cacheDir = EMBEDDING_CACHE_DIR;
    const model = await FlagEmbedding.init(opts);
    this._cache.set(name, model);
    return model;
  }

  get stats() {
    return { loaded: [...this._cache.keys()], available: EMBEDDING_MODELS_ENABLED };
  }
}

// ─── Globals ──────────────────────────────────────────────────────────────────

const pool     = new ACPPool(POOL_SIZE);
const registry = new SessionRegistry();

await pool.warmup();

const embeddings = new EmbeddingRegistry();
await embeddings.init();

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => { log('shutdown', sig); pool.shutdown(); process.exit(0); });
});

// ─── Message conversion ───────────────────────────────────────────────────────

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
  return String(c ?? '');
}

/**
 * Build ACP prompt blocks from an Ollama-format messages array.
 *
 * Differences from OpenAI buildAcpBlocks():
 *  - images: [b64, ...] lives on each message object, not in content parts
 *  - tool_calls[].function.arguments is a plain object (not a JSON string)
 *  - format: 'json' | <schema> maps to output-format injection
 *  - think: truthy → prepend reasoning instruction
 *  - No tool_choice: always treat as 'auto'
 */
function buildAcpBlocksFromOllama(messages, tools, opts = {}) {
  const { format, think } = opts;
  const system = messages.find((m) => m.role === 'system');
  const turns  = messages.filter((m) => m.role !== 'system');

  let text = '';

  if (system) text += `[System]\n${contentText(system.content)}\n\n`;

  // Reasoning injection
  if (think) {
    text += `[Reasoning] Think through the problem step by step before answering. Show your reasoning.\n\n`;
  }

  // Output-format injection
  if (format === 'json') {
    text += `[Output format] Respond ONLY with a valid JSON object. No prose, no markdown fences.\n\n`;
  } else if (format && typeof format === 'object') {
    text += `[Output format] Respond ONLY with a JSON object conforming to this schema:\n`;
    text += `\`\`\`json\n${JSON.stringify(format, null, 2)}\n\`\`\`\n\n`;
  }

  // Tool injection
  if (tools?.length) {
    text += `[Available tools]\n`;
    text += `To call a tool output ONLY this JSON block — no prose, no explanation, nothing else:\n`;
    text += `\`\`\`json\n{"tool_call": {"name": "<tool_name>", "arguments": {"<param>": "<value>"}}}\n\`\`\`\n`;
    text += `Rules: (1) ONE tool call per response. (2) No text before or after the JSON block. `;
    text += `(3) Do NOT use \`\`\`tool_call\`\`\` fences or Python function-call syntax.\n`;
    text += `Available tools:\n`;
    text += `\`\`\`json\n${JSON.stringify(tools.map((t) => t.function ?? t), null, 2)}\n\`\`\`\n\n`;
  }

  // Conversation history
  const imageBlocks = [];
  for (const m of turns) {
    if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          text += `[Assistant tool call: ${tc.function.name}]\n${JSON.stringify(tc.function.arguments ?? {}, null, 2)}\n\n`;
        }
      } else {
        text += `[Assistant]\n${contentText(m.content)}\n\n`;
      }
    } else if (m.role === 'tool') {
      const callId = m.tool_call_id ? ` (id: ${m.tool_call_id})` : '';
      text += `[Tool result${callId}]\n${contentText(m.content)}\n\n`;
    } else {
      // user (or unknown)
      text += `[User]\n${contentText(m.content)}\n\n`;
    }
    // Collect inline images from this message
    if (Array.isArray(m.images)) {
      for (const b64 of m.images) {
        const mimeType = inferMimeType(b64);
        imageBlocks.push({ type: 'image', mimeType, data: b64 });
      }
    }
  }

  const blocks = [{ type: 'text', text: text.trimEnd() }, ...imageBlocks];
  return blocks;
}

/**
 * Build ACP blocks from a single-turn generate request.
 */
function buildAcpBlocksFromGenerate(prompt, system, images, opts = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt ?? '', images: images ?? [] });
  return buildAcpBlocksFromOllama(messages, null, opts);
}

// ─── Response builders ────────────────────────────────────────────────────────

/**
 * Reassemble ACP streaming chunks into an Ollama message object.
 * Unlike OpenAI, Ollama tool_calls[].function.arguments is a plain object (not JSON string).
 */
function chunksToOllamaMessage(chunks, wantThinking) {
  const textParts = [], thoughtParts = [];
  const toolCallMap = new Map();

  for (const c of chunks) {
    if (c.kind === 'text')    textParts.push(c.text);
    if (c.kind === 'thought') thoughtParts.push(c.text);
    if (c.kind === 'tool_call_start') {
      toolCallMap.set(c.toolCallId, { id: makeToolCallId(), name: c.name, argsParts: [] });
    }
    if (c.kind === 'tool_call_update' && c.toolCallId) {
      const tc = toolCallMap.get(c.toolCallId);
      if (tc && c.output) tc.argsParts.push(c.output);
    }
  }

  const content = textParts.join('') || '';
  const thought = thoughtParts.join('') || null;

  let tool_calls = null;
  if (toolCallMap.size > 0) {
    tool_calls = [...toolCallMap.values()].map((tc) => {
      let args = {};
      if (tc.argsParts.length) {
        try { args = JSON.parse(tc.argsParts.join('')); } catch { args = {}; }
      }
      return { function: { name: tc.name, arguments: args } };
    });
  }

  return {
    role: 'assistant',
    content,
    ...(wantThinking && thought ? { thinking: thought } : {}),
    ...(tool_calls ? { tool_calls } : {}),
  };
}

/**
 * Build Ollama timing stats. startNs is process.hrtime.bigint() captured before the prompt.
 */
function makeStats(startNs, promptBlocks, content) {
  const totalNs   = Number(process.hrtime.bigint() - startNs);
  const promptTxt = promptBlocks.map((b) => b.text ?? '').join('');
  return {
    total_duration:       totalNs,
    load_duration:        0,
    prompt_eval_count:    estimateTokens(promptTxt),
    prompt_eval_duration: Math.floor(totalNs * 0.15),
    eval_count:           estimateTokens(content ?? ''),
    eval_duration:        Math.floor(totalNs * 0.85),
  };
}

// ─── NDJSON streaming helpers ─────────────────────────────────────────────────

function ndjsonLine(obj) { return JSON.stringify(obj) + '\n'; }

function tryParseJson(str) {
  try { return JSON.parse(str.trim()); } catch { return null; }
}

function pickBestTool(obj, tools) {
  if (tools.length === 1) return tools[0];
  const objKeys = new Set(Object.keys(obj));
  let best = tools[0], bestScore = 0;
  for (const t of tools) {
    const props = Object.keys(t?.function?.parameters?.properties ?? {});
    const score = props.filter(k => objKeys.has(k)).length;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

// Parse keyword arguments from a Python-style function call string like:
//   key="value", count=3, flag=true
// Returns a plain object. Handles double-quoted strings with escape sequences.
function parsePyFnCallArgs(argsStr, toolDef) {
  const args = {};
  const kwRe = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/g;
  let m;
  while ((m = kwRe.exec(argsStr)) !== null) {
    const [, key, raw] = m;
    if      (raw === 'true')       args[key] = true;
    else if (raw === 'false')      args[key] = false;
    else if (raw === 'null')       args[key] = null;
    else if (raw.startsWith('"')) { try { args[key] = JSON.parse(raw); } catch { args[key] = raw.slice(1, -1); } }
    else                           args[key] = parseFloat(raw);
  }
  // Fallback: single positional double-quoted string → first schema param
  if (!Object.keys(args).length) {
    const pos = argsStr.trim().match(/^"((?:[^"\\]|\\.)*)"$/s);
    if (pos) {
      const firstKey = Object.keys(toolDef?.function?.parameters?.properties ?? {})[0];
      if (firstKey) { try { args[firstKey] = JSON.parse(`"${pos[1]}"`); } catch { args[firstKey] = pos[1]; } }
    }
  }
  return args;
}

function coerceToolCall(message, tools) {
  if (!tools?.length || message.tool_calls) return message;
  const content = message.content?.trim();
  if (!content) return message;

  let parsed = tryParseJson(content);

  if (!parsed) {
    const m = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (m) parsed = tryParseJson(m[1]);
  }

  // Handle {"tool_call": {"name": ..., "arguments": ...}} wrapper
  if (parsed?.tool_call?.name) {
    const tc = parsed.tool_call;
    dbg('coerce', `tool_call wrapper → "${tc.name}"`);
    return { ...message, content: '', tool_calls: [{ function: { name: tc.name, arguments: tc.arguments ?? {} } }] };
  }

  // Detect ```tool_call\nfn_name(key="val", ...)\n``` fence (Claude's native function-call format).
  // Only take the FIRST fence — the protocol expects one tool call per response.
  if (!parsed) {
    const tcFence = content.match(/```tool_call\s*\n(\w+)\(([\s\S]*?)\)\s*\n```/);
    if (tcFence) {
      const name = tcFence[1];
      const tool = tools.find(t => (t.function?.name ?? t.name) === name);
      if (tool) {
        const arguments_ = parsePyFnCallArgs(tcFence[2], tool);
        dbg('coerce', `tool_call fence → "${name}"`);
        return { ...message, content: '', tool_calls: [{ function: { name, arguments: arguments_ } }] };
      }
    }
  }

  // Catch natural language "Tool call: <name>\n\n<key>: <value>" pattern
  if (!parsed) {
    const nlMatch = content.match(/Tool call:\s*(\w+)\s*\n([\s\S]*)/i);
    if (nlMatch) {
      const name = nlMatch[1];
      const argsText = nlMatch[2].trim();
      const args = {};
      for (const line of argsText.split('\n')) {
        const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
        if (kv) args[kv[1]] = isNaN(kv[2]) ? kv[2].trim() : Number(kv[2]);
      }
      const tool = tools.find(t => (t.function?.name ?? t.name) === name);
      if (tool) {
        dbg('coerce', `natural language → tool_call "${name}"`);
        return { ...message, content: '', tool_calls: [{ function: { name, arguments: args } }] };
      }
    }
  }

  if (!parsed) return message;

  const tool = pickBestTool(parsed, tools);
  const name = tool?.function?.name ?? tool?.name;
  if (!name) return message;
  dbg('coerce', `plain JSON → tool_call "${name}"`);
  return { ...message, content: '', tool_calls: [{ function: { name, arguments: parsed } }] };
}

function setNdjsonHeaders(res) {
  res.setHeader('Content-Type',      'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Session-Id', 'X-Working-Dir', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
}));

app.use(express.json({ limit: '8mb' }));

app.use((req, res, next) => {
  const rid = req.headers['x-request-id'] || makeReqId();
  req.id = rid;
  res.setHeader('X-Request-Id', rid);
  next();
});

if (DEBUG) {
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const model = req.body?.model ?? '-';
      log('req', `${req.method} ${req.path}  model=${model}  ${res.statusCode}  ${Date.now() - t0}ms`);
    });
    next();
  });
}

// Auth + IP allowlist — exempt root, version, and health
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/api/version' || req.path === '/health') return next();

  if (ALLOWED_IPS.length > 0) {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '').replace('::ffff:', '');
    if (!ALLOWED_IPS.includes(ip)) return ollamaError(res, 403, `IP ${ip} not in allowlist`);
  }

  if (AUTH_TOKENS.length > 0) {
    const hdr = req.headers['authorization'] ?? '';
    const m   = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m || !AUTH_TOKENS.includes(m[1])) return ollamaError(res, 401, 'Invalid or missing API key');
  }

  next();
});

// ── Version / root ────────────────────────────────────────────────────────────
app.get('/',            (_, res) => res.json({ version: '0.9.0' }));
app.get('/api/version', (_, res) => res.json({ version: '0.9.0' }));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ status: 'ok', pool: pool.stats, registry: registry.stats, embeddings: embeddings.stats });
});

app.get('/health/agents', (_, res) => {
  res.json({
    pool: pool._slots.map((s, i) => ({
      index: i,
      alive: !!s.client?.alive,
      busy:  s.busy,
      label: s.client?.label ?? null,
    })),
    sessions: [...registry._map.entries()].map(([id, e]) => ({
      id, alive: e.client.alive, last_used: e.lastUsed,
    })),
  });
});

// ── Models ────────────────────────────────────────────────────────────────────

function toOllamaModel(modelId, description) {
  return {
    name:        modelId,
    model:       modelId,
    modified_at: new Date().toISOString(),
    size:        0,
    digest:      '',
    details: {
      format:             'gguf',
      family:             'kiro',
      parameter_size:     description ?? 'unknown',
      quantization_level: 'unknown',
    },
  };
}

app.get('/api/tags', (_, res) => {
  const kiroModels = _startupModels.map((id) =>
    toOllamaModel(id, id === 'auto' ? 'Kiro default model selection' : undefined)
  );
  const embedModels = EMBEDDING_MODELS_ENABLED
    .filter((id) => !_startupModels.includes(id))
    .map((id) => toOllamaModel(id, `Embedding model (fastembed)`));
  res.json({ models: [...kiroModels, ...embedModels] });
});

app.post('/api/show', (req, res) => {
  const { model = 'auto' } = req.body ?? {};
  const isEmbed = EMBEDDING_MODELS_ENABLED.includes(model);
  const isKiro  = _startupModels.includes(model);
  if (!isEmbed && !isKiro) return ollamaError(res, 404, `model '${model}' not found`);
  res.json({
    model,
    modified_at:  new Date().toISOString(),
    details:      { format: 'gguf', family: 'kiro', parameter_size: 'unknown', quantization_level: 'unknown' },
    capabilities: isEmbed ? ['embedding'] : ['completion', 'tools'],
    modelinfo:    {},
    template:     '',
    parameters:   '',
    license:      '',
  });
});

app.get('/api/ps', (_, res) => {
  res.json({
    models: [{
      name:       'auto',
      model:      'auto',
      size:       0,
      size_vram:  0,
      details:    { format: 'gguf', family: 'kiro' },
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    }],
  });
});

// ── Core completion handler ───────────────────────────────────────────────────

async function handleOllamaCompletion(req, res, { blocks, model, stream, wantThinking, isGenerate, tools, sessionIdOverride }) {
  const cwd      = req.headers['x-working-dir'] ?? pickCwd(blocks, KIRO_CWD);
  const sessionId = req.headers['x-session-id'] ?? sessionIdOverride;

  let client, slot;
  if (sessionId) {
    client = await registry.acquire(sessionId, cwd);
    await client.setModel(model);
  } else {
    slot   = await pool.acquire();
    client = slot.client;
    await client.newSession(cwd);
    await client.setModel(model);
  }

  const startNs = process.hrtime.bigint();

  try {
    if (stream) {
      setNdjsonHeaders(res);
      req.on('close', () => { if (!res.writableEnded) client.cancel(); });

      const allChunks = [];
      await client.prompt(blocks, (chunk) => {
        allChunks.push(chunk);
        if (!res.writable) return;
        // When tools are present, don't stream text — wait for final message
        // so LangFlow doesn't see content twice (streamed + final)
        if (tools?.length) return;
        if (chunk.kind === 'text') {
          if (isGenerate) {
            res.write(ndjsonLine({ model, created_at: new Date().toISOString(), response: chunk.text, done: false }));
          } else {
            res.write(ndjsonLine({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: chunk.text }, done: false }));
          }
        }
        if (chunk.kind === 'thought' && wantThinking) {
          if (isGenerate) {
            res.write(ndjsonLine({ model, created_at: new Date().toISOString(), response: '', thinking: chunk.text, done: false }));
          } else {
            res.write(ndjsonLine({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '', thinking: chunk.text }, done: false }));
          }
        }
      });

      if (isGenerate) {
        const textChunks = allChunks.filter((c) => c.kind === 'text').map((c) => c.text).join('');
        const thoughtChunks = wantThinking ? allChunks.filter((c) => c.kind === 'thought').map((c) => c.text).join('') : null;
        const stats = makeStats(startNs, blocks, textChunks);
        res.write(ndjsonLine({
          model, created_at: new Date().toISOString(),
          response: '', done: true, done_reason: 'stop',
          ...(wantThinking && thoughtChunks ? { thinking: thoughtChunks } : {}),
          ...stats,
        }));
      } else {
        const message = coerceToolCall(chunksToOllamaMessage(allChunks, wantThinking), tools);
        const stats   = makeStats(startNs, blocks, message.content);
        dbg('resp', `content=${JSON.stringify(message.content)}  tool_calls=${JSON.stringify(message.tool_calls ?? null)}`);
        res.write(ndjsonLine({
          model, created_at: new Date().toISOString(),
          message, done: true, done_reason: message.tool_calls ? 'tool_calls' : 'stop',
          ...stats,
        }));
      }
      res.end();

    } else {
      const chunks = await client.prompt(blocks);

      if (isGenerate) {
        const textContent = chunks.filter((c) => c.kind === 'text').map((c) => c.text).join('');
        const thoughtContent = wantThinking ? chunks.filter((c) => c.kind === 'thought').map((c) => c.text).join('') : null;
        const stats = makeStats(startNs, blocks, textContent);
        res.json({
          model, created_at: new Date().toISOString(),
          response: textContent,
          ...(wantThinking && thoughtContent ? { thinking: thoughtContent } : {}),
          done: true, done_reason: 'stop',
          ...stats,
        });
      } else {
        const message = coerceToolCall(chunksToOllamaMessage(chunks, wantThinking), tools);
        const stats   = makeStats(startNs, blocks, message.content);
        dbg('resp', `content=${JSON.stringify(message.content)}  tool_calls=${JSON.stringify(message.tool_calls ?? null)}`);
        res.json({
          model, created_at: new Date().toISOString(),
          message, done: true, done_reason: message.tool_calls ? 'tool_calls' : 'stop',
          ...stats,
        });
      }
    }
  } catch (err) {
    log('error', err.message);
    if (!res.headersSent) ollamaError(res, 500, err.message);
  } finally {
    if (slot) pool.release(slot);
  }
}

// ── POST /api/chat ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const {
    model    = 'auto',
    messages = [],
    tools,
    format,
    stream   = true,   // Ollama default is true
    think,
    // keep_alive and options are accepted-and-ignored
  } = req.body ?? {};

  if (!Array.isArray(messages) || !messages.length) {
    return ollamaError(res, 400, '`messages` is required and must be a non-empty array');
  }

  const wantThinking     = !!think;
  const blocks           = buildAcpBlocksFromOllama(messages, tools, { format, think });
  const sessionIdOverride = AUTO_SESSION_HASH && !req.headers['x-session-id']
    ? autoSessionId(messages) : undefined;

  dbg('chat', `tools=${JSON.stringify(tools ?? null)}  format=${JSON.stringify(format ?? null)}`);
  if (sessionIdOverride) dbg('chat', `auto-session=${sessionIdOverride}`);

  await handleOllamaCompletion(req, res, { blocks, model, stream, wantThinking, isGenerate: false, tools, sessionIdOverride });
});

// ── POST /api/generate ────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const {
    model  = 'auto',
    prompt = '',
    system,
    images,
    format,
    stream = true,   // Ollama default is true
    think,
    // suffix, raw, keep_alive, options accepted-and-ignored
  } = req.body ?? {};

  if (!prompt && !system) {
    return ollamaError(res, 400, '`prompt` is required');
  }

  const wantThinking = !!think;
  const blocks       = buildAcpBlocksFromGenerate(prompt, system, images, { format, think });

  await handleOllamaCompletion(req, res, { blocks, model, stream, wantThinking, isGenerate: true });
});

// ── Embeddings ────────────────────────────────────────────────────────────────

async function runEmbeddings(model, inputs) {
  let embeddingModel;
  try {
    embeddingModel = await embeddings.getModel(model);
  } catch (err) {
    if (err instanceof ModelNotEnabledError) throw Object.assign(err, { status: 400, msg: `model '${model}' is not enabled` });
    throw err;
  }
  const vectors = new Array(inputs.length);
  let idx = 0;
  for await (const batch of embeddingModel.embed(inputs, EMBEDDING_BATCH_SIZE)) {
    for (const vec of batch) vectors[idx++] = Array.from(vec);
  }
  return vectors;
}

// POST /api/embed — new API, accepts string or array
app.post('/api/embed', async (req, res) => {
  const { model = EMBEDDING_MODEL_DEFAULT, input } = req.body ?? {};

  let inputs;
  if (typeof input === 'string') {
    if (!input.trim()) return ollamaError(res, 400, '`input` must be a non-empty string');
    inputs = [input];
  } else if (Array.isArray(input)) {
    if (!input.length) return ollamaError(res, 400, '`input` array must not be empty');
    if (input.length > EMBEDDING_MAX_INPUTS) return ollamaError(res, 400, `\`input\` array exceeds max of ${EMBEDDING_MAX_INPUTS}`);
    inputs = input.map((item) => (typeof item === 'string' && item.trim()) ? item : ' ');
  } else {
    return ollamaError(res, 400, '`input` is required (string or array of strings)');
  }

  try {
    const vectors      = await runEmbeddings(model, inputs);
    const promptTokens = inputs.reduce((sum, t) => sum + estimateTokens(t), 0);
    res.json({ model, embeddings: vectors, total_duration: 0, load_duration: 0, prompt_eval_count: promptTokens });
  } catch (err) {
    if (err.status) return ollamaError(res, err.status, err.msg);
    log('embeddings', 'error', err.message);
    ollamaError(res, 500, err.message);
  }
});

// POST /api/embeddings — legacy API, single string input, single flat vector
app.post('/api/embeddings', async (req, res) => {
  const { model = EMBEDDING_MODEL_DEFAULT, prompt } = req.body ?? {};

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return ollamaError(res, 400, '`prompt` is required (string)');
  }

  try {
    const vectors = await runEmbeddings(model, [prompt]);
    res.json({ model, embedding: vectors[0] });
  } catch (err) {
    if (err.status) return ollamaError(res, err.status, err.msg);
    log('embeddings', 'error', err.message);
    ollamaError(res, 500, err.message);
  }
});

// ── Stateful session management ───────────────────────────────────────────────
app.delete('/v1/sessions/:id', (req, res) => {
  registry.delete(req.params.id);
  res.json({ deleted: req.params.id });
});

// ── Stub endpoints ────────────────────────────────────────────────────────────

function stubStreaming(res, statusLine = 'success') {
  setNdjsonHeaders(res);
  res.write(ndjsonLine({ status: statusLine }));
  res.end();
}

app.post('/api/pull', (req, res) => {
  const { stream = true } = req.body ?? {};
  if (stream) {
    setNdjsonHeaders(res);
    res.write(ndjsonLine({ status: 'pulling manifest' }));
    res.write(ndjsonLine({ status: 'success' }));
    res.end();
  } else {
    res.json({ status: 'success' });
  }
});

app.post('/api/push',   (req, res) => { const { stream = true } = req.body ?? {}; stream ? stubStreaming(res) : res.json({ status: 'success' }); });
app.post('/api/create', (req, res) => { const { stream = true } = req.body ?? {}; stream ? stubStreaming(res) : res.json({ status: 'success' }); });
app.post('/api/copy',   (_, res)   => res.json({}));
app.delete('/api/delete', (_, res) => res.json({}));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log('uncaught', err.message);
  if (!res.headersSent) ollamaError(res, 500, err.message);
});

// ─── Start ────────────────────────────────────────────────────────────────────

let _startupModels = ['auto'];
try {
  const slot = await pool.acquire();
  try {
    const result = await slot.client._req('session/new', { cwd: KIRO_CWD, mcpServers: [] });
    dbg('startup', `session/new response: ${JSON.stringify(result)}`);
    const ids = (result?.models?.availableModels ?? []).map((m) => m.modelId);
    if (ids.length) {
      _startupModels = ['auto', ...ids.filter((id) => id !== 'auto')];
      log('startup', `discovered ${_startupModels.length} models from binary: ${_startupModels.join(', ')}`);
    } else {
      log('startup', `session/new returned no model list — defaulting to ['auto']`);
      log('startup', `  (set DEBUG=1 to see the raw session/new response and verify the field path)`);
    }
  } finally { pool.release(slot); }
} catch (e) {
  log('startup', `model discovery failed (${e.message}) — defaulting to ['auto']`);
}

const server = app.listen(PORT, () => {
  const tokenDisplay = AUTH_TOKENS.length
    ? AUTH_TOKENS.map(t => `${t.slice(0, 18)}…`).join(', ')
    : 'OPEN (no AUTH_TOKEN set)';
  console.log(`┌──────────────────────────────────────────────────────────────┐
│  ACP → Ollama Proxy  v1.0  —  http://localhost:${PORT}
│  Auth:    ${tokenDisplay}
│  IP ACL:  ${ALLOWED_IPS.length ? ALLOWED_IPS.join(', ') : 'open'}
│  Mode:    ${DEBUG ? 'DEBUG' : 'production'}  |  Pool: ${POOL_SIZE} workers  |  Ping: ${PING_INTERVAL_MS / 1000}s
│  Models:  ${_startupModels.join(', ')}
│  Embed:   ${EMBEDDING_MODEL_DEFAULT} (${EMBEDDING_MODELS_ENABLED.length} model${EMBEDDING_MODELS_ENABLED.length > 1 ? 's' : ''} enabled)
│  TTL:     session=${SESSION_TTL_MS / 60000}min  exec_max=${MAX_EXEC_MS / 60000}min
│  Session: ${AUTO_SESSION_HASH ? 'auto (system-prompt hash)' : 'stateless pool (set AUTO_SESSION_HASH=1 to persist)'}
└──────────────────────────────────────────────────────────────┘`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[start] Port ${PORT} already in use — is another instance running?`);
  } else {
    console.error('[start] Server error:', err.message);
  }
  process.exit(1);
});
