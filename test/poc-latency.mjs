#!/usr/bin/env node
/**
 * Phase 0 PoC — latency split + capability probe for the codex backend.
 *
 * This is the EVIDENCE GATE from the latency plan. Two independent probes:
 *
 *   Probe 1 (--split, default on): fire N trivial "say ok" requests at a
 *     RUNNING acp-server-openai.js (start it with DEBUG=1 so /debug/timings is
 *     exposed) and print the MEDIAN per-stage latency split read back from
 *     GET /debug/timings. Tells you whether the floor is setup / prefill /
 *     reasoning / generation.
 *
 *   Probe 2 (--probe, default on): spawn codex-acp DIRECTLY and test which
 *     `session/set_config_option` config_ids and `session/set_mode` modeIds it
 *     accepts vs rejects (-32601 / param errors). The shim's _reqSafe swallows
 *     these failures, so we must drive the binary raw to see the truth. This is
 *     what decides whether reasoning_effort (plan 1.2) and a lighter tool
 *     surface (plan 2.3) are even possible.
 *
 * Usage:
 *   node test/poc-latency.mjs            # both probes
 *   node test/poc-latency.mjs --split    # latency split only (needs running server)
 *   node test/poc-latency.mjs --probe    # capability probe only (spawns codex-acp)
 *
 * Env:
 *   POC_BASE_URL  default http://127.0.0.1:3456
 *   POC_RUNS      default 5
 *   POC_MODEL     default 'auto'
 *   POC_TOKEN     bearer token, if the server runs with ACP_API_KEY set
 *   CODEX_CMD     default 'codex-acp'   (set to process.execPath for a mock)
 *   CODEX_ARGS    default ''            (space-separated; e.g. the mock path)
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.POC_BASE_URL ?? 'http://127.0.0.1:3456';
const RUNS = Number(process.env.POC_RUNS ?? 5);
const MODEL = process.env.POC_MODEL ?? 'auto';
const TOKEN = process.env.POC_TOKEN ?? '';
const CODEX_CMD = process.env.CODEX_CMD ?? 'codex-acp';
const CODEX_ARGS = (process.env.CODEX_ARGS ?? '').split(' ').filter(Boolean);

const argv = process.argv.slice(2);
const only = argv.find((a) => a === '--split' || a === '--probe' || a === '--ttft');
const doSplit = only ? only === '--split' : true;
const doProbe = only ? only === '--probe' : true;
const doTtft = only === '--ttft';

const SPLIT_FIELDS = [
  'acquire_ms',
  'session_new_ms',
  'set_mode_ms',
  'set_model_ms',
  'prefill_ms',
  'thought_gap_ms',
  'reasoning_gap_ms',
  'gen_ms',
  'total_ms',
];

function median(nums) {
  const xs = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// ─── Probe 1: latency split ────────────────────────────────────────────────────

async function probeSplit() {
  console.log(`\n=== Probe 1: latency split (${RUNS} runs, model=${MODEL}) ===`);
  console.log(`server: ${BASE_URL}`);

  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const rids = [];
  for (let i = 0; i < RUNS; i++) {
    const rid = `poc-${randomUUID().slice(0, 8)}`;
    rids.push(rid);
    const t0 = process.hrtime.bigint();
    try {
      const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'X-Request-Id': rid },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          messages: [{ role: 'user', content: 'say ok' }],
        }),
      });
      const wall = Number(process.hrtime.bigint() - t0) / 1e6;
      const body = await r.json().catch(() => ({}));
      const txt = body?.choices?.[0]?.message?.content ?? '';
      console.log(
        `  run ${i + 1}: ${r.status}  client_wall=${wall.toFixed(0)}ms  reply=${JSON.stringify(txt.slice(0, 40))}`,
      );
    } catch (e) {
      console.log(`  run ${i + 1}: FAILED ${e.message}`);
    }
  }

  // Read the server-side split back.
  let timings = [];
  try {
    const r = await fetch(`${BASE_URL}/debug/timings`, { headers });
    if (r.status === 404) {
      console.log('\n  /debug/timings is 404 — start the server with DEBUG=1 to enable it.');
      return;
    }
    const j = await r.json();
    timings = j.data ?? [];
  } catch (e) {
    console.log(`\n  could not read /debug/timings: ${e.message}`);
    return;
  }

  const mine = timings.filter((t) => rids.includes(t.rid));
  const sample = mine.length ? mine : timings.slice(-RUNS);
  if (!sample.length) {
    console.log('\n  no timing records found.');
    return;
  }

  console.log(`\n  median split over ${sample.length} record(s):`);
  const widest = Math.max(...SPLIT_FIELDS.map((f) => f.length));
  let dominant = { field: null, ms: -1 };
  for (const f of SPLIT_FIELDS) {
    const m = median(sample.map((t) => t[f]));
    const ms = m == null ? null : m;
    if (f !== 'total_ms' && ms != null && ms > dominant.ms) dominant = { field: f, ms };
    console.log(`    ${f.padEnd(widest)}  ${m == null ? '   -' : `${m.toFixed(1)}ms`}`);
  }
  if (dominant.field) {
    console.log(`\n  → dominant stage: ${dominant.field} (${dominant.ms.toFixed(1)}ms median)`);
    console.log('    decision tree:');
    console.log('      reasoning_gap_ms → plan 1.2 (reasoning_effort) + lean model');
    console.log('      prefill_ms       → plan 2.3 (lighter tool surface) / prompt-cache');
    console.log('      session_new/set_mode/set_model → plan 1.3 (pool pre-creates session)');
    console.log('      acquire_ms       → bump POOL_SIZE');
    console.log('      gen_ms           → lean model (1.4)');
  }
}

// ─── Probe 3: streaming TTFT (time to first content token) ─────────────────────

async function probeTTFT() {
  console.log(`\n=== Probe 3: streaming TTFT (${RUNS} runs, model=${MODEL}) ===`);
  console.log(`server: ${BASE_URL}`);
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const session = process.env.POC_SESSION || null; // fixed id → reuse one warm session
  if (session) console.log(`(stateful: reusing X-Session-Id=${session} across runs)`);
  const ttfts = [],
    totals = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    let ttft = null;
    try {
      const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...headers, ...(session ? { 'X-Session-Id': session } : {}) },
        body: JSON.stringify({
          model: MODEL,
          stream: true,
          messages: [{ role: 'user', content: 'say ok' }],
        }),
      });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data: ') || t === 'data: [DONE]') continue;
          try {
            const delta = JSON.parse(t.slice(6))?.choices?.[0]?.delta?.content;
            if (delta && ttft == null) ttft = Number(process.hrtime.bigint() - t0) / 1e6;
          } catch {
            /* keepalive */
          }
        }
      }
    } catch (e) {
      console.log(`  run ${i + 1}: FAILED ${e.message}`);
      continue;
    }
    const total = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ttft != null) ttfts.push(ttft);
    totals.push(total);
    console.log(
      `  run ${i + 1}: ttft=${ttft == null ? 'n/a' : `${ttft.toFixed(0)}ms`}  total=${total.toFixed(0)}ms`,
    );
  }
  const mt = median(ttfts),
    mtot = median(totals);
  console.log(
    `\n  median TTFT=${mt == null ? 'n/a' : `${mt.toFixed(0)}ms`}  median total=${mtot == null ? 'n/a' : `${mtot.toFixed(0)}ms`}`,
  );
  if (mt != null) console.log(`  TTFT < 1000ms: ${mt < 1000 ? 'YES ✓' : 'NO ✗'}`);
}

