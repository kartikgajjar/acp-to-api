/**
 * Cross-backend / cross-interface regression suite.
 *
 * Proves the two axes are decoupled: either REST interface (Ollama / OpenAI)
 * can drive either ACP backend (kiro / codex), selected with --backend=<name>.
 *
 * Each server is spawned as a child process with the selected backend's
 * *_CMD/*_ARGS pointed at test/mock-acp.mjs (a recording mock).
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OLLAMA = path.join(ROOT, 'acp-server-ollama.js');
const OPENAI = path.join(ROOT, 'acp-server-openai.js');
const SHIM = path.join(ROOT, 'acp-server-codex.js');
const MOCK = path.join(__dirname, 'mock-acp.mjs');
const MOCK_APPSRV = path.join(__dirname, 'mock-codex-appserver.mjs');
const SERVERS = { ollama: OLLAMA, openai: OPENAI };

// ─── Harness ────────────────────────────────────────────────────────────────

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitReady(port, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server not ready on :${port} after ${ms}ms`);
}

function baseEnv(backend, port, extra = {}) {
  const env = {
    ...process.env,
    POOL_SIZE: '1',
    PING_INTERVAL: '999999',
    SESSION_TTL_MS: '3600000',
    MOCK_SCENARIO: 'DEFAULT',
    DEBUG: '0',
    ACP_API_KEY: '',
    AUTH_TOKEN: '',
    ALLOWED_IPS: '',
    AUTO_SESSION_HASH: '0',
    HOST: '127.0.0.1',
    OPENAI_API_KEY: 'sk-test',
    PORT: String(port),
    ...extra,
  };
  // Point the selected backend's command at the mock.
  if (backend === 'kiro') {
    env.KIRO_CMD = process.execPath;
    env.KIRO_ARGS = MOCK;
  }
  if (backend === 'codex') {
    env.CODEX_CMD = process.execPath;
    env.CODEX_ARGS = MOCK;
  }
  // codex-appserver speaks the native app-server protocol → its own mock.
  if (backend === 'codex-appserver') {
    env.CODEX_APPSERVER_CMD = process.execPath;
    env.CODEX_APPSERVER_ARGS = MOCK_APPSRV;
  }
  return env;
}

/** Spawn a server, wait until ready. Returns { port, kill }. */
async function startServer({ server, backend, env = {} }) {
  const port = await getFreePort();
  const proc = spawn(process.execPath, [SERVERS[server], `--backend=${backend}`], {
    env: baseEnv(backend, port, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errors = [];
  proc.stderr.on('data', (d) => errors.push(String(d)));
  try {
    await waitReady(port);
  } catch (e) {
    proc.kill('SIGKILL');
    throw new Error(`${e.message}\nstderr: ${errors.slice(0, 8).join('')}`);
  }
  const kill = () =>
    new Promise((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 2500);
    });
  return { port, proc, kill };
}

/**
 * Spawn a server and resolve with its exit code (for startup-failure tests).
 * `flagBackend` allows passing a raw --backend value (e.g. unknown / empty).
 */
async function expectStartupOutcome({ server, backend, flagBackend, env = {} }) {
  const port = await getFreePort();
  const flag = flagBackend !== undefined ? `--backend=${flagBackend}` : `--backend=${backend}`;
  const proc = spawn(process.execPath, [SERVERS[server], flag], {
    env: baseEnv(backend ?? 'kiro', port, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const errors = [];
  proc.stderr.on('data', (d) => errors.push(String(d)));
  const readyP = waitReady(port, 6000)
    .then(() => {
      ready = true;
    })
    .catch(() => {});
  const exitP = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));
  const exitCode = await Promise.race([exitP, readyP.then(() => null)]);
  const result = { ready, exitCode, stderr: errors.join('') };
  try {
    proc.kill('SIGKILL');
  } catch {}
  return result;
}

async function postJson(port, pathname, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** Drive a chat turn and return the assistant text content for either interface. */
async function chatContent(
  server,
  port,
  { model = 'o4-mini', messages = [{ role: 'user', content: 'hi' }] } = {},
) {
  if (server === 'ollama') {
    const { json } = await postJson(port, '/api/chat', {
      model,
      messages,
      stream: false,
    });
    return json?.message?.content ?? '';
  }
  const { json } = await postJson(port, '/v1/chat/completions', {
    model,
    messages,
    stream: false,
  });
  return json?.choices?.[0]?.message?.content ?? '';
}

function toolCalls(server, json) {
  return server === 'ollama' ? json?.message?.tool_calls : json?.choices?.[0]?.message?.tool_calls;
}

// ─── 2×2 protocol matrix ──────────────────────────────────────────────────────

const EXPECT = {
  kiro: { initialized: false, setMode: false, modelMethod: 'set_model' },
  codex: { initialized: true, setMode: true, modelMethod: 'set_config_option' },
};

for (const server of ['ollama', 'openai']) {
  for (const backend of ['kiro', 'codex']) {
    describe(`matrix: ${server} interface + ${backend} backend`, () => {
      let srv;
      before(async () => {
        srv = await startServer({
          server,
          backend,
          env: { MOCK_SCENARIO: 'PROTOCOL' },
        });
      });
      after(async () => {
        await srv?.kill();
      });

      test('drove the backend with the expected ACP protocol', async () => {
        const content = await chatContent(server, srv.port, {
          model: 'o4-mini',
        });
        const seen = JSON.parse(content);
        const exp = EXPECT[backend];
        assert.equal(seen.initialized, exp.initialized, 'notifications/initialized');
        assert.equal(seen.setMode, exp.setMode, 'session/set_mode');
        assert.equal(seen.modelMethod, exp.modelMethod, 'model-switch method');
        assert.equal(seen.modelValue, 'o4-mini', 'model value forwarded');
      });
    });
  }
}

// ─── reasoning_effort maps onto the backend's reasoning config (codex only) ─────

describe('reasoning_effort forwarding', () => {
  // CODEX_REASONING_EFFORT: '' disables the server default so these isolate per-request behavior.
  const isolate = { MOCK_SCENARIO: 'PROTOCOL', CODEX_REASONING_EFFORT: '' };

  test('codex backend forwards reasoning_effort via session/set_config_option', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex',
      env: isolate,
    });
    try {
      const { json } = await postJson(srv.port, '/v1/chat/completions', {
        model: 'o4-mini',
        reasoning_effort: 'minimal',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const seen = JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');
      assert.equal(seen.reasoning, 'minimal', 'reasoning_effort forwarded');
      assert.equal(seen.modelValue, 'o4-mini', 'model value not clobbered by reasoning config');
    } finally {
      await srv.kill();
    }
  });

  test('kiro backend ignores reasoning_effort (no reasoning config sent)', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'kiro',
      env: isolate,
    });
    try {
      const { json } = await postJson(srv.port, '/v1/chat/completions', {
        model: 'o4-mini',
        reasoning_effort: 'minimal',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const seen = JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');
      assert.equal(seen.reasoning, null, 'kiro setReasoning is a no-op');
    } finally {
      await srv.kill();
    }
  });

  test('unknown reasoning_effort value is dropped (no server default → null)', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex',
      env: isolate,
    });
    try {
      const { json } = await postJson(srv.port, '/v1/chat/completions', {
        model: 'o4-mini',
        reasoning_effort: 'bogus',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const seen = JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');
      assert.equal(seen.reasoning, null, 'invalid effort never reaches the backend');
    } finally {
      await srv.kill();
    }
  });

  test('server default CODEX_REASONING_EFFORT applies when request omits it', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex',
      env: { MOCK_SCENARIO: 'PROTOCOL', CODEX_REASONING_EFFORT: 'low' },
    });
    try {
      const { json } = await postJson(srv.port, '/v1/chat/completions', {
        model: 'o4-mini',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const seen = JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');
      assert.equal(seen.reasoning, 'low', 'server default reasoning effort applied');
    } finally {
      await srv.kill();
    }
  });
});

