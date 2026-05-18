/**
 * Kiro ACP Bridge — Full
 * ──────────────────────
 * Full-featured OpenAI-compatible server: connection pool, stateful sessions,
 * background jobs. Building on v2 (multi-slot pool + structured tool_call events + sessions),
 * useful patterns from aws-samples/sample-acp-bridge.
 *
 * NEW IN v3 — from bridge:
 *   • Bearer token auth + IP allowlist
 *   • Background mode (submit → poll) — bridge's /jobs pattern, OpenAI-shaped
 *   • Cancellation (session/cancel → DELETE /v1/chat/completions/:id)
 *   • Stuck-job patrol (10min auto-fail)
 *   • /health/agents granular probe
 *
 * NEW IN v3 — for OpenAI compat:
 *   • Proper error envelope: {error:{message,type,param,code}}
 *   • x-request-id response header
 *   • CORS middleware
 *   • stream_options.include_usage → final chunk with token estimates
 *   • response_format: json_object / json_schema → system prompt injection
 *   • tool_choice: none | auto | required | {type:function, function:{name}}
 *   • GET /v1/models/{id}
 *   • Accept-and-ignore for unsupported params (temperature, max_tokens, etc.)
 *   • Rough token usage estimation (chars/4 heuristic)
 *
 * Install:  npm install express cors
 * Run:      ACP_API_KEY=sk-mykey node kiro-api-bridge-server-full.js
 *
 * Standard call:
 *   curl http://localhost:3456/v1/chat/completions \
 *     -H "Authorization: Bearer sk-mykey" \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
 *
 * Background mode:
 *   # submit
 *   curl -X POST http://localhost:3456/v1/chat/completions \
 *     -H "Authorization: Bearer sk-mykey" \
 *     -d '{"model":"auto","messages":[...],"background":true}'
 *   # → {"id":"chatcmpl-...","status":"queued",...}
 *
 *   # poll
 *   curl http://localhost:3456/v1/chat/completions/chatcmpl-xxx \
 *     -H "Authorization: Bearer sk-mykey"
 *
 *   # cancel
 *   curl -X DELETE http://localhost:3456/v1/chat/completions/chatcmpl-xxx \
 *     -H "Authorization: Bearer sk-mykey"
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import readline from 'readline';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import path from 'path';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT            = parseInt(process.env.PORT             ?? '3456');
const KIRO_CMD        = process.env.KIRO_CMD                  ?? 'kiro-cli';
const KIRO_ARGS       = process.env.KIRO_ARGS                 ?? 'acp';
const KIRO_CWD        = process.env.KIRO_CWD                  ?? process.cwd();
const DEBUG           = process.env.DEBUG                     === '1';

const POOL_SIZE        = parseInt(process.env.POOL_SIZE        ?? '4');
const SESSION_TTL_MS   = parseInt(process.env.SESSION_TTL_MS   ?? String(30 * 60 * 1000));
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL    ?? '60000');
const MAX_EXEC_MS      = parseInt(process.env.MAX_EXEC_MS      ?? String(10 * 60 * 1000));  // 10min stuck-fail
const JOB_TTL_MS       = parseInt(process.env.JOB_TTL_MS       ?? String(60 * 60 * 1000));  // 1hr keep completed

// Auth — multiple tokens comma-separated, e.g. ACP_API_KEY="sk-a,sk-b"
const AUTH_TOKENS = (process.env.ACP_API_KEY ?? process.env.AUTH_TOKEN ?? '').split(',').map(t => t.trim()).filter(Boolean);
const ALLOWED_IPS = (process.env.ALLOWED_IPS ?? '').split(',').map(t => t.trim()).filter(Boolean);

// ─── Logging ──────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 23); }
function log(tag, ...args) { console.log(`${ts()} [${tag}]`, ...args); }
function dbg(tag, ...args) { if (DEBUG) process.stderr.write(`${ts()} [${tag}] ${args.join(' ')}\n`); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId()           { return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`; }
function makeToolCallId()   { return `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`; }
function makeReqId()        { return `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`; }
function nowSec()           { return Math.floor(Date.now() / 1000); }

// Rough token estimate — good enough for usage reporting. Real tokenizer
// would require tiktoken or model-specific encoders.
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

// ─── Error envelope (OpenAI shape) ────────────────────────────────────────────

function apiError(res, status, message, type = 'invalid_request_error', param = null, code = null) {
  return res.status(status).json({
    error: { message, type, param, code },
  });
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
      } catch (e) { dbg(`parse`, e.message); }
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

  /** Cancel current execution via ACP notification (bridge pattern). */
  cancel() {
    if (!this.alive || !this.sessionId) return;
    try {
      this._send({
        jsonrpc: '2.0',
        method:  'session/cancel',
        params:  { sessionId: this.sessionId },
      });
    } catch {}
  }

  get alive() { return !this._dead && this._proc && !this._proc.killed; }

  /** Compact debug log — silences per-chunk noise and large notification blobs. */
  _dbgLine(msg) {
    if (!DEBUG) return;
    const m = msg.method;
    // Suppress per-chunk streaming noise — prompt() logs summary instead.
    if (m === 'session/update' || m === 'session/notification' || m === '_kiro.dev/session/update') return;
    // Collapse large session-init notifications to a one-liner.
    if (m === '_kiro.dev/commands/available') {
      const p = msg.params ?? {};
      dbg(`←${this.label}`, `commands/available  commands=${p.commands?.length ?? 0}  tools=${p.tools?.length ?? 0}  mcp=${p.mcpServers?.length ?? 0}`);
      return;
    }
    if (m === '_kiro.dev/subagent/list_update') return; // always empty during normal use
    // Suppress ping error responses — handled silently in the ping timer.
    if (!m && msg.error?.data === 'ping') return;
    // Everything else: log but cap at 300 chars to keep responses readable.
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
        default: dbg(`update:${this.label}`, `unhandled "${type}"`);
      }
    }
  }

  async initialize() {
    await this._req('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'acp-openai-proxy', version: '3.0.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    // kiro-cli rejects notifications/initialized — omit it.
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
    let textLen = 0, toolCalls = 0;
    const handler = (c) => {
      chunks.push(c);
      if (c.kind === 'text') textLen += c.text.length;
      if (c.kind === 'tool_call_start') toolCalls++;
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
    dbg(`prompt:${this.label}`, `done  chunks=${chunks.length}  textChars=${textLen}  toolCalls=${toolCalls}`);
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
        // kiro-cli doesn't implement ping — treat Method Not Found as alive.
        if (e.message.includes('Method not found') || e.message.includes('-32601')) {
          return;
        }
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
    this._size = size;
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
      size: this._size,
      busy: this._slots.filter((s) => s.busy).length,
      alive: this._slots.filter((s) => s.client?.alive).length,
      queued: this._queue.length,
    };
  }
}

