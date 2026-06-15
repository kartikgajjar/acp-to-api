// ─── codex-appserver backend ───────────────────────────────────────────────────
//
// Native OpenAI `codex app-server` backend (proprietary JSON-RPC), as an
// alternative to the third-party `codex-acp` ACP adapter used by the `codex`
// backend. This is a SEPARATE protocol family from ACP, so it lives in its own
// session class rather than the shared ACPSession:
//
//   • Wire format is "JSON-RPC lite": the `jsonrpc` field is omitted on the wire.
//   • Session = thread/start (returns thread.id), used as our sessionId.
//   • Turn = turn/start, which returns IMMEDIATELY ({turn.id, status:inProgress});
//     completion is the async `turn/completed` notification (turn.status).
//   • Cancel = turn/interrupt {threadId, turnId}.
//   • Streaming = item/agentMessage/delta (text), item/reasoning/*Delta (thought),
//     thread/tokenUsage/updated (usage).
//   • Approvals are server-initiated requests (item/*/requestApproval) — auto-accepted.
//   • Per-turn model + reasoning effort are fields on turn/start (not session-level).
//   • Auth reuses the existing `codex` CLI login (no API key required).
//
// Shapes verified against codex-cli 0.139.0 via `codex app-server generate-ts`.
//
// AppServerSession implements the exact public contract the pool/registry/REST
// layers consume from ACPSession: start, initialize, newSession, setModel,
// setReasoning, prompt, cancel, close; props sessionId, sessionCwd,
// _sessionConsumed, availableModels, currentModel, _pending, _turns, alive;
// events 'chunk' and 'dead'. It receives module-level deps via the ctx arg
// (the interface files' globals are not visible from here).

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import readline from 'readline';

// Map the codex permission mode to app-server thread config. Mirrors the
// `CODEX_MODE`/`CODEX_APPSERVER_MODE` semantics of the codex-acp backend.
function threadConfigForMode(mode) {
  switch ((mode || 'full-access').trim()) {
    case 'read-only':
      return { sandbox: 'read-only', approvalPolicy: 'never' };
    case 'auto':
    case 'workspace-write':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
    default: // 'full-access'
      return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
  }
}

export function makeAppServerProfile(env) {
  return {
    name: 'codex-appserver',
    label: 'codex-app-server',
    cmd: env.CODEX_APPSERVER_CMD ?? 'codex',
    args: (env.CODEX_APPSERVER_ARGS ?? 'app-server').split(' ').filter(Boolean),
    clientName: 'acp-proxy',
    // Full-access agent proxy → must have auth when bound beyond localhost.
    requiresAuthWhenRemote: true,
    // `mode` is informational for the config dump and drives the thread sandbox
    // (read-only | auto/workspace-write | full-access) via threadConfigForMode.
    mode: env.CODEX_APPSERVER_MODE ?? 'full-access',
    defaultModel: env.CODEX_APPSERVER_MODEL_DEFAULT ?? 'gpt-5.5',
    // 'auto' resolves to this lean model instead of the heavy default (low latency).
    autoModel: env.CODEX_APPSERVER_AUTO_MODEL ?? 'gpt-5.4-mini',
    fallbackModels: (env.CODEX_APPSERVER_AVAILABLE_MODELS ?? 'gpt-5.5,gpt-5.4,gpt-5.4-mini')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    buildEnv(parent) {
      // codex app-server reuses the codex CLI login; OPENAI_API_KEY is optional
      // and passed through only when present. Pass-through, like the codex backend.
      return { ...parent };
    },
    formatStartupModels(ids) {
      return [...new Set(ids)];
    },
    // SessionClass is attached in the BACKENDS map entry (AppServerSession).
  };
}

export class AppServerSession extends EventEmitter {
  constructor(label = 'anon', ctx = {}) {
    super();
    this.label = label;
    // Injected deps (interface-file globals are not visible from this module).
    this._profile = ctx.profile ?? {};
    this._cwd = ctx.cwd ?? process.cwd();
    this._debug = !!ctx.debug;
    this._log = ctx.log ?? (() => {});
    this._dbg = ctx.dbg ?? (() => {});

    this._proc = null;
    this._rl = null;
    this._msgId = 0;
    this._pending = new Map(); // our request id → {resolve,reject} (RPC responses)
    this._turns = new Map(); // turn id → {resolve,reject} (turn/completed)
    this._earlyDone = new Map(); // turn id → status (completion seen before await)
    this._activeTurnId = null;

    this.sessionId = null; // = thread id
    this.sessionCwd = null;
    this._sessionConsumed = false;
    this.availableModels = [];
    this.currentModel = this._profile.defaultModel ?? 'auto';
    this._pendingModel = null; // per-turn model override (consumed by turn/start)
    this._pendingEffort = null; // per-turn reasoning effort override

    this._dead = false;
  }

  get alive() {
    return !this._dead && this._proc && !this._proc.killed;
  }

