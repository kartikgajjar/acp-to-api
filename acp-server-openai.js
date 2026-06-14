/**
 * ACP → OpenAI-compatible proxy for Codex
 * ─────────────────────────────────────────
 * Drop-in replacement for the OpenAI API. Any tool that uses OpenAI
 * (Python SDK, JS SDK, LangChain, Continue.dev, …) can point at this
 * server and transparently route to Codex via the ACP protocol.
 *
 * Implements the OpenAI REST API:
 *   POST /v1/chat/completions   streaming SSE or JSON
 *   GET  /v1/models             list available models
 *   GET  /health                pool / registry stats
 *   GET  /                      identity
 *
 * Run:  OPENAI_API_KEY=sk-... node acp-server-codex.js
 */

import 'dotenv/config';
// Allow --debug CLI flag as alias for DEBUG=1
if (process.argv.includes('--debug')) process.env.DEBUG = '1';
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import readline from 'readline';
import { EventEmitter } from 'events';
import { randomUUID, createHash } from 'crypto';
import path from 'path';
import fs from 'fs';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT             = parseInt(process.env.PORT             ?? '3456');
const HOST             = process.env.HOST                      ?? '127.0.0.1';
const ALLOW_INSECURE   = process.env.ALLOW_INSECURE_REMOTE     === '1';
const CWD              = process.env.ACP_CWD ?? process.env.KIRO_CWD ?? process.env.CODEX_CWD ?? process.cwd();
const DEBUG            = process.env.DEBUG                     === '1';
const POOL_SIZE        = parseInt(process.env.POOL_SIZE        ?? '4');
const POOL_PRECREATE   = process.env.POOL_PRECREATE           === '1';
const SESSION_TTL_MS   = parseInt(process.env.SESSION_TTL_MS   ?? String(30 * 60 * 1000));
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL    ?? '60000');
const MAX_EXEC_MS      = parseInt(process.env.MAX_EXEC_MS      ?? String(10 * 60 * 1000));
const ACP_API_KEYS     = (process.env.ACP_API_KEY ?? '').split(',').map(t => t.trim()).filter(Boolean);
const ALLOWED_IPS      = (process.env.ALLOWED_IPS ?? '').split(',').map(t => t.trim()).filter(Boolean);
const AUTO_SESSION_HASH = process.env.AUTO_SESSION_HASH        === '1';

// ─── Backend profiles ─────────────────────────────────────────────────────────
// This file exposes the OpenAI REST surface; the ACP backend is selected with the
// --backend=<name> flag (default: codex). The BACKENDS map below is kept
// BYTE-IDENTICAL with the copy in acp-server-ollama.js — test/regression asserts
// they match. When you edit one copy, edit the other identically.