class SessionRegistry {
  constructor() {
    this._map = new Map();
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

// ─── JobStore (background mode — bridge pattern) ──────────────────────────────
// Stores in-flight and completed jobs. Bridge persists to SQLite; here it's
// in-memory with TTL reaping. Add SQLite if you need restart-survival.

class JobStore {
  constructor() {
    this._jobs = new Map();   // id → job
    setInterval(() => this._patrol(), 60_000).unref();
  }

  create(id, payload) {
    const job = {
      id,
      status:      'queued',     // queued | running | completed | failed | cancelled
      created_at:  Date.now(),
      started_at:  null,
      finished_at: null,
      payload,                    // original request body for replay/debug
      result:      null,          // final OpenAI response
      error:       null,
      client:      null,          // ACPSession in use (for cancel)
      slot:        null,          // pool slot (for release on cancel)
    };
    this._jobs.set(id, job);
    return job;
  }

  get(id) { return this._jobs.get(id); }

  update(id, patch) {
    const j = this._jobs.get(id);
    if (!j) return null;
    Object.assign(j, patch);
    return j;
  }

  /** OpenAI-shaped status view for polling. */
  view(job) {
    return {
      id:           job.id,
      object:       'chat.completion',
      status:       job.status,        // non-standard but useful — OpenAI uses status on Responses API
      created:      Math.floor(job.created_at / 1000),
      started_at:   job.started_at  ? Math.floor(job.started_at  / 1000) : null,
      finished_at: job.finished_at ? Math.floor(job.finished_at / 1000) : null,
      ...(job.result ?? {}),
      ...(job.error  ? { error: job.error } : {}),
    };
  }

  /** Stuck patrol: jobs running > MAX_EXEC_MS are auto-failed. */
  _patrol() {
    const now = Date.now();
    for (const job of this._jobs.values()) {
      if (job.status === 'running' && job.started_at && now - job.started_at > MAX_EXEC_MS) {
        log('jobstore', `stuck job ${job.id} → fail`);
        try { job.client?.cancel(); } catch {}
        job.status      = 'failed';
        job.finished_at = now;
        job.error       = { message: `Execution exceeded ${MAX_EXEC_MS / 60000}min`, type: 'timeout_error' };
      }
      // Reap completed/failed/cancelled jobs after TTL
      if (job.finished_at && now - job.finished_at > JOB_TTL_MS) {
        this._jobs.delete(job.id);
      }
    }
  }

  get stats() {
    const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const j of this._jobs.values()) counts[j.status]++;
    return { total: this._jobs.size, ...counts };
  }
}

// ─── Globals ──────────────────────────────────────────────────────────────────

const pool     = new ACPPool(POOL_SIZE);
const registry = new SessionRegistry();
const jobs     = new JobStore();

await pool.warmup();

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => { log('shutdown', sig); pool.shutdown(); process.exit(0); });
});

