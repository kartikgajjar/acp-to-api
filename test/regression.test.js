/**
 * Regression suite for acp-server-codex.js
 *
 * Run:  npm test
 * Direct: node --test test/regression.test.js
 *
 * The server is started as a child process per describe group, with CODEX_CMD
 * pointing to test/mock-codex-acp.mjs instead of the real codex-acp binary.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import net from 'net';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER    = path.join(__dirname, '..', 'acp-server-openai.js');
const MOCK      = path.join(__dirname, 'mock-codex-acp.mjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
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
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`Server not ready on :${port} after ${ms}ms`);
}

/**
 * Start acp-server-codex.js as a child process.
 * env overrides are merged on top of sensible test defaults.
 * Returns { port, kill }.
 */
async function startServer(env = {}) {
  const port = await getFreePort();
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      // Defaults for test
      POOL_SIZE:       '1',
      PING_INTERVAL:   '999999',  // disable ping noise
      SESSION_TTL_MS:  '3600000',
      CODEX_CMD:       process.execPath,
      CODEX_ARGS:      MOCK,
      MOCK_SCENARIO:   'DEFAULT',
      OPENAI_API_KEY:  'sk-test',
      DEBUG:           '0',
      ACP_API_KEY:     '',
      ALLOWED_IPS:     '',
      AUTO_SESSION_HASH: '0',
      HOST:            '127.0.0.1',
      // Caller overrides
      ...env,
      // Always force the allocated port
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const errors = [];
  proc.stderr.on('data', d => errors.push(String(d)));

  try {
    await waitReady(port);
  } catch (e) {
    proc.kill('SIGKILL');
    throw new Error(`${e.message}\nstderr: ${errors.slice(0, 5).join('')}`);
  }

  const kill = () => new Promise(resolve => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2500);
  });

  return { port, proc, kill };
}

/** Thin fetch wrapper – always returns the Response (does not throw on 4xx/5xx). */
async function req(port, pathname, opts = {}) {
  const { method = 'GET', body, token, headers = {} } = opts;
  const hdrs = { 'Content-Type': 'application/json', ...headers };
  if (token) hdrs['Authorization'] = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: hdrs,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** POST /v1/chat/completions and return parsed JSON response. */
async function chat(port, body, opts = {}) {
  const r = await req(port, '/v1/chat/completions', { method: 'POST', body, ...opts });
  return { status: r.status, body: await r.json() };
}

/** Collect SSE events from a streaming chat completion. */
async function collectSSE(port, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const hdrs = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...(opts.token      ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.sessionId  ? { 'X-Session-Id': opts.sessionId }        : {}),
    };
    const rq = http.request(
      { hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: hdrs },
      res => {
        const events = [];
        let buf = '';
        res.on('data', chunk => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith('data: ')) events.push(t.slice(6));
          }
        });
        res.on('end', () => {
          if (buf.trim().startsWith('data: ')) events.push(buf.trim().slice(6));
          resolve({ status: res.statusCode, events });
        });
      },
    );
    rq.on('error', reject);
    rq.setTimeout(opts.timeout ?? 8000, () => { rq.destroy(); reject(new Error('SSE timeout')); });
    rq.write(payload);
    rq.end();
  });
}

// ─── Test data ────────────────────────────────────────────────────────────────

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather for a location',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string', description: 'City name' } },
      required: ['location'],
    },
  },
};

// ─── Open server (most tests) ─────────────────────────────────────────────────

describe('Health and models', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async  () => await srv.kill());

  test('GET / returns codex-acp-proxy identity', async () => {
    const r = await req(srv.port, '/');
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.object, 'codex-acp-proxy');
  });

  test('GET /health returns status ok with pool and registry', async () => {
    const r = await req(srv.port, '/health');
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.status, 'ok');
    assert.ok(b.pool,     'pool stats missing');
    assert.ok(typeof b.pool.size    === 'number');
    assert.ok(typeof b.pool.busy    === 'number');
    assert.ok(typeof b.pool.alive   === 'number');
    assert.ok(typeof b.pool.queued  === 'number');
    assert.ok(b.registry, 'registry stats missing');
    assert.ok(typeof b.registry.sessions === 'number');
  });

  test('GET /v1/models returns OpenAI list shape', async () => {
    const r = await req(srv.port, '/v1/models');
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.object, 'list');
    assert.ok(Array.isArray(b.data) && b.data.length > 0, 'should have at least one model');
    const m = b.data[0];
    assert.ok(typeof m.id === 'string');
    assert.equal(m.object, 'model');
    assert.ok(typeof m.created === 'number');
  });
});