// ─── Probe 2: config-option / mode acceptance (raw codex-acp) ──────────────────

function makeRpcClient(proc) {
  const pending = new Map();
  let msgId = 0;
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Auto-grant any permission prompt so probes never stall.
    if (msg.method === 'session/request_permission' && msg.id != null) {
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { optionId: 'allow_always', granted: true },
        }) + '\n',
      );
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  function notify(method, params = {}) {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  function request(method, params = {}, timeoutMs = 10000) {
    const id = ++msgId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ _timeout: true });
      }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return {
    notify,
    request,
    close: () => {
      try {
        rl.close();
      } catch {}
    },
  };
}

function verdict(msg) {
  if (msg._timeout) return 'TIMEOUT';
  if (msg.error)
    return `REJECT (${msg.error.code}${msg.error.message ? ` ${msg.error.message}` : ''})`;
  return 'ACCEPT';
}

async function probeCapabilities() {
  console.log(`\n=== Probe 2: codex-acp capability probe ===`);
  console.log(`spawn: ${CODEX_CMD} ${CODEX_ARGS.join(' ')}`.trim());

  let proc;
  try {
    proc = spawn(CODEX_CMD, CODEX_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  } catch (e) {
    console.log(`  cannot spawn: ${e.message}`);
    return;
  }
  proc.on('error', (e) => console.log(`  spawn error: ${e.message}`));
  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(String(d)));

  const rpc = makeRpcClient(proc);
  try {
    const init = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'poc-latency', version: '0.0.1' },
    });
    if (init._timeout) {
      console.log('  initialize timed out — is codex-acp installed and OPENAI_API_KEY set?');
      if (stderr.length) console.log(`  stderr: ${stderr.join('').slice(0, 300)}`);
      return;
    }
    if (init.error) {
      console.log(`  initialize REJECT: ${JSON.stringify(init.error)}`);
      return;
    }

    rpc.notify('notifications/initialized');

    const sess = await rpc.request('session/new', { cwd: process.cwd(), mcpServers: [] });
    if (sess._timeout || sess.error) {
      console.log(`  session/new failed: ${JSON.stringify(sess.error ?? 'timeout')}`);
      return;
    }
    const sessionId = sess.result?.sessionId ?? sess.result?.id;
    console.log(`  session: ${sessionId}`);

    // 2a — reasoning-effort config ids.
    // codex-acp (src/thread.rs) wants the value as the ACP ValueId variant, but the
    // exact wire envelope depends on the installed agent-client-protocol version, so
    // we try several shapes and report which (config_id × envelope) is accepted.
    // Per source, only config_id 'reasoning_effort' is dispatched; others → invalid_params.
    console.log('\n  session/set_config_option (reasoning-effort candidates):');
    const configIds = ['reasoning_effort', 'reasoning', 'effort', 'model_reasoning_effort'];
    const values = ['minimal', 'low', 'medium', 'high', 'none', 'xhigh'];
    const envelopes = [
      { name: 'bare', wrap: (v) => v },
      { name: 'value.value', wrap: (v) => ({ value: v }) },
      { name: 'value.valueId', wrap: (v) => ({ valueId: v }) },
    ];
    for (const configId of configIds) {
      let hit = null;
      for (const env of envelopes) {
        const r = await rpc.request('session/set_config_option', {
          sessionId,
          configId,
          value: env.wrap('low'),
        });
        const v = verdict(r);
        process.stdout.write(
          `    ${configId.padEnd(22)} value=low(${env.name.padEnd(12)}) → ${v}\n`,
        );
        if (v === 'ACCEPT' && !hit) hit = env;
      }
      if (hit) {
        const accepted = [];
        for (const value of values) {
          const r = await rpc.request('session/set_config_option', {
            sessionId,
            configId,
            value: hit.wrap(value),
          });
          if (verdict(r) === 'ACCEPT') accepted.push(value);
        }
        console.log(
          `      → working envelope: ${hit.name};  accepted values: ${accepted.join(', ') || '(none)'}`,
        );
      }
    }

    // 2b — lighter session modes
    console.log('\n  session/set_mode (lighter-surface candidates):');
    const modeIds = ['read-only', 'auto', 'default', 'plan', 'agent', 'full-access'];
    for (const modeId of modeIds) {
      const r = await rpc.request('session/set_mode', { sessionId, modeId });
      console.log(`    ${modeId.padEnd(14)} → ${verdict(r)}`);
    }
  } finally {
    rpc.close();
    try {
      proc.kill('SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }, 1500).unref?.();
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

if (doTtft) await probeTTFT();
if (doSplit) await probeSplit();
if (doProbe) await probeCapabilities();
console.log('');
process.exit(0);