// ─── Ollama interface parity: reasoning (think) + X-Clear-Context ──────────────

describe('ollama interface parity', () => {
  test('think level maps to reasoning_effort on codex', async () => {
    const srv = await startServer({
      server: 'ollama',
      backend: 'codex',
      env: { MOCK_SCENARIO: 'PROTOCOL', CODEX_REASONING_EFFORT: '' },
    });
    try {
      const { json } = await postJson(srv.port, '/api/chat', {
        model: 'auto',
        think: 'low',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const seen = JSON.parse(json?.message?.content ?? '{}');
      assert.equal(seen.reasoning, 'low', 'think level forwarded as reasoning_effort');
    } finally {
      await srv.kill();
    }
  });

  test('X-Clear-Context resets a persistent session (session/new on warm process)', async () => {
    const srv = await startServer({
      server: 'ollama',
      backend: 'codex',
      env: { DEBUG: '1' },
    });
    try {
      const SID = 'oll-logical-1';
      const timing = async (rid) => {
        const r = await fetch(`http://127.0.0.1:${srv.port}/debug/timings`);
        const { data } = await r.json();
        return data.find((t) => t.rid === rid);
      };
      await postJson(
        srv.port,
        '/api/chat',
        {
          model: 'auto',
          stream: false,
          messages: [{ role: 'user', content: 't1' }],
        },
        { 'X-Session-Id': SID, 'X-Request-Id': 'oll-1' },
      );
      await postJson(
        srv.port,
        '/api/chat',
        {
          model: 'auto',
          stream: false,
          messages: [{ role: 'user', content: 't2' }],
        },
        { 'X-Session-Id': SID, 'X-Request-Id': 'oll-2' },
      );
      const t2 = await timing('oll-2');
      assert.equal(t2.session_new_ms, null, 'reuse → no session/new on the warm thread');
      await postJson(
        srv.port,
        '/api/chat',
        {
          model: 'auto',
          stream: false,
          messages: [{ role: 'user', content: 't3' }],
        },
        {
          'X-Session-Id': SID,
          'X-Request-Id': 'oll-3',
          'X-Clear-Context': '1',
        },
      );
      const t3 = await timing('oll-3');
      assert.ok(t3.session_new_ms != null, 'clear → session/new ran on the warm process');
    } finally {
      await srv.kill();
    }
  });
});

// ─── Tool-arg format tracks the INTERFACE, not the backend ─────────────────────

describe('tool-call argument format is interface-determined', () => {
  let ollamaSrv, openaiSrv;
  before(async () => {
    // Same kiro backend for both — only the interface differs.
    ollamaSrv = await startServer({
      server: 'ollama',
      backend: 'kiro',
      env: { MOCK_SCENARIO: 'TOOL_CALL' },
    });
    openaiSrv = await startServer({
      server: 'openai',
      backend: 'kiro',
      env: { MOCK_SCENARIO: 'TOOL_CALL' },
    });
  });
  after(async () => {
    await ollamaSrv?.kill();
    await openaiSrv?.kill();
  });

  const tools = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
        },
      },
    },
  ];

  test('Ollama interface → arguments is a plain object', async () => {
    const { json } = await postJson(ollamaSrv.port, '/api/chat', {
      model: 'auto',
      messages: [{ role: 'user', content: 'weather?' }],
      tools,
      stream: false,
    });
    const tc = toolCalls('ollama', json);
    assert.ok(tc?.length, 'expected a tool call');
    assert.equal(typeof tc[0].function.arguments, 'object');
    assert.equal(tc[0].function.arguments.location, 'San Francisco');
  });

  test('OpenAI interface → arguments is a JSON string', async () => {
    const { json } = await postJson(openaiSrv.port, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'weather?' }],
      tools,
      stream: false,
    });
    const tc = toolCalls('openai', json);
    assert.ok(tc?.length, 'expected a tool call');
    assert.equal(typeof tc[0].function.arguments, 'string');
    assert.deepEqual(JSON.parse(tc[0].function.arguments), {
      location: 'San Francisco',
    });
  });
});