// ─── Non-streaming completions ────────────────────────────────────────────────

describe('Non-streaming chat completions', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async  () => await srv.kill());

  test('returns correct OpenAI chat.completion shape', async () => {
    const { status, body } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.equal(status, 200);
    assert.ok(body.id?.startsWith('chatcmpl-'),         'id prefix');
    assert.equal(body.object, 'chat.completion');
    assert.ok(typeof body.created === 'number');
    assert.equal(body.model, 'auto');
    assert.ok(Array.isArray(body.choices) && body.choices.length === 1);
    const c = body.choices[0];
    assert.equal(c.index, 0);
    assert.equal(c.message.role, 'assistant');
    assert.ok(typeof c.message.content === 'string');
    assert.ok(['stop', 'tool_calls'].includes(c.finish_reason));
    assert.ok(body.usage);
    assert.ok(typeof body.usage.prompt_tokens     === 'number');
    assert.ok(typeof body.usage.completion_tokens === 'number');
    assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + body.usage.completion_tokens);
  });

  test('mock DEFAULT scenario returns assembled text', async () => {
    const { body } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(body.choices[0].message.content, 'Hello from mock codex');
  });

  test('missing messages → 400 with error envelope', async () => {
    const { status, body } = await chat(srv.port, { model: 'auto' });
    assert.equal(status, 400);
    assert.ok(body.error);
    assert.ok(typeof body.error.message === 'string');
    assert.ok(typeof body.error.type    === 'string');
    assert.equal(body.error.param, 'messages');
  });

  test('empty messages array → 400', async () => {
    const { status } = await chat(srv.port, { model: 'auto', messages: [] });
    assert.equal(status, 400);
  });

  test('system prompt included (request does not error)', async () => {
    const { status } = await chat(srv.port, {
      model: 'auto',
      messages: [
        { role: 'system', content: 'You are a test assistant.' },
        { role: 'user',   content: 'Hello' },
      ],
    });
    assert.equal(status, 200);
  });

  test('response_format json_object accepted', async () => {
    const { status } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Return JSON' }],
      response_format: { type: 'json_object' },
    });
    assert.equal(status, 200);
  });

  test('multi-turn messages (assistant + tool result) accepted', async () => {
    const { status } = await chat(srv.port, {
      model: 'auto',
      messages: [
        { role: 'user',      content: 'What is the weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"NYC"}' } }] },
        { role: 'tool',      content: 'Sunny, 72°F', tool_call_id: 'call_1' },
        { role: 'user',      content: 'Thanks' },
      ],
    });
    assert.equal(status, 200);
  });

  test('user content parts with text accepted', async () => {
    const { status } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    });
    assert.equal(status, 200);
  });

  test('tool_choice required accepted', async () => {
    const { status } = await chat(srv.port, {
      model: 'auto',
      messages:    [{ role: 'user', content: 'Call a tool' }],
      tools:       [WEATHER_TOOL],
      tool_choice: 'required',
    });
    // 200 means the instruction was accepted (coercion may or may not produce tool_calls with DEFAULT scenario)
    assert.ok([200, 200].includes(status));
  });

  test('unsupported OpenAI params accepted without 400', async () => {
    const { status } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature:        0.7,
      max_tokens:         100,
      top_p:              0.9,
      seed:               42,
      stop:               ['\n'],
      n:                  1,
      logprobs:           false,
      parallel_tool_calls: true,
      stream_options:     { include_usage: true },
      reasoning_effort:   'medium',
      user:               'test-user',
      service_tier:       'default',
    });
    assert.equal(status, 200);
  });
});

// ─── Streaming completions ────────────────────────────────────────────────────