// >>> BACKENDS
const BACKENDS = {
  kiro: (env) => ({
    name:  'kiro',
    label: 'kiro-cli',
    cmd:   env.KIRO_CMD ?? 'kiro-cli',
    args:  (env.KIRO_ARGS ?? 'acp').split(' ').filter(Boolean),
    clientName: 'acp-proxy',
    requiresAuthWhenRemote: false,
    sendInitialized: false,
    mode: null,
    defaultModel: 'auto',
    fallbackModels: ['auto'],
    buildEnv(parent) { return { ...parent }; },
    formatStartupModels(ids) { return ['auto', ...ids.filter(id => id !== 'auto')]; },
    async postNewSession() {},
    async setModel(session, modelId) {
      if (!modelId || modelId === 'auto' || modelId === session.currentModel) return;
      await session._reqSafe('model', 'session/set_model', { sessionId: session.sessionId, modelId });
      session.currentModel = modelId;
    },
    async setReasoning() {},
    updateMethods: new Set(['session/update', 'session/notification', '_kiro.dev/session/update']),
    parseUpdate(params) {
      const u = params.update ?? params ?? {};
      const type = u.sessionUpdate ?? u.type ?? '';
      switch (type) {
        case 'agent_message_chunk':
        case 'AgentMessageChunk': {
          const text = u.content?.text ?? u.content ?? u.text ?? '';
          return text ? { kind: 'text', text } : null;
        }
        case 'agent_thought_chunk':
        case 'AgentThoughtChunk': {
          const text = u.content?.text ?? u.content ?? u.text ?? '';
          return text ? { kind: 'thought', text } : null;
        }
        case 'tool_call':
        case 'tool_call_chunk':
          return { kind: 'thought', text: `[tool: ${u.title ?? u.name ?? 'unknown'}]\n` };
        case 'tool_call_update': {
          const out = u.output ?? u.content?.text;
          return out ? { kind: 'thought', text: out } : null;
        }
        case 'plan': {
          const entries = (u.entries ?? []).map(e => e.content ?? e).join('\n');
          return entries ? { kind: 'plan', text: entries } : null;
        }
        default: return { kind: 'unhandled', type };
      }
    },
    dbgSkip(msg) {
      const m = msg.method;
      if (m === 'session/update' || m === 'session/notification' || m === '_kiro.dev/session/update') return 'skip';
      if (m === '_kiro.dev/commands/available') return 'commands';
      if (m === '_kiro.dev/subagent/list_update') return 'skip';
      if (!m && msg.error?.data === 'ping') return 'skip';
      return null;
    },
  }),
  codex: (env) => ({
    name:  'codex',
    label: 'codex-acp',
    cmd:   env.CODEX_CMD ?? 'codex-acp',
    args:  (env.CODEX_ARGS ?? '').split(' ').filter(Boolean),
    clientName: 'acp-proxy',
    requiresAuthWhenRemote: true,
    sendInitialized: true,
    mode: env.CODEX_MODE ?? 'full-access',
    defaultModel: env.CODEX_MODEL_DEFAULT ?? 'gpt-5.5',
    fallbackModels: (env.CODEX_AVAILABLE_MODELS ?? 'gpt-5.5,gpt-5.4,gpt-5.4-mini').split(',').map(s => s.trim()).filter(Boolean),
    buildEnv(parent) {
      // codex-acp authenticates via codex's own login over ACP; OPENAI_API_KEY is
      // optional and passed through only when present (API-key auth). Not required.
      return { ...parent };
    },
    formatStartupModels(ids) { return [...new Set(ids)]; },
    async postNewSession(session) {
      if (!session.sessionId || !this.mode) return;
      await session._reqSafe('mode', 'session/set_mode', { sessionId: session.sessionId, modeId: this.mode });
    },
    async setModel(session, modelId) {
      if (!modelId || modelId === 'auto' || modelId === session.currentModel) return;
      await session._reqSafe('model', 'session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: modelId });
      session.currentModel = modelId;
    },
    async setReasoning(session, effort) {
      if (!effort) return;
      await session._reqSafe('reasoning', 'session/set_config_option', { sessionId: session.sessionId, configId: 'reasoning_effort', value: effort });
    },
    updateMethods: new Set(['session/update', 'session/notification']),
    parseUpdate(params) {
      const u = params.update ?? params ?? {};
      let type = u.sessionUpdate ?? u.type ?? '';
      let payload = u;
      if (!type) {
        const keys = Object.keys(u).filter(k => k !== 'sessionId');
        if (keys.length >= 1) { type = keys[0]; payload = u[type] ?? u; }
      }
      switch (type) {
        case 'agent_message_chunk':
        case 'AgentMessageChunk': {
          const text = payload.content?.text ?? payload.content ?? payload.text ?? u.content?.text ?? u.content ?? u.text ?? '';
          return text ? { kind: 'text', text } : null;
        }
        case 'agent_thought_chunk':
        case 'AgentThoughtChunk': {
          const text = payload.content?.text ?? payload.content ?? payload.text ?? u.content?.text ?? u.content ?? u.text ?? '';
          return text ? { kind: 'thought', text } : null;
        }
        case 'tool_call':
        case 'tool_call_chunk':
        case 'ToolCall':
          return { kind: 'thought', text: `[tool: ${payload.title ?? payload.name ?? u.title ?? u.name ?? 'unknown'}]\n` };
        case 'tool_call_update':
        case 'ToolCallUpdate': {
          const out = payload.output ?? payload.content?.text ?? u.output ?? u.content?.text;
          return out ? { kind: 'thought', text: out } : null;
        }
        case 'plan':
        case 'Plan': {
          const entries = (payload.entries ?? u.entries ?? []).map(e => e.content ?? e).join('\n');
          return entries ? { kind: 'plan', text: entries } : null;
        }
        case 'UsageUpdate':
        case 'usage_update': {
          const pt = payload.promptTokens ?? payload.prompt_tokens ?? u.promptTokens ?? u.prompt_tokens;
          const ct = payload.completionTokens ?? payload.completion_tokens ?? u.completionTokens ?? u.completion_tokens;
          return pt != null ? { kind: 'usage', promptTokens: pt, completionTokens: ct ?? 0 } : null;
        }
        default: return { kind: 'unhandled', type };
      }
    },
    dbgSkip(msg) {
      const m = msg.method;
      if (m === 'session/update' || m === 'session/notification') return 'skip';
      if (!m && (msg.error?.data === 'ping' || msg.error?.code === -32601)) return 'skip';
      return null;
    },
  }),
};
// <<< BACKENDS

const DEFAULT_BACKEND = 'codex';
const _backendArg  = process.argv.find(a => a.startsWith('--backend='))?.split('=')[1];
const BACKEND_NAME = ((_backendArg ?? '').trim().toLowerCase()) || DEFAULT_BACKEND;
if (!BACKENDS[BACKEND_NAME]) {
  console.error(`[startup] ERROR: unknown --backend="${BACKEND_NAME}" (expected: ${Object.keys(BACKENDS).join('|')})`);
  process.exit(1);
}
const PROFILE = BACKENDS[BACKEND_NAME](process.env);

// Remote binding safety gate — a full-access backend must have auth when not on localhost
if (PROFILE.requiresAuthWhenRemote && HOST !== '127.0.0.1' && HOST !== 'localhost' && ACP_API_KEYS.length === 0 && !ALLOW_INSECURE) {
  console.error(`[startup] ERROR: HOST=${HOST} with no ACP_API_KEY is unsafe for the ${PROFILE.name} backend (full-access agent).`);
  console.error(`[startup] Set ACP_API_KEY or set ALLOW_INSECURE_REMOTE=1 to override.`);
  process.exit(1);
}

// ─── Logging ──────────────────────────────────────────────────────────────────

// Debug log file — created at startup when DEBUG=1, captures ALL output.
let _logStream = null;
let _logPath   = null;

if (DEBUG) {
  const logDir = process.env.LOG_DIR ?? path.join(process.cwd(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  _logPath   = path.join(logDir, `acp-codex-${stamp}.log`);
  _logStream = fs.createWriteStream(_logPath, { flags: 'a', encoding: 'utf8' });
  _logStream.write(`=== acp-codex debug log  pid=${process.pid}  started=${new Date().toISOString()} ===\n`);
  process.stderr.write(`[startup] debug log → ${_logPath}\n`);
}

function ts() { return new Date().toISOString().replace(/(\.\d{3})Z$/, (_, ms) => ms + '000Z'); }

// Write to the log file only (no stderr/stdout). Used for verbose messages that
// would flood the console but are valuable for offline analysis.
function _fileLine(line) { _logStream?.write(line + '\n'); }

function log(tag, ...args) {
  const line = `${ts()} [${tag}] ${args.join(' ')}`;
  console.log(line);
  _fileLine(line);
}

function dbg(tag, ...args) {
  if (!DEBUG) return;
  const line = `${ts()} [DBG:${tag}] ${args.join(' ')}`;
  process.stderr.write(line + '\n');
  _fileLine(line);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId()         { return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`; }
function makeToolCallId() { return `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`; }
function makeReqId()      { return `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`; }
function nowSec()         { return Math.floor(Date.now() / 1000); }

// OpenAI reasoning_effort values that pass through to the backend (codex maps these
// to ReasoningEffort; 'none'/'xhigh' are codex extensions accepted if a client sends them).
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

// Server-side default reasoning effort applied when a request omits reasoning_effort.
// Defaults to 'low' for low TTFT — the reasoning pass is the dominant first-token cost
// on codex reasoning models, and 'low' is the lowest effort the codex-acp 0.16.0 default
// preset accepts ('minimal'/'none' are rejected per the capability probe). Set
// CODEX_REASONING_EFFORT= (empty) to disable, or a higher tier to trade latency for depth.
// Invalid/unsupported values no-op via _reqSafe. kiro ignores it.
const _reasoningDefaultEnv = process.env.CODEX_REASONING_EFFORT ?? 'low';
const REASONING_DEFAULT = REASONING_EFFORTS.has(_reasoningDefaultEnv) ? _reasoningDefaultEnv : null;

// ─── Latency instrumentation (Phase 0) ────────────────────────────────────────
// Threaded `marks` objects collect process.hrtime.bigint() stamps across the
// request lifecycle; recordTiming() turns them into a machine-readable split.

function _ns2ms(a, b) {
  return a != null && b != null ? Number((Number(b - a) / 1e6).toFixed(1)) : null;
}

const _timings = [];           // ring buffer of recent splits (DEBUG only)
const _TIMINGS_MAX = 200;

function recordTiming(marks, meta) {
  const m = marks;
  const rec = {
    rid:    meta.rid,
    model:  meta.model,
    mode:   meta.mode,
    tools:  meta.tools,
    stream: meta.stream,
    acquire_ms:       _ns2ms(m.t_req_start, m.t_acquired),
    session_new_ms:   _ns2ms(m.t_acquired, m.t_session_created),
    set_mode_ms:      _ns2ms(m.t_session_created, m.t_post_session),
    set_model_ms:     _ns2ms(m.t_post_session ?? m.t_acquired, m.t_set_model),
    prefill_ms:       _ns2ms(m.t_prompt_sent, m.t_first_update),
    thought_gap_ms:   _ns2ms(m.t_first_update, m.t_first_thought),
    reasoning_gap_ms: _ns2ms(m.t_first_update, m.t_first_text),
    gen_ms:           _ns2ms(m.t_first_text, m.t_complete),
    total_ms:         _ns2ms(m.t_req_start, m.t_complete),
  };
  if (DEBUG) {
    _timings.push(rec);
    if (_timings.length > _TIMINGS_MAX) _timings.shift();
    dbg('timing', JSON.stringify(rec));
  }
  return rec;
}

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
    .filter(b => b.type === 'resource_link' && typeof b.uri === 'string')
    .map(b => b.uri.replace(/^file:\/\//, ''))
    .map(p => path.posix.dirname(p));
  if (!dirs.length) return fallback;
  if (dirs.length === 1) return dirs[0];
  const split = dirs.map(d => d.split('/'));
  const common = [];
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i];
    if (split.every(s => s[i] === seg)) common.push(seg); else break;
  }
  return common.join('/') || fallback;
}

function apiError(res, status, message, type = 'api_error', param = null, code = null) {
  return res.status(status).json({ error: { message, type, param, code } });
}

function inferMimeType(b64) {
  const head = b64.slice(0, 8);
  if (head.startsWith('/9j/'))      return 'image/jpeg';
  if (head.startsWith('iVBORw0K')) return 'image/png';
  if (head.startsWith('R0lGOD'))   return 'image/gif';
  if (head.startsWith('UklGR'))    return 'image/webp';
  return 'image/jpeg';
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
  return String(c ?? '');
}

function tryParseJson(str) {
  try { return JSON.parse(str?.trim()); } catch { return null; }
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
  if (!Object.keys(args).length) {
    const pos = argsStr.trim().match(/^"((?:[^"\\]|\\.)*)"$/s);
    if (pos) {
      const firstKey = Object.keys(toolDef?.function?.parameters?.properties ?? {})[0];
      if (firstKey) { try { args[firstKey] = JSON.parse(`"${pos[1]}"`); } catch { args[firstKey] = pos[1]; } }
    }
  }
  return args;
}

async function cancelWithGrace(client, graceMs = 3000) {
  if (!client?.alive) return;
  client.cancel();
  if (client._pending.size === 0) return;
  await new Promise(resolve => {
    const t = setTimeout(resolve, graceMs);
    const iv = setInterval(() => {
      if (client._pending.size === 0) { clearInterval(iv); clearTimeout(t); resolve(); }
    }, 50);
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
    this.sessionCwd = null;          // cwd the active session was created with (pool reuse)
    this._sessionConsumed = false;   // true once a stateless turn has used this session
    this._pingTimer = null;
    this._dead      = false;
  }

  async start() {
    this._proc = spawn(PROFILE.cmd, PROFILE.args, {
      cwd:   CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      env:   PROFILE.buildEnv(process.env),
    });
    this._proc.stderr.on('data', d => dbg(`${PROFILE.name}:${this.label}`, String(d).trim()));
    this._proc.once('exit', code => {
      this._dead = true;
      this._stopPing();
      log(`proc:${this.label}`, `exited (${code}), failing ${this._pending.size} pending`);
      for (const [, { reject }] of this._pending) reject(new Error(`${PROFILE.label} exited (${code})`));
      this._pending.clear();
      this.emit('dead');
    });
    this._rl = readline.createInterface({ input: this._proc.stdout });
    this._rl.on('line', line => {
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
      this._proc.once('exit', c => { if (!done) { done = true; rej(new Error(`died at startup (${c})`)); } });
    });
  }

  _send(msg) {
    if (this._dead) throw new Error('Cannot send to dead process');
    const line = JSON.stringify(msg) + '\n';
    if (DEBUG) {
      // File: log every outgoing message including ping
      _fileLine(`${ts()} [ACP→${this.label}] ${line.length > 2001 ? line.slice(0, 2000) + '…' : line.trimEnd()}`);
      // Stderr: skip ping to keep console readable
      if (msg.method !== 'ping')
        process.stderr.write(`${ts()} [DBG:→${this.label}] ${line.length > 301 ? line.slice(0, 300) + '…' : line.trimEnd()}\n`);
    }
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
    const raw = JSON.stringify(msg);
    // File: log every incoming message at full length (up to 4 KB)
    _fileLine(`${ts()} [ACP←${this.label}] ${raw.length > 4001 ? raw.slice(0, 4000) + '…' : raw}`);
    // Stderr: skip high-volume streaming noise / ping (per-backend filter)
    const skip = PROFILE.dbgSkip(msg);
    if (skip === 'skip') return;
    if (skip === 'commands') {
      const p = msg.params ?? {};
      process.stderr.write(`${ts()} [DBG:←${this.label}] commands/available  commands=${p.commands?.length ?? 0}  tools=${p.tools?.length ?? 0}  mcp=${p.mcpServers?.length ?? 0}\n`);
      return;
    }
    process.stderr.write(`${ts()} [DBG:←${this.label}] ${raw.length > 301 ? raw.slice(0, 300) + '…' : raw}\n`);
  }

  _route(msg) {
    // Request/response routing
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }

    // Permission auto-grant
    if (msg.method === 'session/request_permission') {
      this._send({ jsonrpc: '2.0', id: msg.id, result: { optionId: 'allow_always', granted: true } });
      return;
    }

    // Streaming notifications — the backend profile parses the (varied) shapes
    if (PROFILE.updateMethods.has(msg.method)) {
      const c = PROFILE.parseUpdate(msg.params ?? {});
      if (!c) return;
      if (c.kind === 'unhandled') { dbg(`update:${this.label}`, `unhandled "${c.type}"`); return; }
      this.emit('chunk', c);
    }
  }

  // Like _req, but catches+logs instead of throwing — used for best-effort calls.
  async _reqSafe(tag, method, params) {
    try { return await this._req(method, params); }
    catch (e) { log(`${tag}:${this.label}`, `${method} failed (${e.message})`); }
  }

  async initialize() {
    const result = await this._req('initialize', {
      protocolVersion: 1,
      clientInfo: { name: PROFILE.clientName, version: '1.0.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    const caps = result?.agentCapabilities?.promptCapabilities ?? {};
    this.promptCapabilities = caps;
    dbg(`init:${this.label}`, `promptCapabilities=${JSON.stringify(caps)}`);
    // Codex expects the initialized notification; Kiro rejects it (profile-gated).
    if (PROFILE.sendInitialized) this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this._startPing();
  }

  async newSession(cwd = CWD, timings) {
    const result = await this._req('session/new', { cwd, mcpServers: [] });
    if (timings) timings.t_session_created = process.hrtime.bigint();
    this.sessionCwd       = cwd;
    this._sessionConsumed = false;
    this.sessionId       = result?.sessionId ?? result?.id;
    this.availableModels = result?.models?.availableModels?.map(m => m.modelId) ?? [];
    this.currentModel    = result?.models?.currentModelId ?? 'auto';
    // Backend-specific post-session setup (e.g. codex session/set_mode full-access)
    await PROFILE.postNewSession(this);
    if (timings) timings.t_post_session = process.hrtime.bigint();
    return this.sessionId;
  }

  async setModel(modelId) {
    return PROFILE.setModel(this, modelId);
  }

  async setReasoning(effort) {
    return PROFILE.setReasoning(this, effort);
  }

  async prompt(blocks, onChunk, timings) {
    const chunks = [];
    const handler = c => {
      if (timings) {
        const now = process.hrtime.bigint();
        if (timings.t_first_update  == null) timings.t_first_update  = now;
        if (c.kind === 'thought' && timings.t_first_thought == null) timings.t_first_thought = now;
        if (c.kind === 'text'    && timings.t_first_text    == null) timings.t_first_text    = now;
      }
      chunks.push(c);
      onChunk?.(c);
    };
    this.on('chunk', handler);
    dbg(`prompt:${this.label}`, `streaming…`);
    if (timings) timings.t_prompt_sent = process.hrtime.bigint();
    try {
      await this._req('session/prompt', {
        sessionId: this.sessionId,
        prompt:    blocks,
        content:   blocks,
      });
    } finally {
      this.off('chunk', handler);
    }
    if (timings) timings.t_complete = process.hrtime.bigint();
    dbg(`prompt:${this.label}`, `done  chunks=${chunks.length}`);
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

// ─── Pool ─────────────────────────────────────────────────────────────────────

class ACPPool {
  constructor(size) {
    this._size  = size;
    this._slots = [];
    this._queue = [];
  }

  async warmup() {
    log('pool', `warming ${this._size} ${PROFILE.label} processes…`);
    this._slots = Array.from({ length: this._size }, () => ({ client: null, busy: false }));
    await Promise.all(this._slots.map(s => this._initSlot(s)));
    log('pool', `ready (${this._slots.filter(s => s.client?.alive).length}/${this._size} live)`);
  }

  async _initSlot(slot) {
    try {
      const c = new ACPSession(`pool-${this._slots.indexOf(slot)}`);
      await c.start();
      await c.initialize();
      // POOL_PRECREATE: pre-pay session/new + set_mode at warmup so stateless
      // requests can skip it on their critical path (recycled on release).
      if (POOL_PRECREATE) await c.newSession(CWD);
      c.once('dead', () => { slot.client = null; });
      slot.client = c;
    } catch (e) { log('pool', `slot init failed: ${e.message}`); slot.client = null; }
  }

  async acquire() {
    const free = this._slots.find(s => !s.busy);
    if (free) {
      free.busy = true;
      // Wait for any in-flight background recycle so the handler sees a settled session.
      if (free._recycle) { try { await free._recycle; } catch {} }
      if (!free.client?.alive) await this._initSlot(free);
      return free;
    }
    return new Promise(resolve => this._queue.push(resolve));
  }

  release(slot) {
    slot.busy = false;
    const next = this._queue.shift();
    if (next) {
      slot.busy = true;
      if (!slot.client?.alive) this._initSlot(slot).then(() => next(slot));
      else next(slot);
      return;
    }
    // No waiter: if the slot's session was consumed by a stateless turn, recycle it
    // in the background (fresh session/new) so the next acquirer gets an isolated,
    // already-warm session. The handler still re-creates inline if it grabs it first.
    if (POOL_PRECREATE && slot.client?.alive && slot.client._sessionConsumed) {
      slot._recycle = slot.client.newSession(CWD)
        .catch(e => log('pool', `recycle failed: ${e.message}`))
        .finally(() => { slot._recycle = null; });
    }
  }

  shutdown() { this._slots.forEach(s => s.client?.close()); }

  get stats() {
    return {
      size:   this._size,
      busy:   this._slots.filter(s => s.busy).length,
      alive:  this._slots.filter(s => s.client?.alive).length,
      queued: this._queue.length,
    };
  }
}

// ─── SessionRegistry (with per-session FIFO lock) ─────────────────────────────

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
      await c.start();
      await c.initialize();
      await c.newSession(cwd);
      entry = { client: c, lastUsed: Date.now(), _busy: false, _queue: [] };
      this._map.set(sessionId, entry);
    } else {
      entry.lastUsed = Date.now();
    }

    // Per-session FIFO serialization — prevents concurrent turns on same session
    if (entry._busy) {
      await new Promise(resolve => entry._queue.push(resolve));
    }
    entry._busy = true;

    return {
      client: entry.client,
      release: () => {
        const next = entry._queue.shift();
        if (next) next();
        else entry._busy = false;
      },
    };
  }

  delete(sessionId) {
    const entry = this._map.get(sessionId);
    if (entry) { entry.client.close(); this._map.delete(sessionId); }
  }

  _reap() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, entry] of this._map) {
      if (entry.lastUsed < cutoff) {
        log('registry', `TTL reap ${id}`);
        entry.client.close();
        this._map.delete(id);
      }
    }
  }

  get stats() { return { sessions: this._map.size }; }
}

// ─── Globals ──────────────────────────────────────────────────────────────────

const pool     = new ACPPool(POOL_SIZE);
const registry = new SessionRegistry();

await pool.warmup();

['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    log('shutdown', sig);
    pool.shutdown();
    if (_logStream) { _logStream.write(`=== shutdown  signal=${sig}  at=${new Date().toISOString()} ===\n`); _logStream.end(); }
    process.exit(0);
  });
});

// ─── Message conversion ───────────────────────────────────────────────────────

/**
 * Convert OpenAI-format messages + tools → ACP prompt blocks.
 *
 * Key differences from Ollama format:
 *  - Images: content[].type === 'image_url' with data: URI
 *  - Tool call arguments: JSON string (not plain object)
 *  - Format / tool_choice: OpenAI field names
 */
function buildAcpBlocks(messages, tools, opts = {}) {
  const { response_format, tool_choice } = opts;
  const system = messages.find(m => m.role === 'system');
  const turns  = messages.filter(m => m.role !== 'system');

  let text = '';

  if (system) text += `[System]\n${contentText(system.content)}\n\n`;

  if (response_format?.type === 'json_object') {
    text += `[Output format] Respond ONLY with a valid JSON object. No prose, no markdown fences.\n\n`;
  }

  if (tool_choice === 'required' || tool_choice?.type === 'required') {
    text += `[Tool use] You MUST call a tool in this response. Do not respond with plain text.\n\n`;
  } else if (tool_choice?.type === 'function' && tool_choice.function?.name) {
    text += `[Tool use] You MUST call the "${tool_choice.function.name}" tool in this response.\n\n`;
  }

  if (tools?.length) {
    text += `[Available tools]\n`;
    text += `To call a tool output ONLY this JSON block — no prose, no explanation, nothing else:\n`;
    text += '```json\n{"tool_call": {"name": "<tool_name>", "arguments": {"<param>": "<value>"}}}\n```\n';
    text += 'Rules: (1) ONE tool call per response. (2) No text before or after the JSON block. ';
    text += '(3) Do NOT use ```tool_call``` fences or Python function-call syntax.\n';
    text += 'Available tools:\n';
    text += '```json\n' + JSON.stringify(tools.map(t => t.function ?? t), null, 2) + '\n```\n\n';
  }

  const imageBlocks = [];

  for (const m of turns) {
    if (m.role === 'assistant') {
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          // arguments is a JSON string in OpenAI format
          const args = typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {});
          text += `[Assistant tool call: ${tc.function?.name ?? 'unknown'}]\n${args}\n\n`;
        }
      } else {
        text += `[Assistant]\n${contentText(m.content)}\n\n`;
      }
    } else if (m.role === 'tool') {
      const callId = m.tool_call_id ? ` (id: ${m.tool_call_id})` : '';
      text += `[Tool result${callId}]\n${contentText(m.content)}\n\n`;
    } else {
      // user
      const content = m.content;
      if (Array.isArray(content)) {
        const textContent = content
          .filter(p => p.type === 'text')
          .map(p => p.text ?? '').join('');
        if (textContent) text += `[User]\n${textContent}\n\n`;
        for (const part of content) {
          if (part.type === 'image_url') {
            const url = part.image_url?.url ?? '';
            const m2 = url.match(/^data:([^;]+);base64,(.+)$/);
            if (m2) {
              imageBlocks.push({ type: 'image', mimeType: m2[1], data: m2[2] });
            } else if (url) {
              text += `[User image: ${url}]\n\n`;
            }
          }
        }
      } else {
        text += `[User]\n${contentText(content)}\n\n`;
      }
    }
  }

  return [{ type: 'text', text: text.trimEnd() }, ...imageBlocks];
}

// ─── Response builders ────────────────────────────────────────────────────────

/**
 * Reassemble ACP chunks into an OpenAI message object.
 * tool_calls[].function.arguments is a JSON string (OpenAI format).
 */
function chunksToOpenAIMessage(chunks) {
  const textParts = [];
  const toolCallMap = new Map();
  let promptTokens = 0, completionTokens = 0;

  for (const c of chunks) {
    if (c.kind === 'text')    textParts.push(c.text);
    if (c.kind === 'tool_call_start') {
      const key = c.toolCallId ?? `tc-${toolCallMap.size}`;
      toolCallMap.set(key, { id: makeToolCallId(), name: c.name ?? 'unknown', argsParts: [] });
    }
    if (c.kind === 'tool_call_update' && c.toolCallId) {
      const tc = toolCallMap.get(c.toolCallId);
      if (tc && c.output) tc.argsParts.push(c.output);
    }
    if (c.kind === 'usage') {
      promptTokens     = c.promptTokens     ?? promptTokens;
      completionTokens = c.completionTokens ?? completionTokens;
    }
  }

  const content = textParts.join('') || '';

  let tool_calls = null;
  if (toolCallMap.size > 0) {
    tool_calls = [...toolCallMap.values()].map(tc => {
      const raw = tc.argsParts.join('');
      let argsJson;
      try { JSON.parse(raw); argsJson = raw || '{}'; }
      catch { argsJson = '{}'; }
      return { id: tc.id, type: 'function', function: { name: tc.name, arguments: argsJson } };
    });
  }

  return { content, tool_calls, promptTokens, completionTokens };
}

function buildChatCompletion(id, model, content, tool_calls, promptTokens, completionTokens) {
  return {
    id,
    object:  'chat.completion',
    created: nowSec(),
    model,
    choices: [{
      index:   0,
      message: {
        role:    'assistant',
        content: content || null,
        ...(tool_calls ? { tool_calls } : {}),
      },
      finish_reason: tool_calls?.length ? 'tool_calls' : 'stop',
      logprobs: null,
    }],
    usage: {
      prompt_tokens:     promptTokens,
      completion_tokens: completionTokens,
      total_tokens:      promptTokens + completionTokens,
    },
  };
}

function makeDeltaChunk(id, model, delta, finish_reason = null) {
  return {
    id,
    object:  'chat.completion.chunk',
    created: nowSec(),
    model,
    choices: [{ index: 0, delta, finish_reason, logprobs: null }],
  };
}

function setSSEHeaders(res) {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

function sseData(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }
function sseDone()    { return 'data: [DONE]\n\n'; }

// ─── Tool call coercion ───────────────────────────────────────────────────────

/**
 * Detect tool calls in model output (OpenAI format: arguments as JSON string).
 */
function coerceToolCall(message, tools) {
  if (!tools?.length || message.tool_calls) return message;
  const content = message.content?.trim();
  if (!content) return message;

  let parsed = tryParseJson(content);

  if (!parsed) {
    const m = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (m) parsed = tryParseJson(m[1]);
  }

  if (parsed?.tool_call?.name) {
    const tc = parsed.tool_call;
    dbg('coerce', `tool_call wrapper → "${tc.name}"`);
    return {
      ...message, content: '',
      tool_calls: [{
        id: makeToolCallId(), type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      }],
    };
  }

  if (!parsed) {
    const tcFence = content.match(/```tool_call\s*\n(\w+)\(([\s\S]*?)\)\s*\n```/);
    if (tcFence) {
      const name = tcFence[1];
      const tool = tools.find(t => (t.function?.name ?? t.name) === name);
      if (tool) {
        const args = parsePyFnCallArgs(tcFence[2], tool);
        dbg('coerce', `tool_call fence → "${name}"`);
        return {
          ...message, content: '',
          tool_calls: [{
            id: makeToolCallId(), type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        };
      }
    }
  }

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
        return {
          ...message, content: '',
          tool_calls: [{
            id: makeToolCallId(), type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        };
      }
    }
  }

  if (!parsed) return message;

  const tool = pickBestTool(parsed, tools);
  const name = tool?.function?.name ?? tool?.name;
  if (!name) return message;
  dbg('coerce', `plain JSON → tool_call "${name}"`);
  return {
    ...message, content: '',
    tool_calls: [{
      id: makeToolCallId(), type: 'function',
      function: { name, arguments: JSON.stringify(parsed) },
    }],
  };
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
    // Log full request body to file for offline analysis
    if (_logStream && req.body) {
      const bodyStr = JSON.stringify(req.body);
      _fileLine(`${ts()} [HTTP→] ${req.method} ${req.path}  rid=${req.id}  body=${bodyStr.length > 4000 ? bodyStr.slice(0, 4000) + '…' : bodyStr}`);
    }
    res.on('finish', () => {
      const model = req.body?.model ?? '-';
      const dur   = Date.now() - t0;
      const line  = `${req.method} ${req.path}  model=${model}  ${res.statusCode}  ${dur}ms  rid=${req.id}`;
      log('req', line);
    });
    next();
  });
}

// Auth + IP allowlist — /health and / are always open
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/health') return next();
  if (DEBUG && req.path === '/debug/timings') return next();

  if (ALLOWED_IPS.length > 0) {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '').replace('::ffff:', '');
    if (!ALLOWED_IPS.includes(ip)) return apiError(res, 403, `IP ${ip} not in allowlist`, 'invalid_request_error');
  }

  if (ACP_API_KEYS.length > 0) {
    const hdr = req.headers['authorization'] ?? '';
    const m   = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m || !ACP_API_KEYS.includes(m[1])) return apiError(res, 401, 'Invalid or missing API key', 'invalid_request_error', null, 'invalid_api_key');
  }

  next();
});

// ── Identity / health ─────────────────────────────────────────────────────────

app.get('/', (_, res) => res.json({ object: 'codex-acp-proxy', version: '1.0.0' }));

app.get('/health', (_, res) => {
  res.json({ status: 'ok', pool: pool.stats, registry: registry.stats });
});

// Latency split ring buffer (Phase 0) — DEBUG only, unauthenticated like /health
if (DEBUG) {
  app.get('/debug/timings', (_, res) => {
    res.json({ object: 'list', count: _timings.length, data: _timings });
  });
}

// ── Models ────────────────────────────────────────────────────────────────────

app.get('/v1/models', (_, res) => {
  res.json({
    object: 'list',
    data: _startupModels.map(id => ({
      id,
      object:   'model',
      created:  nowSec(),
      owned_by: PROFILE.name,
    })),
  });
});

// ── Chat completions ──────────────────────────────────────────────────────────

app.post('/v1/chat/completions', async (req, res) => {
  const {
    model = PROFILE.defaultModel,
    messages = [],
    stream = false,
    tools,
    tool_choice,
    response_format,
    reasoning_effort,
    // Accepted and silently ignored (off-the-shelf clients don't 400):
    // temperature, max_tokens, top_p, seed, stop, n, logprobs,
    // parallel_tool_calls, stream_options, user, service_tier
  } = req.body ?? {};

  // Map OpenAI reasoning_effort onto the backend's reasoning config. Codex accepts
  // none|minimal|low|medium|high|xhigh; the backend validates against the model
  // preset and a _reqSafe no-ops if unsupported. A request value wins; otherwise the
  // server default (REASONING_DEFAULT) applies. Unknown request values fall back too.
  const effort = (REASONING_EFFORTS.has(reasoning_effort) ? reasoning_effort : null) ?? REASONING_DEFAULT;

  if (!Array.isArray(messages) || !messages.length) {
    return apiError(res, 400, '`messages` is required and must be a non-empty array',
      'invalid_request_error', 'messages');
  }

  const blocks    = buildAcpBlocks(messages, tools, { response_format, tool_choice });
  const cwd       = req.headers['x-working-dir'] ?? pickCwd(blocks, CWD);
  const sessionId = req.headers['x-session-id'] ?? (AUTO_SESSION_HASH ? autoSessionId(messages) : null);
  const id        = makeId();

  let client, release, slot;
  const marks = { t_req_start: process.hrtime.bigint() };

  try {
    if (sessionId) {
      ({ client, release } = await registry.acquire(sessionId, cwd));
      marks.t_acquired = process.hrtime.bigint();
      await client.setModel(model);
      await client.setReasoning(effort);
      marks.t_set_model = process.hrtime.bigint();
    } else {
      slot   = await pool.acquire();
      client = slot.client;
      marks.t_acquired = process.hrtime.bigint();
      // Reuse a pre-created, unconsumed session for the same cwd (POOL_PRECREATE);
      // otherwise create one now. Either way the turn consumes it (recycled on release).
      const reuse = POOL_PRECREATE && client.sessionId && !client._sessionConsumed && client.sessionCwd === cwd;
      if (!reuse) await client.newSession(cwd, marks);
      client._sessionConsumed = true;
      await client.setModel(model);
      await client.setReasoning(effort);
      marks.t_set_model = process.hrtime.bigint();
    }
  } catch (err) {
    if (slot) pool.release(slot);
    return apiError(res, 503, `ACP backend unavailable: ${err.message}`, 'api_error');
  }

  const timingMeta = { rid: req.id, model, mode: PROFILE.mode, tools: !!tools?.length, stream };

  // Timeout race
  let timedOut = false;
  const timeoutPromise = MAX_EXEC_MS > 0
    ? new Promise((_, reject) => setTimeout(() => { timedOut = true; reject(new Error('prompt_timeout')); }, MAX_EXEC_MS))
    : new Promise(() => {});

  try {
    if (stream) {
      setSSEHeaders(res);

      // Role announcement delta
      res.write(sseData(makeDeltaChunk(id, model, { role: 'assistant', content: '' })));

      const allChunks    = [];
      let disconnected   = false;
      let releaseOnClose = null;

      req.on('close', async () => {
        if (!res.writableEnded) {
          disconnected = true;
          await cancelWithGrace(client, 3000);
          releaseOnClose?.();
          releaseOnClose = null;
        }
      });

      const streamPromise = (async () => {
        await client.prompt(blocks, chunk => {
          if (disconnected || timedOut) return;
          allChunks.push(chunk);
          if (!res.writable) return;
          // When tools requested, buffer all output for coercion at end
          if (tools?.length) return;
          if (chunk.kind === 'text') {
            res.write(sseData(makeDeltaChunk(id, model, { content: chunk.text })));
          }
        }, marks);

        if (disconnected || timedOut) return;

        const raw     = chunksToOpenAIMessage(allChunks);
        const message = coerceToolCall(raw, tools);

        // Flush buffered content when tools were present
        if (tools?.length && message.content) {
          res.write(sseData(makeDeltaChunk(id, model, { content: message.content })));
        }

        // Stream tool call deltas
        if (message.tool_calls?.length) {
          for (let i = 0; i < message.tool_calls.length; i++) {
            const tc = message.tool_calls[i];
            res.write(sseData(makeDeltaChunk(id, model, {
              tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }],
            })));
            res.write(sseData(makeDeltaChunk(id, model, {
              tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }],
            })));
          }
        }

        const finishReason = message.tool_calls?.length ? 'tool_calls' : 'stop';
        res.write(sseData(makeDeltaChunk(id, model, {}, finishReason)));
        res.write(sseDone());
        res.end();
      })();

      releaseOnClose = release; // capture for disconnect handler

      await Promise.race([streamPromise, timeoutPromise]);

      if (!disconnected && !timedOut) recordTiming(marks, timingMeta);

    } else {
      const promptPromise = client.prompt(blocks, undefined, marks);
      const chunks        = await Promise.race([promptPromise, timeoutPromise]);

      if (timedOut) {
        return apiError(res, 504, 'Request timed out', 'timeout', null, 'timeout');
      }

      const raw     = chunksToOpenAIMessage(chunks);
      const message = coerceToolCall(raw, tools);

      const timing           = recordTiming(marks, timingMeta);
      const elapsed          = timing.total_ms ?? Number(process.hrtime.bigint() - marks.t_req_start) / 1e6;
      const promptTxt        = blocks.map(b => b.text ?? '').join('');
      const promptTokens     = message.promptTokens     || estimateTokens(promptTxt);
      const completionTokens = message.completionTokens || estimateTokens(message.content);

      dbg('resp', `elapsed=${elapsed.toFixed(0)}ms  content=${JSON.stringify(message.content?.slice(0, 80))}  tool_calls=${JSON.stringify(message.tool_calls ?? null)}`);

      res.json(buildChatCompletion(id, model, message.content, message.tool_calls, promptTokens, completionTokens));
    }
  } catch (err) {
    if (err.message === 'prompt_timeout' || timedOut) {
      await cancelWithGrace(client, 3000);
      if (!res.headersSent) {
        return apiError(res, 504, `Request timed out after ${MAX_EXEC_MS}ms`, 'timeout', null, 'timeout');
      }
      if (stream && res.writable && !res.writableEnded) { res.write(sseDone()); res.end(); }
    } else {
      log('error', err.message);
      if (!res.headersSent) apiError(res, 500, err.message, 'api_error');
    }
  } finally {
    release?.();
    if (slot) pool.release(slot);
  }
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  log('uncaught', err.message);
  if (!res.headersSent) apiError(res, 500, err.message, 'api_error');
});

// ─── Start ────────────────────────────────────────────────────────────────────

let _startupModels = PROFILE.fallbackModels;

// Try to discover models dynamically from the running binary
try {
  const slot = await pool.acquire();
  try {
    await slot.client.newSession(CWD);
    const ids = slot.client.availableModels ?? [];
    if (ids.length) {
      _startupModels = PROFILE.formatStartupModels(ids);
      log('startup', `discovered ${_startupModels.length} models from ${PROFILE.label}: ${_startupModels.join(', ')}`);
    } else {
      log('startup', `session/new returned no model list — using fallback models (${_startupModels.join(', ')})`);
      log('startup', `  (set DEBUG=1 to see the raw session/new response and verify the field path)`);
    }
  } finally { pool.release(slot); }
} catch (e) {
  log('startup', `model discovery failed (${e.message}) — using fallback models (${_startupModels.join(', ')})`);
}

const server = app.listen(PORT, HOST, () => {
  if (_logStream) {
    // Dump redacted config to log file for debugging context
    const cfg = {
      PORT, HOST, POOL_SIZE, SESSION_TTL_MS, MAX_EXEC_MS, PING_INTERVAL_MS,
      backend: PROFILE.name, cmd: PROFILE.cmd, cwd: CWD.slice(0, 80),
      mode: PROFILE.mode, defaultModel: PROFILE.defaultModel, fallbackModels: PROFILE.fallbackModels,
      AUTO_SESSION_HASH, DEBUG,
      ACP_API_KEY_SET: ACP_API_KEYS.length > 0,
      ALLOWED_IPS: ALLOWED_IPS,
      OPENAI_API_KEY_SET: !!(process.env.OPENAI_API_KEY),
      models: _startupModels,
    };
    _logStream.write(`=== config ${JSON.stringify(cfg)} ===\n`);
  }

  const keyDisplay = ACP_API_KEYS.length
    ? ACP_API_KEYS.map(t => `${t.slice(0, 18)}…`).join(', ')
    : 'OPEN (no ACP_API_KEY set)';
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│  ACP → OpenAI Proxy  v1.0  —  http://${HOST}:${PORT}
│  Backend: ${PROFILE.name} (${PROFILE.cmd})
│  Auth:    ${keyDisplay}
│  IP ACL:  ${ALLOWED_IPS.length ? ALLOWED_IPS.join(', ') : 'open'}
│  Mode:    ${DEBUG ? 'DEBUG' : 'production'}  |  Pool: ${POOL_SIZE} workers  |  Ping: ${PING_INTERVAL_MS / 1000}s
│  Models:  ${_startupModels.join(', ')}
│  TTL:     session=${SESSION_TTL_MS / 60000}min  exec_max=${MAX_EXEC_MS / 60000}min
│  Session: ${AUTO_SESSION_HASH ? 'auto (system-prompt hash)' : 'stateless pool (set AUTO_SESSION_HASH=1 to persist)'}${_logPath ? `\n│  Log:     ${_logPath}` : ''}
└─────────────────────────────────────────────────────────────┘`.trimStart());
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[start] Port ${PORT} already in use — is another instance running?`);
  } else {
    console.error('[start] Server error:', err.message);
  }
  process.exit(1);
});
