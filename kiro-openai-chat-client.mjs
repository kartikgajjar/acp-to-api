/**
 * Minimal chat client for kiro-api-bridge-server (or any OpenAI-compatible server).
 * No dependencies — Node 18+ native fetch + readline.
 *
 * Usage:
 *   node chat-client.mjs
 *   node chat-client.mjs --model claude-sonnet-4-5
 *   node chat-client.mjs --system "You are a Rust expert"
 *   node chat-client.mjs --once "What is Node.js?"
 *
 * Env:
 *   ACP_URL      server base URL  (default: http://localhost:3456)
 *   ACP_API_KEY  bearer token     (default: sk-local-dev-key)
 *
 * REPL commands: /model  /system <text>  /clear  /history  /exit
 */

import readline from 'readline';

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL   = process.env.ACP_URL     ?? 'http://localhost:3456';
const AUTH_TOKEN = process.env.ACP_API_KEY ?? process.env.AUTH_TOKEN ?? 'sk-local-dev-key';

const args   = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] ?? null : null; };

let   model      = getArg('--model')  ?? 'auto';
let   systemText = getArg('--system') ?? null;
const onceMsg    = getArg('--once')   ?? null;

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', red: '\x1b[31m',
};

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function getModels() {
  const r = await fetch(`${BASE_URL}/v1/models`, {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
  });
  const data = (await r.json()).data ?? [];
  const seen = new Set();
  return data.filter(m => seen.has(m.id) ? false : seen.add(m.id));
}

async function streamChat(messages, onChunk) {
  const reqStart = Date.now();
  const r = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
    body:    JSON.stringify({ model, messages, stream: true }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.error?.message ?? `HTTP ${r.status}`);
  }

  let full = '', buf = '', tokenCount = 0, firstTokenAt = null;
  const dec = new TextDecoder();

  for await (const raw of r.body) {
    buf += dec.decode(raw, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const token = JSON.parse(payload).choices?.[0]?.delta?.content ?? '';
        if (token) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          tokenCount++;
          full += token;
          onChunk(token);
        }
      } catch {}
    }
  }

  const endAt  = Date.now();
  const ttft   = firstTokenAt ? ((firstTokenAt - reqStart) / 1000).toFixed(2) : '?';
  const genSec = firstTokenAt ? (endAt - firstTokenAt) / 1000 : 0;
  const tps    = genSec > 0 ? (tokenCount / genSec).toFixed(1) : '?';
  const total  = ((endAt - reqStart) / 1000).toFixed(2);

  return { text: full, stats: { tokenCount, ttft, tps, total } };
}

// ─── REPL helpers ─────────────────────────────────────────────────────────────

let rl;
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

async function pickModel(models) {
  console.log(`\n${C.bold}Available models:${C.reset}`);
  models.forEach((m, i) => {
    const dot = m.id === model ? `${C.green}●${C.reset}` : ' ';
    console.log(`  ${dot} ${String(i + 1).padStart(2)}. ${C.yellow}${m.id}${C.reset}${m.description ? `  ${C.dim}${m.description}${C.reset}` : ''}`);
  });
  const ans = (await ask(`\n${C.bold}Enter number or model ID [current: ${model}]: ${C.reset}`)).trim();
  if (!ans) return model;
  const idx = parseInt(ans, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= models.length) return models[idx - 1].id;
  const found = models.find((m) => m.id === ans);
  if (found) return found.id;
  console.log(`${C.red}Not found — keeping ${model}${C.reset}`);
  return model;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try { await fetch(`${BASE_URL}/`); }
  catch {
    console.error(`${C.red}✗ Cannot reach ${BASE_URL} — start the server first.${C.reset}`);
    process.exit(1);
  }

  let models = [];
  try { models = await getModels(); } catch { /* non-fatal */ }

  const history = [];
  if (systemText) history.push({ role: 'system', content: systemText });

  // ── Single-shot mode ──────────────────────────────────────────────────────
  if (onceMsg) {
    const msgs = [...history, { role: 'user', content: onceMsg }];
    process.stdout.write(`\n${C.green}${C.bold}Assistant${C.reset} (${model}): `);
    const { text, stats } = await streamChat(msgs, (t) => process.stdout.write(t));
    console.log(`\n\n${C.dim}[${stats.tokenCount} tokens · ${stats.tps} tok/s · TTFT ${stats.ttft}s · total ${stats.total}s]${C.reset}`);
    process.exit(0);
  }

  // ── Interactive mode ──────────────────────────────────────────────────────
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════╗`);
  console.log(`║         Kiro Chat Client                 ║`);
  console.log(`╚══════════════════════════════════════════╝${C.reset}`);
  console.log(`${C.dim}Server : ${BASE_URL}${C.reset}`);
  console.log(`${C.dim}Model  : ${C.yellow}${model}${C.reset}`);
  if (systemText) console.log(`${C.dim}System : ${systemText.slice(0, 70)}${C.reset}`);
  console.log(`\n${C.dim}Commands: /model  /system <text>  /clear  /history  /exit${C.reset}`);
  console.log(`${C.dim}──────────────────────────────────────────────${C.reset}\n`);

  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', () => { console.log(`\n${C.dim}Goodbye.${C.reset}`); process.exit(0); });

  while (true) {
    const input = (await ask(`${C.bold}${C.blue}You: ${C.reset}`)).trim();
    if (!input) continue;

    if (input === '/exit' || input === '/quit') { console.log(`\n${C.dim}Goodbye.${C.reset}`); process.exit(0); }

    if (input === '/model') {
      try { models = await getModels(); } catch { /* use cached list */ }
      model = await pickModel(models);
      console.log(`\n${C.dim}✓ Model: ${C.yellow}${model}${C.reset}\n`);
      continue;
    }

    if (input === '/clear') {
      history.length = 0;
      if (systemText) history.push({ role: 'system', content: systemText });
      console.log(`${C.dim}✓ History cleared.${C.reset}\n`);
      continue;
    }

    if (input === '/history') {
      if (!history.length) { console.log(`${C.dim}(empty)${C.reset}`); }
      else history.forEach((m) => {
        const preview = (typeof m.content === 'string' ? m.content : '').replace(/\n/g, ' ').slice(0, 80);
        console.log(`  ${C.dim}[${m.role}]${C.reset} ${preview}`);
      });
      console.log();
      continue;
    }

    if (input.startsWith('/system ')) {
      systemText = input.slice(8).trim();
      const si = history.findIndex((m) => m.role === 'system');
      if (si !== -1) history[si].content = systemText;
      else history.unshift({ role: 'system', content: systemText });
      console.log(`${C.dim}✓ System prompt updated.${C.reset}\n`);
      continue;
    }

    history.push({ role: 'user', content: input });
    rl.pause();
    process.stdout.write(`\n${C.green}${C.bold}Assistant${C.reset}${C.dim} (${model})${C.reset}: `);

    try {
      const { text, stats } = await streamChat([...history], (t) => process.stdout.write(t));
      history.push({ role: 'assistant', content: text });
      process.stdout.write(`\n${C.dim}[${stats.tokenCount} tok · ${stats.tps} tok/s · TTFT ${stats.ttft}s · ${stats.total}s total]${C.reset}`);
    } catch (err) {
      process.stdout.write(`\n${C.red}Error: ${err.message}${C.reset}`);
    }

    console.log('\n');
    rl.resume();
  }
}

main().catch((e) => { console.error(`${C.red}${e.message}${C.reset}`); process.exit(1); });