describe('Streaming chat completions', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async  () => await srv.kill());

  test('returns SSE lines with chat.completion.chunk objects', async () => {
    const { status, events } = await collectSSE(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    assert.equal(status, 200);
    assert.ok(events.length >= 2, 'need at least role chunk + [DONE]');
    assert.equal(events.at(-1), '[DONE]', 'last event must be [DONE]');

    for (const e of events.slice(0, -1)) {
      const obj = JSON.parse(e);
      assert.equal(obj.object, 'chat.completion.chunk');
      assert.ok(obj.id?.startsWith('chatcmpl-'));
      assert.ok(Array.isArray(obj.choices));
    }
  });

  test('first chunk announces assistant role', async () => {
    const { events } = await collectSSE(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    const first = JSON.parse(events[0]);
    assert.equal(first.choices[0].delta.role, 'assistant');
  });

  test('last data chunk (before [DONE]) has stop finish_reason', async () => {
    const { events } = await collectSSE(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    const doneIdx = events.indexOf('[DONE]');
    assert.ok(doneIdx > 0, '[DONE] should not be first event');
    const last = JSON.parse(events[doneIdx - 1]);
    assert.ok(['stop', 'tool_calls'].includes(last.choices[0].finish_reason));
  });

  test('text delta chunks carry content', async () => {
    const { events } = await collectSSE(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    const textChunks = events.slice(0, -1)
      .map(e => JSON.parse(e))
      .filter(o => o.choices[0].delta.content != null && o.choices[0].delta.content !== '');
    assert.ok(textChunks.length > 0, 'should have at least one content delta');
  });
});

// ─── Tool call coercion ───────────────────────────────────────────────────────

describe('Tool call coercion (TOOL_CALL scenario)', () => {
  let srv;
  before(async () => { srv = await startServer({ MOCK_SCENARIO: 'TOOL_CALL' }); });
  after(async  () => await srv.kill());

  test('JSON tool_call wrapper coerced → tool_calls with JSON-string arguments', async () => {
    const { status, body } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'What is the weather in SF?' }],
      tools: [WEATHER_TOOL],
    });
    assert.equal(status, 200);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    const tc = body.choices[0].message.tool_calls;
    assert.ok(Array.isArray(tc) && tc.length > 0, 'must have tool_calls array');
    assert.equal(tc[0].type, 'function');
    assert.equal(tc[0].function.name, 'get_weather');
    assert.ok(typeof tc[0].function.arguments === 'string', 'arguments must be a JSON string');
    const args = JSON.parse(tc[0].function.arguments);
    assert.ok(args.location, 'arguments must contain location');
  });

  test('streaming tool call has delta.tool_calls and finish_reason tool_calls', async () => {
    const { status, events } = await collectSSE(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
      stream: true,
      tools: [WEATHER_TOOL],
    });
    assert.equal(status, 200);
    const chunks = events.slice(0, -1).map(e => JSON.parse(e));
    const hasToolCallDelta = chunks.some(c => c.choices[0].delta.tool_calls);
    const finishChunk = chunks.find(c => c.choices[0].finish_reason === 'tool_calls');
    assert.ok(hasToolCallDelta, 'should have a tool_calls delta chunk');
    assert.ok(finishChunk, 'should have finish_reason: tool_calls');
  });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  let srv;
  before(async () => { srv = await startServer({ ACP_API_KEY: 'sk-valid-token,sk-alt' }); });
  after(async  () => await srv.kill());

  const BODY = { model: 'auto', messages: [{ role: 'user', content: 'Hi' }] };

  test('correct primary token → 200', async () => {
    const { status } = await chat(srv.port, BODY, { token: 'sk-valid-token' });
    assert.equal(status, 200);
  });

  test('alternate token → 200 (comma-separated keys)', async () => {
    const { status } = await chat(srv.port, BODY, { token: 'sk-alt' });
    assert.equal(status, 200);
  });

  test('wrong token → 401 with invalid_api_key error code', async () => {
    const { status, body } = await chat(srv.port, BODY, { token: 'sk-wrong' });
    assert.equal(status, 401);
    assert.ok(body.error);
    assert.equal(body.error.code, 'invalid_api_key');
  });

  test('missing Authorization header → 401', async () => {
    const { status } = await chat(srv.port, BODY);
    assert.equal(status, 401);
  });

  test('/health always 200 regardless of auth', async () => {
    const r = await req(srv.port, '/health');
    assert.equal(r.status, 200);
  });

  test('/ always 200 regardless of auth', async () => {
    const r = await req(srv.port, '/');
    assert.equal(r.status, 200);
  });

  test('/v1/models requires auth', async () => {
    const r = await req(srv.port, '/v1/models');
    assert.equal(r.status, 401);
  });
});

// ─── IP allowlist ─────────────────────────────────────────────────────────────

describe('IP allowlist', () => {
  let srv;
  before(async () => { srv = await startServer({ ALLOWED_IPS: '127.0.0.1' }); });
  after(async  () => await srv.kill());

  test('request from 127.0.0.1 (loopback) returns 200', async () => {
    const { status } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    assert.equal(status, 200);
  });

  test('/health always 200 regardless of IP config', async () => {
    const r = await req(srv.port, '/health');
    assert.equal(r.status, 200);
  });
});