// ─── OPENAI_API_KEY is optional — codex-acp self-authenticates over ACP ────────

describe('OPENAI_API_KEY is optional for the codex backend', () => {
  test('openai + kiro starts with no OPENAI_API_KEY', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'kiro',
      env: { OPENAI_API_KEY: '' },
    });
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/health`);
      const h = await r.json();
      assert.ok(h.pool.alive >= 1, 'kiro pool should be live without OPENAI_API_KEY');
    } finally {
      await srv.kill();
    }
  });

  test('openai + codex spawns with no OPENAI_API_KEY (codex-acp uses its own login)', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex',
      env: { OPENAI_API_KEY: '' },
    });
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/health`);
      const h = await r.json();
      assert.ok(
        h.pool.alive >= 1,
        'codex pool should spawn without OPENAI_API_KEY (no hard requirement)',
      );
    } finally {
      await srv.kill();
    }
  });
});

// ─── Remote safety gate follows the backend ────────────────────────────────────

describe('remote safety gate follows the backend (ollama interface)', () => {
  test('ollama + codex + HOST=0.0.0.0 + no AUTH_TOKEN → exit 1', async () => {
    const r = await expectStartupOutcome({
      server: 'ollama',
      backend: 'codex',
      env: { HOST: '0.0.0.0', AUTH_TOKEN: '', ALLOW_INSECURE_REMOTE: '0' },
    });
    assert.equal(r.ready, false);
    assert.equal(r.exitCode, 1);
  });

  test('ollama + kiro + HOST=0.0.0.0 + no auth → starts (gate does not apply)', async () => {
    const srv = await startServer({
      server: 'ollama',
      backend: 'kiro',
      env: { HOST: '0.0.0.0' },
    });
    await srv.kill();
    assert.ok(true);
  });

  test('ollama + codex + HOST=0.0.0.0 + AUTH_TOKEN set → starts', async () => {
    const srv = await startServer({
      server: 'ollama',
      backend: 'codex',
      env: { HOST: '0.0.0.0', AUTH_TOKEN: 'sk-x' },
    });
    await srv.kill();
    assert.ok(true);
  });
});

