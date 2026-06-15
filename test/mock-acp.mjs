#!/usr/bin/env node
/**
 * Generic recording ACP mock for cross-backend / cross-interface tests.
 *
 * Unlike mock-codex-acp.mjs (which is purpose-built for the codex regression
 * suite), this mock RECORDS the protocol facts the server drove it with, so a
 * test can assert what each backend profile actually sent:
 *   - whether `notifications/initialized` was received
 *   - whether `session/set_mode` was received
 *   - which method was used to switch models (set_model vs set_config_option)
 *
 * MOCK_SCENARIO controls session/prompt behavior:
 *   DEFAULT   – emit 4 text chunks, resolve
 *   PROTOCOL  – emit a single text chunk = JSON.stringify(observations), resolve
 *   TOOL_CALL – emit a JSON tool_call block as text, resolve
 *   SLOW      – wait 300 ms, then behave like DEFAULT
 *   TIMEOUT   – stall; resolve only when session/cancel arrives
 *   CRASH     – process.exit(1) when session/prompt is received
 *   USAGE     – emit text + UsageUpdate notification, resolve
 */

import readline from 'readline';

const SCENARIO = process.env.MOCK_SCENARIO ?? 'DEFAULT';

let sessionCounter = 0;
let currentSessionId = null;
let pendingPromptId = null;

// Protocol observations — what the server profile drove this backend with.
const seen = {
  initialized: false,
  setMode: false,
  modelMethod: null,
  modelValue: null,
  reasoning: null,
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function ok(id, result = {}) {
  write({ jsonrpc: '2.0', id, result });
}
function rpcError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}
function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

async function handlePrompt(id) {
  if (SCENARIO === 'CRASH') process.exit(1);
  if (SCENARIO === 'TIMEOUT') {
    pendingPromptId = id;
    return;
  }
  if (SCENARIO === 'SLOW') await new Promise((r) => setTimeout(r, 300));

  if (SCENARIO === 'PROTOCOL') {
    notify('session/update', {
      sessionId: currentSessionId,
      update: { type: 'AgentMessageChunk', content: { text: JSON.stringify(seen) } },
    });
  } else if (SCENARIO === 'TOOL_CALL') {
    const toolJson = JSON.stringify({
      tool_call: { name: 'get_weather', arguments: { location: 'San Francisco' } },
    });
    notify('session/update', {
      sessionId: currentSessionId,
      update: { type: 'AgentMessageChunk', content: { text: toolJson } },
    });
  } else if (SCENARIO === 'USAGE') {
    notify('session/update', {
      sessionId: currentSessionId,
      update: { type: 'AgentMessageChunk', content: { text: 'Usage test response' } },
    });
    notify('session/update', {
      sessionId: currentSessionId,
      update: { type: 'UsageUpdate', promptTokens: 42, completionTokens: 8 },
    });
  } else {
    for (const word of ['Hello', ' from', ' mock', ' acp']) {
      notify('session/update', {
        sessionId: currentSessionId,
        update: { type: 'AgentMessageChunk', content: { text: word } },
      });
    }
  }

  ok(id);
}

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method } = msg;

  // Record the initialized notification (arrives with no id)
  if (method === 'notifications/initialized') {
    seen.initialized = true;
    return;
  }

  if (method === 'session/cancel') {
    if (pendingPromptId != null) {
      ok(pendingPromptId);
      pendingPromptId = null;
    }
    if (id != null) ok(id);
    return;
  }

  if (id == null) return; // other notifications — ignore

  switch (method) {
    case 'initialize':
      ok(id, {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { supportsMultiTurn: true } },
        serverInfo: { name: 'mock-acp', version: '0.0.1' },
      });
      break;

    case 'session/new':
      currentSessionId = `session-${++sessionCounter}`;
      ok(id, {
        sessionId: currentSessionId,
        models: {
          availableModels: [{ modelId: 'auto' }, { modelId: 'o4-mini' }, { modelId: 'gpt-4o' }],
          currentModelId: 'auto',
        },
      });
      break;

    case 'session/set_mode':
      seen.setMode = true;
      ok(id);
      break;

    case 'session/set_model':
      seen.modelMethod = 'set_model';
      seen.modelValue = msg.params?.modelId ?? null;
      ok(id);
      break;

    case 'session/set_config_option':
      if (msg.params?.configId === 'reasoning_effort') {
        seen.reasoning = msg.params?.value ?? null;
      } else {
        seen.modelMethod = 'set_config_option';
        seen.modelValue = msg.params?.value ?? null;
      }
      ok(id);
      break;

    case 'ping':
      rpcError(id, -32601, 'Method not found');
      break;

    case 'session/prompt':
      handlePrompt(id).catch((e) => rpcError(id, -32603, e.message));
      break;

    default:
      rpcError(id, -32601, `Method not found: ${method}`);
  }
});

rl.on('close', () => process.exit(0));