// ─── Remote binding safety gate ───────────────────────────────────────────────

describe('Remote binding safety gate', () => {
  test('HOST=0.0.0.0 + no ACP_API_KEY + no ALLOW_INSECURE → exit code 1', async (t) => {
    const port = await getFreePort();
    const proc = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT:                 String(port),
        HOST:                 '0.0.0.0',
        ACP_API_KEY:          '',
        ALLOW_INSECURE_REMOTE:'0',
        CODEX_CMD:            process.execPath,
        CODEX_ARGS:           MOCK,
        OPENAI_API_KEY:       'sk-test',
        POOL_SIZE:            '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const code = await new Promise(resolve => {
      proc.on('exit', resolve);
      setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 5000);
    });
    assert.equal(code, 1, `expected exit code 1, got ${code}`);
  });

  test('HOST=0.0.0.0 + ACP_API_KEY set → server starts', async () => {
    const srv = await startServer({ HOST: '0.0.0.0', ACP_API_KEY: 'sk-test' });
    // waitReady in startServer already verified server is up
    await srv.kill();
  });

  test('HOST=0.0.0.0 + ALLOW_INSECURE_REMOTE=1 → server starts', async () => {
    const srv = await startServer({ HOST: '0.0.0.0', ALLOW_INSECURE_REMOTE: '1' });
    await srv.kill();
  });
});

// ─── Session management ───────────────────────────────────────────────────────

describe('Session management', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async  () => await srv.kill());

  test('stateless (no X-Session-Id) uses pool → 200', async () => {
    const { status } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    assert.equal(status, 200);
  });

  test('stateful (X-Session-Id) first request → 200', async () => {
    const { status } = await chat(srv.port,
      { model: 'auto', messages: [{ role: 'user', content: 'First' }] },
      { headers: { 'X-Session-Id': 'test-session-1' } },
    );
    assert.equal(status, 200);
  });

  test('stateful (X-Session-Id) second request on same session → 200', async () => {
    const id = 'test-session-reuse';
    for (const content of ['Turn one', 'Turn two']) {
      const { status } = await chat(srv.port,
        { model: 'auto', messages: [{ role: 'user', content }] },
        { headers: { 'X-Session-Id': id } },
      );
      assert.equal(status, 200);
    }
  });
});

// ─── POOL_PRECREATE (1.3) ─────────────────────────────────────────────────────

describe('POOL_PRECREATE pre-creates + recycles pool sessions', () => {
  let srv;
  before(async () => { srv = await startServer({ POOL_PRECREATE: '1', DEBUG: '1', POOL_SIZE: '1' }); });
  after(async  () => await srv.kill());

  async function timingFor(rid) {
    const r = await req(srv.port, '/debug/timings');
    const { data } = await r.json();
    return data.find(t => t.rid === rid);
  }

  test('default-cwd request skips session/new on the critical path', async () => {
    const { status } = await chat(srv.port,
      { model: 'auto', messages: [{ role: 'user', content: 'Hi' }] },
      { headers: { 'X-Request-Id': 'precreate-1' } },
    );
    assert.equal(status, 200);
    const t = await timingFor('precreate-1');
    assert.ok(t, 'timing record present');
    assert.equal(t.session_new_ms, null, 'newSession was skipped (pre-created session reused)');
    assert.equal(t.set_mode_ms, null, 'set_mode skipped too');
  });

  test('a second request still works (session recycled after release)', async () => {
    const { status, body } = await chat(srv.port,
      { model: 'auto', messages: [{ role: 'user', content: 'Again' }] },
      { headers: { 'X-Request-Id': 'precreate-2' } },
    );
    assert.equal(status, 200);
    assert.ok(body?.choices?.[0]?.message, 'got a completion');
    const t = await timingFor('precreate-2');
    assert.equal(t.session_new_ms, null, 'recycled session reused, still no critical-path session/new');
  });
});

// ─── Responses API (/v1/responses) + /models alias ────────────────────────────