  async start() {
    // On Windows a bare command (e.g. `codex`, an npm shim) is a .cmd/.ps1 and
    // cannot be spawned directly — run it through the shell. An explicit path
    // (absolute, or with an .exe extension, e.g. the test mock's node.exe) is
    // spawned directly to avoid shell quoting issues.
    const cmd = this._profile.cmd;
    const looksLikePath = cmd.includes('/') || cmd.includes('\\') || /\.(exe|cmd|bat)$/i.test(cmd);
    const useShell = process.platform === 'win32' && !looksLikePath;
    this._proc = spawn(cmd, this._profile.args, {
      cwd: this._cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this._profile.buildEnv(process.env),
      shell: useShell,
    });
    // A spawn failure (e.g. ENOENT) fires 'error', not 'exit' — handle it so the
    // process does not crash on an unhandled error event.
    this._proc.once('error', (e) => {
      this._dead = true;
      const err = new Error(`${this._profile.label} spawn failed (${e.message})`);
      for (const [, { reject }] of this._pending) reject(err);
      for (const [, { reject }] of this._turns) reject(err);
      this._pending.clear();
      this._turns.clear();
      this.emit('dead');
    });
    this._proc.stderr.on('data', (d) =>
      this._dbg(`${this._profile.name}:${this.label}`, String(d).trim()),
    );
    this._proc.once('exit', (code) => {
      this._dead = true;
      const err = new Error(`${this._profile.label} exited (${code})`);
      this._log(
        `proc:${this.label}`,
        `exited (${code}), failing ${this._pending.size} req / ${this._turns.size} turns`,
      );
      for (const [, { reject }] of this._pending) reject(err);
      for (const [, { reject }] of this._turns) reject(err);
      this._pending.clear();
      this._turns.clear();
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
      } catch (e) {
        this._dbg('parse', e.message);
      }
    });
    await new Promise((res, rej) => {
      let done = false;
      const ok = () => {
        if (!done) {
          done = true;
          res();
        }
      };
      this._proc.stdout.once('readable', ok);
      setTimeout(ok, 600);
      this._proc.once('exit', (c) => {
        if (!done) {
          done = true;
          rej(new Error(`died at startup (${c})`));
        }
      });
      this._proc.once('error', (e) => {
        if (!done) {
          done = true;
          rej(new Error(`spawn failed at startup (${e.message})`));
        }
      });
    });
  }

  _send(msg) {
    if (this._dead) throw new Error('Cannot send to dead process');
    // JSON-RPC lite: no `jsonrpc` field on the wire.
    const line = JSON.stringify(msg) + '\n';
    if (this._debug) {
      const short = line.length > 301 ? line.slice(0, 300) + '…' : line.trimEnd();
      this._dbg(`→${this.label}`, short);
    }
    this._proc.stdin.write(line);
  }

  _req(method, params = {}) {
    const id = ++this._msgId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._send({ id, method, params });
    });
  }

  async _reqSafe(tag, method, params) {
    try {
      return await this._req(method, params);
    } catch (e) {
      this._log(`${tag}:${this.label}`, `${method} failed (${e.message})`);
    }
  }

  _dbgLine(msg) {
    if (!this._debug) return;
    // Skip the highest-volume streaming notifications to keep logs readable.
    if (msg.method === 'item/agentMessage/delta' || msg.method === 'item/reasoning/textDelta')
      return;
    const raw = JSON.stringify(msg);
    this._dbg(`←${this.label}`, raw.length > 301 ? raw.slice(0, 300) + '…' : raw);
  }

  _route(msg) {
    // A message with a `method` is a server→client request (has id) or a
    // notification (no id). A message with only an `id` is a response to one
    // of our requests. Discriminate on `method` first so server-request ids
    // (a separate id space) never collide with our pending-request ids.
    if (msg.method) {
      if (msg.id != null) this._handleServerRequest(msg);
      else this._handleNotification(msg);
      return;
    }
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }

  // Auto-approve server-initiated approval requests (full-access proxy). With the
  // default full-access thread config (danger-full-access + approvalPolicy:never)
  // these rarely fire, but we answer them so a turn never hangs.
  _handleServerRequest(msg) {
    const m = msg.method;
    if (m === 'item/commandExecution/requestApproval' || m === 'item/fileChange/requestApproval') {
      this._send({ id: msg.id, result: { decision: 'acceptForSession' } });
    } else if (m === 'execCommandApproval' || m === 'applyPatchApproval') {
      // Legacy approval requests use the ReviewDecision enum.
      this._send({ id: msg.id, result: { decision: 'approved_for_session' } });
    } else {
      // Unknown server request — reply with an error so the server doesn't block.
      this._log(`appserver:${this.label}`, `unhandled server request: ${m}`);
      this._send({
        id: msg.id,
        error: { code: -32601, message: `unhandled server request: ${m}` },
      });
    }
  }

  _handleNotification(msg) {
    const p = msg.params ?? {};
    switch (msg.method) {
      case 'turn/completed': {
        const tid = p.turn?.id;
        const status = p.turn?.status;
        const w = tid != null ? this._turns.get(tid) : null;
        if (w) {
          this._turns.delete(tid);
          if (status === 'failed') w.reject(new Error(p.turn?.error?.message ?? 'turn failed'));
          else w.resolve(); // 'completed' or 'interrupted'
        } else if (tid != null) {
          this._earlyDone.set(tid, status);
        }
        return;
      }
      case 'item/agentMessage/delta':
        if (p.delta) this.emit('chunk', { kind: 'text', text: p.delta });
        return;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        if (p.delta) this.emit('chunk', { kind: 'thought', text: p.delta });
        return;
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage?.last ?? p.tokenUsage?.total;
        if (u)
          this.emit('chunk', {
            kind: 'usage',
            promptTokens: u.inputTokens ?? 0,
            completionTokens: u.outputTokens ?? 0,
          });
        return;
      }
      case 'error':
        this._log(`appserver:${this.label}`, `error notification: ${JSON.stringify(p)}`);
        return;
      default:
        return;
    }
  }

  async initialize() {
    await this._req('initialize', {
      clientInfo: {
        name: this._profile.clientName ?? 'acp-proxy',
        version: '1.0.0',
        title: this._profile.clientName ?? 'acp-proxy',
      },
      capabilities: null,
    });
    // Standard app-server handshake completion.
    this._send({ method: 'initialized' });
    // Best-effort model discovery (used by the startup /v1/models list).
    try {
      const r = await this._req('model/list', {});
      const ids = (r?.data ?? [])
        .filter((m) => !m.hidden)
        .map((m) => m.id ?? m.model)
        .filter(Boolean);
      if (ids.length) this.availableModels = ids;
    } catch (e) {
      this._dbg(`init:${this.label}`, `model/list failed (${e.message})`);
    }
  }

  async newSession(cwd = this._cwd, timings) {
    const cfg = threadConfigForMode(this._profile.mode);
    const r = await this._req('thread/start', { cwd, ...cfg });
    if (timings) timings.t_session_created = process.hrtime.bigint();
    this.sessionCwd = cwd;
    this._sessionConsumed = false;
    this.sessionId = r?.thread?.id ?? r?.thread?.sessionId ?? null;
    this.currentModel = r?.model ?? this._profile.defaultModel ?? 'auto';
    // No per-session post-setup for app-server (mode is applied via thread config).
    if (timings) timings.t_post_session = process.hrtime.bigint();
    return this.sessionId;
  }

  // Per-turn overrides — stashed for the next turn/start (app-server takes model
  // and reasoning effort per turn, not session-wide).
  async setModel(modelId) {
    if (!modelId || modelId === 'auto') return;
    this._pendingModel = modelId;
    this.currentModel = modelId;
  }

  async setReasoning(effort) {
    if (!effort) return;
    this._pendingEffort = effort;
  }

  _buildInput(blocks) {
    const input = [];
    for (const b of blocks ?? []) {
      if (b?.type === 'text') {
        input.push({ type: 'text', text: b.text ?? '', text_elements: [] });
      } else if (b?.type === 'image' && b.data) {
        input.push({
          type: 'image',
          url: `data:${b.mimeType ?? 'image/png'};base64,${b.data}`,
        });
      }
    }
    if (!input.length) input.push({ type: 'text', text: '', text_elements: [] });
    return input;
  }

  async prompt(blocks, onChunk, timings) {
    const chunks = [];
    const handler = (c) => {
      if (timings) {
        const now = process.hrtime.bigint();
        if (timings.t_first_update == null) timings.t_first_update = now;
        if (c.kind === 'thought' && timings.t_first_thought == null) timings.t_first_thought = now;
        if (c.kind === 'text' && timings.t_first_text == null) timings.t_first_text = now;
      }
      chunks.push(c);
      onChunk?.(c);
    };
    this.on('chunk', handler);
    if (timings) timings.t_prompt_sent = process.hrtime.bigint();
    try {
      const params = {
        threadId: this.sessionId,
        input: this._buildInput(blocks),
      };
      if (this._pendingModel) params.model = this._pendingModel;
      if (this._pendingEffort) params.effort = this._pendingEffort;
      // turn/start returns immediately with the turn id; completion is async.
      const res = await this._req('turn/start', params);
      const turnId = res?.turn?.id;
      if (!turnId) throw new Error('turn/start returned no turn id');
      this._activeTurnId = turnId;
      if (this._earlyDone.has(turnId)) {
        const status = this._earlyDone.get(turnId);
        this._earlyDone.delete(turnId);
        if (status === 'failed') throw new Error('turn failed');
      } else {
        await new Promise((resolve, reject) => this._turns.set(turnId, { resolve, reject }));
      }
    } finally {
      this.off('chunk', handler);
      this._activeTurnId = null;
    }
    if (timings) timings.t_complete = process.hrtime.bigint();
    this._dbg(`prompt:${this.label}`, `done chunks=${chunks.length}`);
    return chunks;
  }

  cancel() {
    if (!this.alive || !this.sessionId || !this._activeTurnId) return;
    try {
      this._send({
        method: 'turn/interrupt',
        params: { threadId: this.sessionId, turnId: this._activeTurnId },
      });
    } catch {}
  }

  close() {
    this._dead = true;
    try {
      this._proc?.stdin.end();
      this._proc?.kill();
    } catch {}
  }
}