// ─── Message conversion ───────────────────────────────────────────────────────

/**
 * Build ACP blocks from OpenAI messages, applying response_format and tool_choice.
 *
 * response_format:
 *   { type: 'json_object' }                    → instruct agent to reply pure JSON
 *   { type: 'json_schema', json_schema: {...}} → also append schema for validation
 *
 * tool_choice:
 *   'none'                                     → strip tools, instruct no tool use
 *   'auto' (default)                           → tools listed, agent chooses
 *   'required'                                 → instruct must call a tool
 *   { type: 'function', function: { name }}    → instruct must call this specific tool
 */
function buildAcpBlocks(messages, tools, opts = {}) {
  const { response_format, tool_choice } = opts;
  const system = messages.find((m) => m.role === 'system');
  const turns  = messages.filter((m) => m.role !== 'system');

  let text = '';

  if (system) text += `[System]\n${contentText(system.content)}\n\n`;

  // ── response_format injection ──
  if (response_format?.type === 'json_object') {
    text += `[Output format] Respond ONLY with a valid JSON object. No prose, no markdown fences.\n\n`;
  } else if (response_format?.type === 'json_schema') {
    text += `[Output format] Respond ONLY with a JSON object conforming to this schema:\n`;
    text += `\`\`\`json\n${JSON.stringify(response_format.json_schema?.schema ?? response_format.json_schema, null, 2)}\n\`\`\`\n\n`;
  }

  // ── tool_choice injection ──
  const effectiveTools = tool_choice === 'none' ? null : tools;
  if (effectiveTools?.length) {
    text += `[Available tools]\nEmit a tool_call ACP notification (not text) when invoking a tool.\n`;
    text += `\`\`\`json\n${JSON.stringify(effectiveTools.map((t) => t.function ?? t), null, 2)}\n\`\`\`\n`;
    if (tool_choice === 'required') {
      text += `[Tool requirement] You MUST call one of the tools above. Do not respond with plain text.\n`;
    } else if (typeof tool_choice === 'object' && tool_choice?.type === 'function') {
      text += `[Tool requirement] You MUST call the "${tool_choice.function.name}" tool. Do not respond with plain text or call any other tool.\n`;
    }
    text += '\n';
  } else if (tool_choice === 'none') {
    text += `[Tool restriction] Do not call any tools. Respond with text only.\n\n`;
  }

  // ── Conversation history ──
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

  // Attachments from last user turn
  const lastUser = [...turns].reverse().find((m) => m.role === 'user');
  if (lastUser && Array.isArray(lastUser.content)) {
    for (const part of lastUser.content) {
      if (part.type === 'image_url') {
        const url = part.image_url?.url ?? '';
        const m   = url.match(/^data:([^;]+);base64,(.+)$/);
        if (m) blocks.push({ type: 'image', mimeType: m[1], data: m[2] });
        else if (url.startsWith('file://')) blocks.push({ type: 'resource_link', uri: url, name: url.split('/').pop(), mimeType: 'image/*' });
      } else if (part.type === 'file') {
        const p = part.file?.path ?? part.file?.filename ?? '';
        if (p) blocks.push({
          type: 'resource_link',
          uri:  p.startsWith('file://') ? p : `file://${p}`,
          name: p.split(/[\\/]/).pop(),
          mimeType: part.file?.mimeType ?? 'application/octet-stream',
          ...(part.file?.size ? { size: part.file.size } : {}),
        });
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
    if (c.kind === 'tool_call_start') {
      toolCallMap.set(c.toolCallId, { id: makeToolCallId(), name: c.name, argsParts: [] });
    }
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
  const promptText = promptBlocks.map((b) => b.text ?? '').join('');
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
    choices: [],
    usage,
  })}\n\n`;
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();

// CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Session-Id', 'X-Working-Dir', 'X-Request-Id'],
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

// Auth + IP allowlist
app.use((req, res, next) => {
  // Allow /health unauthenticated (for load balancer probes — bridge pattern)
  if (req.path === '/health' || req.path === '/') return next();

  // IP allowlist (if configured)
  if (ALLOWED_IPS.length > 0) {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '').replace('::ffff:', '');
    if (!ALLOWED_IPS.includes(ip)) {
      return apiError(res, 403, `IP ${ip} not in allowlist`, 'forbidden', null, 'ip_not_allowed');
    }
  }

  // Bearer token (if configured)
  if (AUTH_TOKENS.length > 0) {
    const hdr = req.headers['authorization'] ?? '';
    const m   = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m || !AUTH_TOKENS.includes(m[1])) {
      return apiError(res, 401, 'Invalid or missing API key', 'authentication_error', null, 'invalid_api_key');
    }
  }

  next();
});

// ── Health (unauthenticated) ──────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ status: 'ok', capabilities: ['chat', 'sessions', 'background_jobs'], pool: pool.stats, registry: registry.stats, jobs: jobs.stats });
});
app.get('/', (_, res) => res.redirect('/health'));

// ── Per-agent health (bridge pattern) ────────────────────────────────────────
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
app.get('/v1/models', async (_, res) => {
  const slot = await pool.acquire();
  try {
    const result = await slot.client._req('session/new', { cwd: KIRO_CWD, mcpServers: [] });
    const models = result?.models?.availableModels ?? [];
    const autoEntry = { id: 'auto', object: 'model', created: 0, owned_by: 'kiro', description: 'Kiro default model selection' };
    res.json({
      object: 'list',
      data: [autoEntry, ...models.map((m) => ({
        id: m.modelId, object: 'model', created: 0, owned_by: 'kiro', description: m.description,
      }))],
    });
  } catch (err) { apiError(res, 500, err.message, 'server_error'); }
  finally { pool.release(slot); }
});

app.get('/v1/models/:id', async (req, res) => {
  const slot = await pool.acquire();
  try {
    const result = await slot.client._req('session/new', { cwd: KIRO_CWD, mcpServers: [] });
    const m = (result?.models?.availableModels ?? []).find((x) => x.modelId === req.params.id);
    if (!m) return apiError(res, 404, `Model '${req.params.id}' not found`, 'invalid_request_error', 'model', 'model_not_found');
    res.json({ id: m.modelId, object: 'model', created: 0, owned_by: 'kiro', description: m.description });
  } catch (err) { apiError(res, 500, err.message, 'server_error'); }
  finally { pool.release(slot); }
});

// ── Chat completions ─────────────────────────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  const {
    messages = [],
    model    = 'auto',
    stream   = false,
    tools,
    tool_choice    = 'auto',
    response_format,
    background     = false,    // non-standard but bridge-inspired
    stream_options = {},
    // Accepted-and-ignored (don't 400):
    // temperature, top_p, n, max_tokens, stop, presence_penalty,
    // frequency_penalty, logit_bias, user, seed, parallel_tool_calls
  } = req.body ?? {};

  if (!Array.isArray(messages) || !messages.length) {
    return apiError(res, 400, '`messages` is required and must be a non-empty array', 'invalid_request_error', 'messages');
  }

  const id     = makeId();
  const blocks = buildAcpBlocks(messages, tools, { response_format, tool_choice });
  const cwd    = req.headers['x-working-dir'] ?? pickCwd(blocks, KIRO_CWD);

  // ── Background mode (bridge /jobs pattern) ────────────────────────────────
  if (background) {
    const job = jobs.create(id, req.body);
    // Fire-and-forget — actual execution happens async, status visible via GET
    runJobAsync(job, { model, blocks, cwd }).catch((e) => {
      log('job', `${id} crashed: ${e.message}`);
      jobs.update(id, { status: 'failed', finished_at: Date.now(), error: { message: e.message, type: 'server_error' } });
    });
    return res.status(202).json(jobs.view(job));
  }

  // ── Synchronous (stateless or stateful) ───────────────────────────────────
  const sessionId = req.headers['x-session-id'];
  try {
    if (sessionId) {
      const client = await registry.acquire(sessionId, cwd);
      await client.setModel(model);
      return await handleCompletion(req, res, { client, model, id, stream, blocks, stream_options });
    }

    const slot = await pool.acquire();
    try {
      const client = slot.client;
      await client.newSession(cwd);
      await client.setModel(model);
      await handleCompletion(req, res, { client, model, id, stream, blocks, stream_options });
    } finally { pool.release(slot); }
  } catch (err) {
    log('error', err.message);
    if (!res.headersSent) apiError(res, 500, err.message, 'server_error');
  }
});

async function handleCompletion(req, res, { client, model, id, stream, blocks, stream_options }) {
  const includeUsage = stream_options?.include_usage === true;

  if (stream) {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(sseChunk(id, model, { role: 'assistant' }));

    const allChunks = [];

    // Cancel on client disconnect — bridge pattern
    req.on('close', () => { if (!res.writableEnded) { client.cancel(); } });

    await client.prompt(blocks, (chunk) => {
      allChunks.push(chunk);
      if (!res.writable) return;
      switch (chunk.kind) {
        case 'text':    res.write(sseChunk(id, model, { content: chunk.text })); break;
        case 'thought': res.write(sseChunk(id, model, { reasoning_content: chunk.text })); break;
      }
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
      const usage = buildUsage(blocks, content, thought);
      res.write(sseUsageChunk(id, model, usage));
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } else {
    const chunks = await client.prompt(blocks);
    const { content, thought, tool_calls } = chunksToResponse(chunks);
    const usage = buildUsage(blocks, content, thought);
    res.json(nonStreamResponse(id, model, content, tool_calls, thought, usage));
  }
}

/** Async background runner — bridge /jobs pattern. */
async function runJobAsync(job, { model, blocks, cwd }) {
  jobs.update(job.id, { status: 'running', started_at: Date.now() });
  const slot = await pool.acquire();
  job.slot = slot;
  job.client = slot.client;
  try {
    await slot.client.newSession(cwd);
    await slot.client.setModel(model);
    const chunks = await slot.client.prompt(blocks);
    // Job may have been cancelled mid-flight
    if (jobs.get(job.id)?.status === 'cancelled') return;
    const { content, thought, tool_calls } = chunksToResponse(chunks);
    const usage  = buildUsage(blocks, content, thought);
    const result = nonStreamResponse(job.id, model, content, tool_calls, thought, usage);
    jobs.update(job.id, { status: 'completed', finished_at: Date.now(), result });
  } catch (err) {
    jobs.update(job.id, { status: 'failed', finished_at: Date.now(), error: { message: err.message, type: 'server_error' } });
  } finally {
    pool.release(slot);
    job.client = null; job.slot = null;
  }
}

// ── Background job retrieval / cancellation ───────────────────────────────────
app.get('/v1/chat/completions/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return apiError(res, 404, `Job '${req.params.id}' not found`, 'invalid_request_error', 'id', 'job_not_found');
  res.json(jobs.view(job));
});

app.delete('/v1/chat/completions/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return apiError(res, 404, `Job '${req.params.id}' not found`, 'invalid_request_error', 'id', 'job_not_found');
  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    return res.json(jobs.view(job));   // already done
  }
  try { job.client?.cancel(); } catch {}
  jobs.update(job.id, { status: 'cancelled', finished_at: Date.now() });
  res.json(jobs.view(jobs.get(job.id)));
});

// ── Stateful session management ───────────────────────────────────────────────
app.delete('/v1/sessions/:id', (req, res) => {
  registry.delete(req.params.id);
  res.json({ deleted: req.params.id });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log('uncaught', err.message);
  if (!res.headersSent) apiError(res, 500, err.message, 'server_error');
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Fetch available models from a pool slot before binding the port.
let _startupModels = ['auto'];
try {
  const slot = await pool.acquire();
  try {
    const result = await slot.client._req('session/new', { cwd: KIRO_CWD, mcpServers: [] });
    const ids = (result?.models?.availableModels ?? []).map((m) => m.modelId);
    if (ids.length) _startupModels = ['auto', ...ids];
  } finally { pool.release(slot); }
} catch { /* non-fatal — banner will just show 'auto' */ }

const server = app.listen(PORT, () => {
  const tokenDisplay = AUTH_TOKENS.length
    ? AUTH_TOKENS.join(', ')
    : 'OPEN (no ACP_API_KEY set)';
  console.log(`┌──────────────────────────────────────────────────────────────┐
│  Kiro ACP Bridge (full)  —  http://localhost:${PORT}
│  Auth:    ${tokenDisplay}
│  IP ACL:  ${ALLOWED_IPS.length ? ALLOWED_IPS.join(', ') : 'open'}
│  Mode:    ${DEBUG ? 'DEBUG' : 'production'}  |  Pool: ${POOL_SIZE} workers  |  Ping: ${PING_INTERVAL_MS / 1000}s
│  Models:  ${_startupModels.join(', ')}
│  TTL:     session=${SESSION_TTL_MS / 60000}min  job=${JOB_TTL_MS / 60000}min  exec_max=${MAX_EXEC_MS / 60000}min
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