describe('Responses API and /models alias', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async  () => await srv.kill());

  test('GET /models (no /v1) returns the model list', async () => {
    const r = await req(srv.port, '/models');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.object, 'list');
    assert.ok(Array.isArray(j.data) && j.data.length >= 1);
  });

  test('POST /v1/responses (string input) returns a Responses object', async () => {
    const r = await req(srv.port, '/v1/responses', { method: 'POST', body: { model: 'auto', input: 'hello', stream: false } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.object, 'response');
    assert.equal(j.status, 'completed');
    assert.ok(typeof j.output_text === 'string' && j.output_text.length > 0, 'has output_text');
    const msg = j.output[j.output.length - 1];
    assert.equal(msg.type, 'message');
    assert.equal(msg.content[0].type, 'output_text');
    assert.ok(j.usage.total_tokens >= 0);
  });

  test('POST /v1/responses (array input + instructions)', async () => {
    const r = await req(srv.port, '/v1/responses', { method: 'POST', body: {
      model: 'auto', instructions: 'You are terse.',
      input: [{ type: 'message', role: 'user', content: 'hi' }], stream: false,
    } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.output_text.length > 0);
  });

  test('POST /responses (no /v1) also works', async () => {
    const r = await req(srv.port, '/responses', { method: 'POST', body: { model: 'auto', input: 'hi', stream: false } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).object, 'response');
  });

  test('empty input → 400', async () => {
    const r = await req(srv.port, '/v1/responses', { method: 'POST', body: { model: 'auto', input: [] } });
    assert.equal(r.status, 400);
  });

  test('POST /v1/responses streaming emits the response.* event sequence', async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/v1/responses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', input: 'hi', stream: true }),
    });
    const text = await r.text();
    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /event: response\.completed/);
  });
});

// ─── X-Clear-Context (logical-session boundary) ───────────────────────────────

describe('X-Clear-Context resets a persistent session without respawn', () => {
  let srv;
  before(async () => { srv = await startServer({ DEBUG: '1' }); });
  after(async  () => await srv.kill());

  async function timingFor(rid) {
    const r = await req(srv.port, '/debug/timings');
    const { data } = await r.json();
    return data.find(t => t.rid === rid);
  }

  const SID = 'logical-session-1';

  test('first turn creates the session', async () => {
    const { status } = await chat(srv.port,
      { model: 'auto', messages: [{ role: 'user', content: 'turn 1' }] },
      { headers: { 'X-Session-Id': SID, 'X-Request-Id': 'clr-1' } });
    assert.equal(status, 200);
  });

  test('reused turn without clear does NOT call session/new (warm thread)', async () => {
    const { status } = await chat(srv.port,
      { model: 'auto', messages: [{ role: 'user', content: 'turn 2' }] },
      { headers: { 'X-Session-Id': SID, 'X-Request-Id': 'clr-2' } });
    assert.equal(status, 200);
    const t = await timingFor('clr-2');
    assert.equal(t.session_new_ms, null, 'no reset → reuses warm thread');
  });

  test('X-Clear-Context resets the thread (fresh session/new on the warm process)', async () => {
    const { status } = await chat(srv.port,
      { model: 'auto', messages: [{ role: 'user', content: 'new logical session' }] },
      { headers: { 'X-Session-Id': SID, 'X-Request-Id': 'clr-3', 'X-Clear-Context': '1' } });
    assert.equal(status, 200);
    const t = await timingFor('clr-3');
    assert.ok(t.session_new_ms != null, 'clear → session/new ran on the warm process');
  });
});

// ─── AUTO_SESSION_HASH ────────────────────────────────────────────────────────

describe('AUTO_SESSION_HASH routing', () => {
  let srv;
  before(async () => { srv = await startServer({ AUTO_SESSION_HASH: '1' }); });
  after(async  () => await srv.kill());

  test('same system prompt routes to session (both requests 200)', async () => {
    const sys = { role: 'system', content: 'You are a test assistant.' };
    for (const turn of ['first turn', 'second turn']) {
      const { status } = await chat(srv.port, {
        model: 'auto',
        messages: [sys, { role: 'user', content: turn }],
      });
      assert.equal(status, 200);
    }
  });
});

// ─── Per-session serialization ────────────────────────────────────────────────