// ─── Auth enforcement on the Ollama interface ──────────────────────────────────

describe('ollama interface auth enforcement', () => {
  let srv;
  before(async () => {
    srv = await startServer({
      server: 'ollama',
      backend: 'kiro',
      env: { AUTH_TOKEN: 'sk-valid,sk-alt' },
    });
  });
  after(async () => {
    await srv?.kill();
  });

  test('request without token → 401', async () => {
    const { status } = await postJson(srv.port, '/api/chat', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    assert.equal(status, 401);
  });

  test('request with valid token → 200', async () => {
    const { status } = await postJson(
      srv.port,
      '/api/chat',
      {
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
      { Authorization: 'Bearer sk-valid' },
    );
    assert.equal(status, 200);
  });

  test('/health is always open (no token)', async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/health`);
    assert.equal(r.status, 200);
  });
});

// ─── Backend selection edge cases ──────────────────────────────────────────────

describe('backend selection (--backend flag)', () => {
  test('unknown backend → exit 1', async () => {
    const r = await expectStartupOutcome({
      server: 'openai',
      flagBackend: 'bogus',
    });
    assert.equal(r.ready, false);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown --backend/);
  });

  test('empty --backend= → falls back to interface default', async () => {
    const r = await expectStartupOutcome({
      server: 'ollama',
      backend: 'kiro',
      flagBackend: '',
    });
    assert.equal(r.ready, true);
  });

  test('backend name is normalized (uppercase + whitespace)', async () => {
    const r = await expectStartupOutcome({
      server: 'ollama',
      backend: 'kiro',
      flagBackend: ' KIRO ',
    });
    assert.equal(r.ready, true);
  });
});

// ─── Deprecated old-path shim ──────────────────────────────────────────────────

describe('acp-server-codex.js compatibility shim', () => {
  test('boots, warns, and serves the OpenAI surface', async () => {
    const port = await getFreePort();
    const proc = spawn(process.execPath, [SHIM], {
      env: baseEnv('codex', port),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const errors = [];
    proc.stderr.on('data', (d) => errors.push(String(d)));
    try {
      await waitReady(port);
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
      assert.equal(r.status, 200);
      assert.match(errors.join(''), /deprecated/i);
    } finally {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 2000);
    }
  });
});

// ─── Native codex app-server backend (codex-appserver) ─────────────────────────
//
// Separate from the kiro/codex 2×2 matrix: app-server is a different protocol
// (thread/start + turn/start + async turn/completed, jsonrpc header omitted), so
// it has its own mock and assertions.

describe('codex-appserver: native protocol', () => {
  for (const server of ['ollama', 'openai']) {
    test(`${server} interface drives app-server (thread/start, per-turn model, no jsonrpc header)`, async () => {
      const srv = await startServer({
        server,
        backend: 'codex-appserver',
        env: {
          MOCK_SCENARIO: 'PROTOCOL',
          CODEX_APPSERVER_REASONING_EFFORT: '',
        },
      });
      try {
        const content = await chatContent(server, srv.port, {
          model: 'gpt-5.4-mini',
        });
        const seen = JSON.parse(content);
        assert.equal(seen.initialized, true, 'sent initialized notification');
        assert.equal(
          seen.jsonrpcSeen,
          false,
          'client must not send a jsonrpc field (lite framing)',
        );
        assert.ok(seen.threadStarts >= 1, 'created a thread via thread/start');
        assert.equal(seen.turnStarts, 1, 'one turn/start');
        assert.equal(seen.model, 'gpt-5.4-mini', 'per-turn model override forwarded on turn/start');
        assert.equal(seen.inputType, 'text', 'text input item');
        assert.equal(
          seen.sandbox,
          'danger-full-access',
          'full-access maps to danger-full-access sandbox',
        );
        assert.equal(seen.approvalPolicy, 'never', 'full-access maps to approvalPolicy never');
      } finally {
        await srv.kill();
      }
    });
  }

  test('completes via turn/completed and assembles streamed text', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex-appserver',
      env: { MOCK_SCENARIO: 'DEFAULT' },
    });
    try {
      const content = await chatContent('openai', srv.port, {
        model: 'gpt-5.5',
      });
      assert.equal(
        content,
        'Hello from mock app-server',
        'deltas assembled, turn/completed resolved the turn',
      );
    } finally {
      await srv.kill();
    }
  });

  test("model 'auto' resolves to the lean autoModel (not the heavy default)", async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex-appserver',
      env: { MOCK_SCENARIO: 'PROTOCOL', CODEX_APPSERVER_REASONING_EFFORT: '' },
    });
    try {
      const { json } = await postJson(srv.port, '/v1/chat/completions', {
        model: 'auto',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const seen = JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');
      assert.equal(seen.model, 'gpt-5.4-mini', "'auto' maps to the lean autoModel on turn/start");
    } finally {
      await srv.kill();
    }
  });

  test('per-turn reasoning effort is forwarded on turn/start', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex-appserver',
      env: { MOCK_SCENARIO: 'PROTOCOL', CODEX_APPSERVER_REASONING_EFFORT: '' },
    });
    try {
      const { json } = await postJson(srv.port, '/v1/chat/completions', {
        model: 'gpt-5.5',
        reasoning_effort: 'medium',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const seen = JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');
      assert.equal(seen.effort, 'medium', 'reasoning effort forwarded as turn/start.effort');
    } finally {
      await srv.kill();
    }
  });

  test('real token usage flows from thread/tokenUsage/updated', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex-appserver',
      env: { MOCK_SCENARIO: 'USAGE' },
    });
    try {
      const { json } = await postJson(srv.port, '/v1/chat/completions', {
        model: 'gpt-5.5',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(json?.usage?.prompt_tokens, 42, 'inputTokens → prompt_tokens');
      assert.equal(json?.usage?.completion_tokens, 8, 'outputTokens → completion_tokens');
    } finally {
      await srv.kill();
    }
  });

  test('X-Clear-Context starts a fresh thread on the warm process', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex-appserver',
      env: { DEBUG: '1' },
    });
    try {
      const SID = 'appsrv-logical-1';
      const timing = async (rid) => {
        const r = await fetch(`http://127.0.0.1:${srv.port}/debug/timings`);
        const { data } = await r.json();
        return data.find((t) => t.rid === rid);
      };
      const hdr = (rid, extra = {}) => ({
        'X-Session-Id': SID,
        'X-Request-Id': rid,
        ...extra,
      });
      await postJson(
        srv.port,
        '/v1/chat/completions',
        {
          model: 'gpt-5.5',
          stream: false,
          messages: [{ role: 'user', content: 't1' }],
        },
        hdr('as-1'),
      );
      await postJson(
        srv.port,
        '/v1/chat/completions',
        {
          model: 'gpt-5.5',
          stream: false,
          messages: [{ role: 'user', content: 't2' }],
        },
        hdr('as-2'),
      );
      const t2 = await timing('as-2');
      assert.equal(t2.session_new_ms, null, 'reuse → no thread/start on the warm thread');
      await postJson(
        srv.port,
        '/v1/chat/completions',
        {
          model: 'gpt-5.5',
          stream: false,
          messages: [{ role: 'user', content: 't3' }],
        },
        hdr('as-3', { 'X-Clear-Context': '1' }),
      );
      const t3 = await timing('as-3');
      assert.ok(t3.session_new_ms != null, 'clear → thread/start ran on the warm process');
    } finally {
      await srv.kill();
    }
  });

  test('MAX_EXEC_MS timeout cancels via turn/interrupt and returns 504', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex-appserver',
      env: { MOCK_SCENARIO: 'TIMEOUT', MAX_EXEC_MS: '500' },
    });
    try {
      const { status } = await postJson(srv.port, '/v1/chat/completions', {
        model: 'gpt-5.5',
        stream: false,
        messages: [{ role: 'user', content: 'stall' }],
      });
      assert.equal(status, 504, 'timed-out turn → 504');
      // Server is still healthy after the cancel + grace drain.
      const r = await fetch(`http://127.0.0.1:${srv.port}/health`);
      assert.equal(r.status, 200, 'server survives the interrupt');
    } finally {
      await srv.kill();
    }
  });

  test('remote safety gate: openai + codex-appserver + HOST=0.0.0.0 + no auth → exit 1', async () => {
    const r = await expectStartupOutcome({
      server: 'openai',
      backend: 'codex-appserver',
      env: { HOST: '0.0.0.0', ACP_API_KEY: '', ALLOW_INSECURE_REMOTE: '0' },
    });
    assert.equal(r.ready, false);
    assert.equal(r.exitCode, 1);
  });

  test('thread-not-found on a stateful session recovers via thread/start + retry', async () => {
    const srv = await startServer({
      server: 'openai',
      backend: 'codex-appserver',
      env: { MOCK_SCENARIO: 'NOT_FOUND_ONCE' },
    });
    try {
      // First turn/start → -32001; the registry client recreates the thread and
      // retries once, so the caller still sees a 200 with assembled text.
      const { status, json } = await postJson(
        srv.port,
        '/v1/chat/completions',
        { model: 'gpt-5.5', stream: false, messages: [{ role: 'user', content: 'hi' }] },
        { 'X-Session-Id': 'appsrv-recover-1' },
      );
      assert.equal(status, 200, 'recovered after one thread/start retry');
      assert.equal(json?.choices?.[0]?.message?.content, 'Hello from mock app-server');
    } finally {
      await srv.kill();
    }
  });
});

// ─── BACKENDS block drift guard ────────────────────────────────────────────────

describe('duplicated BACKENDS block stays byte-identical', () => {
  function extractBackends(file) {
    const src = fs.readFileSync(file, 'utf8');
    const start = src.indexOf('// >>> BACKENDS');
    const end = src.indexOf('// <<< BACKENDS');
    assert.ok(start !== -1 && end !== -1, `markers not found in ${path.basename(file)}`);
    // Normalize line endings — the two files may differ in EOL convention (CRLF vs
    // LF); we are guarding against logic drift, not whitespace.
    return src.slice(start, end).replace(/\r\n/g, '\n');
  }

  test('acp-server-ollama.js and acp-server-openai.js define the same BACKENDS map', () => {
    assert.equal(extractBackends(OLLAMA), extractBackends(OPENAI));
  });
});
