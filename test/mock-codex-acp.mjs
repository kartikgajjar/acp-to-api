#!/usr/bin/env node
/**
 * Mock codex-acp ACP subprocess for testing.
 * Reads JSON-RPC 2.0 from stdin, writes scripted responses to stdout.
 *
 * MOCK_SCENARIO env var controls session/prompt behavior:
 *   DEFAULT   – emit 4 text chunks "Hello from mock codex", resolve
 *   TOOL_CALL – emit a JSON tool_call block as text, resolve
 *   SLOW      – wait 300 ms, then behave like DEFAULT
 *   TIMEOUT   – stall; resolve only when session/cancel arrives
 *   CRASH     – process.exit(1) when session/prompt is received
 *   USAGE     – emit text + UsageUpdate notification, resolve
 *   NOT_FOUND_ONCE – first session/prompt → -32001 "session not found";
 *                    subsequent prompts behave like DEFAULT (tests recovery retry)
 *   AUTH_ERROR – session/prompt → -32000 "authentication required" (tests 401 mapping)
 *   PARTIAL_THEN_STALL – emit one text chunk, then stall like TIMEOUT (tests
 *                    timeout drain: handler returns the partial reply, not 504)
 */

import readline from 'readline';

const SCENARIO = process.env.MOCK_SCENARIO ?? 'DEFAULT';

let sessionCounter = 0;
let currentSessionId = null;
let pendingPromptId = null; // set in TIMEOUT / PARTIAL_THEN_STALL scenarios
let promptCount = 0; // total session/prompt requests seen (for NOT_FOUND_ONCE)

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
  promptCount++;
  if (SCENARIO === 'CRASH') {
    process.exit(1);
  }
  if (SCENARIO === 'AUTH_ERROR') {
    rpcError(id, -32000, 'authentication required');
    return;
  }
  if (SCENARIO === 'NOT_FOUND_ONCE' && promptCount === 1) {
    rpcError(id, -32001, 'session sess-x not found');
    return;
  }
  if (SCENARIO === 'TIMEOUT') {
    pendingPromptId = id;
    return; // wait for session/cancel to unblock
  }
  if (SCENARIO === 'PARTIAL_THEN_STALL') {
    notify('session/update', {
      sessionId: currentSessionId,
      update: { type: 'AgentMessageChunk', content: { text: 'Partial reply' } },
    });
    pendingPromptId = id;
    return; // stall after the partial chunk; resolve only on session/cancel
  }
  if (SCENARIO === 'SLOW') {
    await new Promise((r) => setTimeout(r, 300));
  }

  if (SCENARIO === 'TOOL_CALL') {
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
    // DEFAULT and SLOW
    for (const word of ['Hello', ' from', ' mock', ' codex']) {
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

  // session/cancel may arrive as a notification (no id) — handle it regardless
  if (method === 'session/cancel') {
    if (pendingPromptId != null) {
      ok(pendingPromptId); // unblock the stalled session/prompt
      pendingPromptId = null;
    }
    if (id != null) ok(id);
    return;
  }

  if (id == null) return; // other notifications (e.g. notifications/initialized) — ignore

  switch (method) {
    case 'initialize':
      ok(id, {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { supportsMultiTurn: true } },
        serverInfo: { name: 'mock-codex-acp', version: '0.0.1' },
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
    case 'session/set_config_option':
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