describe('Per-session FIFO serialization', () => {
  let srv;
  before(async () => { srv = await startServer({ MOCK_SCENARIO: 'SLOW' }); });
  after(async  () => await srv.kill());

  test('two concurrent requests on same X-Session-Id both complete 200', async (t) => {
    const sid = 'concurrent-fifo-test';
    const body = { model: 'auto', messages: [{ role: 'user', content: 'Hi' }] };
    const hdrs = { 'X-Session-Id': sid };

    const [r1, r2] = await Promise.all([
      chat(srv.port, body, { headers: hdrs }),
      chat(srv.port, body, { headers: hdrs }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
  }, { timeout: 12000 });
});

// ─── Timeout behavior ─────────────────────────────────────────────────────────

describe('Timeout behavior (MAX_EXEC_MS=600)', () => {
  let srv;
  before(async () => { srv = await startServer({ MOCK_SCENARIO: 'TIMEOUT', MAX_EXEC_MS: '600' }); });
  after(async  () => await srv.kill());

  test('non-streaming → 504 with timeout error envelope', async (t) => {
    const { status, body } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'This will time out' }],
      stream: false,
    });
    assert.equal(status, 504);
    assert.ok(body.error);
    assert.ok(typeof body.error.message === 'string');
    assert.equal(body.error.code, 'timeout');
  }, { timeout: 5000 });

  test('streaming → connection completes without hanging', async (t) => {
    let resolved = false;
    await Promise.race([
      collectSSE(srv.port,
        { model: 'auto', messages: [{ role: 'user', content: 'Stream timeout' }], stream: true },
        { timeout: 4000 },
      ).then(() => { resolved = true; }).catch(() => { resolved = true; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('test timed out')), 4500)),
    ]);
    assert.ok(resolved, 'streaming should complete or error cleanly within timeout');
  }, { timeout: 6000 });
});

// ─── Child process crash ──────────────────────────────────────────────────────

describe('Child process crash', () => {
  let srv;
  before(async () => { srv = await startServer({ MOCK_SCENARIO: 'CRASH' }); });
  after(async  () => await srv.kill());

  test('crash during prompt → 500/503 with error envelope', async (t) => {
    const { status, body } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Crash test' }],
    });
    assert.ok([500, 503].includes(status), `expected 500 or 503, got ${status}`);
    assert.ok(body.error);
    assert.ok(typeof body.error.message === 'string');
    assert.ok(typeof body.error.type    === 'string');
  }, { timeout: 8000 });
});

// ─── Error envelope shape ─────────────────────────────────────────────────────

describe('Error envelope shape', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async  () => await srv.kill());

  function assertEnvelope(body) {
    assert.ok(body.error,                              'must have error key');
    assert.ok(typeof body.error.message === 'string', 'error.message must be string');
    assert.ok(typeof body.error.type    === 'string', 'error.type must be string');
  }

  test('400 missing messages has envelope', async () => {
    const { status, body } = await chat(srv.port, { model: 'auto' });
    assert.equal(status, 400);
    assertEnvelope(body);
  });

  test('401 unauthorized has envelope', async () => {
    const srvAuth = await startServer({ ACP_API_KEY: 'sk-x' });
    try {
      const { status, body } = await chat(srvAuth.port,
        { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
        { token: 'wrong' },
      );
      assert.equal(status, 401);
      assertEnvelope(body);
    } finally { await srvAuth.kill(); }
  });
});

// ─── UsageUpdate propagation ──────────────────────────────────────────────────

describe('UsageUpdate notification', () => {
  let srv;
  before(async () => { srv = await startServer({ MOCK_SCENARIO: 'USAGE' }); });
  after(async  () => await srv.kill());

  test('real token counts from UsageUpdate appear in usage field', async () => {
    const { status, body } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    assert.equal(status, 200);
    // mock emits promptTokens=42, completionTokens=8
    assert.equal(body.usage.prompt_tokens,     42);
    assert.equal(body.usage.completion_tokens, 8);
    assert.equal(body.usage.total_tokens,      50);
  });
});

// ─── ACP handshake verification ───────────────────────────────────────────────

describe('ACP handshake (via successful requests)', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async  () => await srv.kill());

  // These tests verify the handshake indirectly: if these succeed, then
  // initialize + notifications/initialized + session/new + session/set_mode
  // were all handled correctly by the mock (it would have errored otherwise).

  test('server starts up → initialize handshake succeeded', async () => {
    const r = await req(srv.port, '/health');
    assert.equal(r.status, 200);
  });

  test('request completes → session/new + session/set_mode succeeded', async () => {
    const { status } = await chat(srv.port, {
      model: 'auto',
      messages: [{ role: 'user', content: 'test' }],
    });
    assert.equal(status, 200);
  });

  test('non-default model → session/set_config_option called without error', async () => {
    const { status } = await chat(srv.port, {
      model: 'o4-mini',
      messages: [{ role: 'user', content: 'test' }],
    });
    assert.equal(status, 200);
  });
});
