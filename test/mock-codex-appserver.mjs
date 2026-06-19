#!/usr/bin/env node
/**
 * Recording mock for the NATIVE `codex app-server` protocol (codex-appserver
 * backend). Mirrors mock-acp.mjs in spirit but speaks the app-server shape:
 *
 *   - "JSON-RPC lite": NO `jsonrpc` field on the wire (in or out). The mock
 *     asserts the client never sends one (seen.jsonrpcSeen stays false).
 *   - thread/start → { thread: { id } } (used as sessionId)
 *   - turn/start returns IMMEDIATELY ({ turn: { id, status:'inProgress' } });
 *     completion is the async `turn/completed` notification.
 *   - streaming: item/agentMessage/delta, thread/tokenUsage/updated
 *   - cancel: turn/interrupt → turn/completed { status:'interrupted' }
 *   - per-turn model + effort are fields on turn/start (recorded).
 *
 * MOCK_SCENARIO controls turn behavior:
 *   DEFAULT   – stream 4 text deltas + usage, then turn/completed
 *   PROTOCOL  – stream one delta = JSON.stringify(observations), then completed
 *   TOOL_CALL – stream a JSON tool_call block as text, then completed
 *   USAGE     – stream text + a tokenUsage notification, then completed
 *   SLOW      – wait 300 ms, then behave like DEFAULT
 *   TIMEOUT   – stall; complete (interrupted) only when turn/interrupt arrives
 *   CRASH     – process.exit(1) when turn/start is received
 *   NOT_FOUND_ONCE – first turn/start → -32001 "thread not found"; subsequent
 *                    turn/start behave like DEFAULT (tests thread recovery retry)
 */

import readline from 'readline';

const SCENARIO = process.env.MOCK_SCENARIO ?? 'DEFAULT';

let threadCounter = 0;
let turnCounter = 0;
let currentThreadId = null;
let activeTurnId = null;

// What the codex-appserver session class drove this mock with.
const seen = {
  initialized: false,
  jsonrpcSeen: false, // true if the client ever sent a `jsonrpc` field (it must not)
  sandbox: null,
  approvalPolicy: null,
  model: null, // turn/start model override
  effort: null, // turn/start reasoning effort override
  inputType: null, // first input item type on the last turn
  threadStarts: 0,
  turnStarts: 0,
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// JSON-RPC lite — no `jsonrpc` field.
function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function ok(id, result = {}) {
  write({ id, result });
}
function rpcError(id, code, message) {
  write({ id, error: { code, message } });
}
function notify(method, params) {
  write({ method, params });
}

function streamText(text) {
  notify('item/started', {
    item: {
      type: 'agentMessage',
      id: `msg-${turnCounter}`,
      text: '',
      phase: 'final_answer',
    },
    threadId: currentThreadId,
    turnId: activeTurnId,
    startedAtMs: 1,
  });
  notify('item/agentMessage/delta', {
    threadId: currentThreadId,
    turnId: activeTurnId,
    itemId: `msg-${turnCounter}`,
    delta: text,
  });
  notify('item/completed', {
    item: {
      type: 'agentMessage',
      id: `msg-${turnCounter}`,
      text,
      phase: 'final_answer',
    },
    threadId: currentThreadId,
    turnId: activeTurnId,
    completedAtMs: 2,
  });
}

function complete(status = 'completed') {
  notify('turn/completed', {
    threadId: currentThreadId,
    turn: {
      id: activeTurnId,
      items: [],
      status,
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    },
  });
  activeTurnId = null;
}

async function runTurn() {
  if (SCENARIO === 'CRASH') process.exit(1);
  if (SCENARIO === 'TIMEOUT') return; // wait for turn/interrupt
  if (SCENARIO === 'SLOW') await new Promise((r) => setTimeout(r, 300));

  if (SCENARIO === 'PROTOCOL') {
    streamText(JSON.stringify(seen));
  } else if (SCENARIO === 'TOOL_CALL') {
    streamText(
      JSON.stringify({
        tool_call: {
          name: 'get_weather',
          arguments: { location: 'San Francisco' },
        },
      }),
    );
  } else if (SCENARIO === 'USAGE') {
    streamText('Usage test response');
    notify('thread/tokenUsage/updated', {
      threadId: currentThreadId,
      turnId: activeTurnId,
      tokenUsage: {
        last: { inputTokens: 42, outputTokens: 8, totalTokens: 50 },
        total: { inputTokens: 42, outputTokens: 8, totalTokens: 50 },
      },
    });
  } else {
    for (const word of ['Hello', ' from', ' mock', ' app-server']) {
      notify('item/agentMessage/delta', {
        threadId: currentThreadId,
        turnId: activeTurnId,
        itemId: `msg-${turnCounter}`,
        delta: word,
      });
    }
    notify('thread/tokenUsage/updated', {
      threadId: currentThreadId,
      turnId: activeTurnId,
      tokenUsage: {
        last: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      },
    });
  }
  complete('completed');
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
  if (msg.jsonrpc !== undefined) seen.jsonrpcSeen = true;

  const { id, method } = msg;

  if (method === 'initialized') {
    seen.initialized = true;
    return;
  }

  if (method === 'turn/interrupt') {
    // Interrupt resolves the active turn as interrupted.
    if (activeTurnId) complete('interrupted');
    return;
  }

  if (id == null) return; // other notifications — ignore

  switch (method) {
    case 'initialize':
      ok(id, {
        userAgent: 'mock/0.0.1',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      });
      break;

    case 'model/list':
      ok(id, {
        data: [
          {
            id: 'gpt-5.5',
            model: 'gpt-5.5',
            displayName: 'GPT-5.5',
            hidden: false,
            isDefault: true,
          },
          {
            id: 'gpt-5.4',
            model: 'gpt-5.4',
            displayName: 'GPT-5.4',
            hidden: false,
            isDefault: false,
          },
          {
            id: 'gpt-5.4-mini',
            model: 'gpt-5.4-mini',
            displayName: 'GPT-5.4-Mini',
            hidden: false,
            isDefault: false,
          },
        ],
        nextCursor: null,
      });
      break;

    case 'thread/start':
      seen.threadStarts++;
      seen.sandbox = msg.params?.sandbox ?? null;
      seen.approvalPolicy = msg.params?.approvalPolicy ?? null;
      currentThreadId = `thread-${++threadCounter}`;
      ok(id, {
        thread: {
          id: currentThreadId,
          sessionId: currentThreadId,
          status: { type: 'idle' },
        },
        model: 'gpt-5.5',
      });
      break;

    case 'turn/start':
      seen.turnStarts++;
      if (SCENARIO === 'NOT_FOUND_ONCE' && seen.turnStarts === 1) {
        rpcError(id, -32001, 'thread not found');
        break;
      }
      seen.model = msg.params?.model ?? null;
      seen.effort = msg.params?.effort ?? null;
      seen.inputType = msg.params?.input?.[0]?.type ?? null;
      activeTurnId = `turn-${++turnCounter}`;
      ok(id, {
        turn: {
          id: activeTurnId,
          items: [],
          status: 'inProgress',
          error: null,
        },
      });
      runTurn().catch((e) => rpcError(id, -32603, e.message));
      break;

    default:
      rpcError(id, -32601, `Method not found: ${method}`);
  }
});

rl.on('close', () => process.exit(0));
