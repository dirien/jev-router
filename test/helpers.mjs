// Shared test fixtures: mock HTTP servers and Claude Code / Codex shaped requests.

import { createHash } from 'node:crypto';
import http from 'node:http';

/** @import { IncomingHttpHeaders, Server, ServerResponse } from 'node:http' */
/** @import { Item, RequestBody } from '../src/types.js' */

/**
 * Parsed JSON as a test reads it: any key at any depth. A key that isn't there reads as undefined
 * at run time, which the assertion then catches.
 * @typedef {{ readonly [key: string]: Json }} Json
 */

/**
 * One request a mock server received.
 * @typedef {object} MockCall
 * @property {string | undefined} method
 * @property {string} url
 * @property {IncomingHttpHeaders} headers
 * @property {Json} body the parsed JSON body
 */

/** @typedef {(call: MockCall, res: ServerResponse) => unknown} MockHandler */

/**
 * @typedef {object} Mock
 * @property {string} url
 * @property {MockCall[]} calls every request so far, oldest first
 * @property {Server} server
 * @property {() => Promise<void>} close
 */

/** @typedef {RequestBody & { messages: Item[] }} MessagesBody an Anthropic Messages body */
/** @typedef {RequestBody & { input: Item[] }} ResponsesBody an OpenAI Responses body */

/**
 * Resolves after `ms` milliseconds.
 * @type {(ms: number) => Promise<void>}
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * The hex SHA-256 of some bytes, to compare what the router relayed with what the upstream sent.
 * @param {string | Uint8Array} bytes
 */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Listens on an ephemeral port the OS assigns, so parallel test runs never collide.
/**
 * @param {import('node:http').Server} server
 * @returns {Promise<string>} the base URL, for example http://127.0.0.1:41234
 */
export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Closes a server, cutting its open connections.
 * @param {Server} server
 * @returns {Promise<void>}
 */
export const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/**
 * A mock upstream that records every call and answers with `handler(call, res)`.
 * @param {MockHandler} handler
 * @returns {Promise<Mock>}
 */
export async function mockServer(handler) {
  /** @type {MockCall[]} */
  const calls = [];
  const server = http.createServer(async (req, res) => {
    res.on('error', () => {
      // a client that timed out and hung up is expected in some tests
    });
    const raw = Buffer.concat(await Array.fromAsync(req)).toString();
    const call = { method: req.method, url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    calls.push(call);
    await handler(call, res);
  });
  return { url: await listen(server), calls, server, close: () => close(server) };
}

/**
 * Answers a mock request with a JSON body.
 * @param {ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
export function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * A System One response in the documented shape (see the Jev tutorial's captured response).
 * @param {{ tier?: string, probability?: number, secrets?: number }} [answer]
 */
export function jevAnswer({ tier = 'balanced', probability = 0.9, secrets = 0.02 } = {}) {
  /** @type {Record<string, number>} */
  const probabilities = { fast: 0, balanced: 0, frontier: 0, [tier]: probability };
  const rest = Object.keys(probabilities).filter((k) => k !== tier);
  probabilities[rest[0]] = Number((1 - probability).toFixed(2));
  return {
    id: 'gen-dec-test',
    model: 'typesafe/jev-1.13-20260917',
    provider: 'TypeSafe',
    answers: {
      tier: { type: 'choice', choice: tier, confidence: Number(((3 * probability - 1) / 2).toFixed(2)), probabilities },
      secrets: { type: 'noul', noul: secrets },
    },
    usage: { input_tokens: 412, output_tokens: 65, cost: 0.0000173 },
  };
}

/**
 * The bytes of server-sent events.
 * @param {Array<[name: string, data: unknown]>} events
 */
const sse = (events) => Buffer.from(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));

/**
 * An Anthropic SSE stream split into uneven chunks, two of which cut a multi-byte UTF-8
 * character in half. A proxy that decodes and re-encodes text would corrupt it.
 * @param {unknown} model
 */
export function anthropicSse(model) {
  const bytes = sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['ping', { type: 'ping' }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Grüße, das kostet 5 € 🚀' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' fertig.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
  const euro = bytes.indexOf(Buffer.from('€'));
  const rocket = bytes.indexOf(Buffer.from('🚀'));
  const cuts = [40, euro + 1, rocket + 2, bytes.length - 30];
  return [0, ...cuts].map((start, i) => bytes.subarray(start, cuts[i] ?? bytes.length));
}

/**
 * An OpenAI Responses SSE stream with no usage in it.
 * @param {unknown} model
 */
export function responsesSse(model) {
  return sse([
    ['response.created', { type: 'response.created', response: { id: 'resp_mock', model, status: 'in_progress' } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'renamed' }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_mock', model, status: 'completed' } }],
  ]);
}

// Request shapes captured from Claude Code 2.1.281 and the Codex CLI source.
/** The Bash tool as Claude Code declares it. */
export const BASH_TOOL = {
  name: 'Bash',
  description: 'Executes a given bash command and returns its output.',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
};

/**
 * The headers Claude Code sends, with a placeholder key of its own.
 * @param {string} sessionId
 * @param {Record<string, string>} [extra] added or replaced headers
 * @returns {Record<string, string>}
 */
export function claudeCodeHeaders(sessionId, extra = {}) {
  return {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27',
    'x-app': 'cli',
    'user-agent': 'claude-cli/2.1.281 (external, cli)',
    'x-claude-code-session-id': sessionId,
    'x-api-key': 'client-side-placeholder-key',
    ...extra,
  };
}

const reminder = { type: 'text', text: '<system-reminder>\nContents of CLAUDE.md: keep answers short.\n</system-reminder>' };

/**
 * A Claude Code request for a new human turn, after `history`, with a system reminder in front of the text.
 * @param {string} sessionId
 * @param {string} text what the user typed
 * @param {{ model?: string, stream?: boolean, history?: Item[], maxTokens?: number }} [options]
 * @returns {MessagesBody}
 */
export function claudeCodeBody(sessionId, text, { model = 'claude-sonnet-4-6', stream = true, history = [], maxTokens = 32000 } = {}) {
  return {
    model,
    max_tokens: maxTokens,
    stream,
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    tools: [BASH_TOOL],
    messages: [...history, { role: 'user', content: [reminder, { type: 'text', text }] }],
    metadata: { user_id: JSON.stringify({ device_id: 'dev-test', account_uuid: '', session_id: sessionId }) },
  };
}

/**
 * The follow-up turn after the model called Bash: the last message is a tool_result.
 * @param {string} sessionId
 * @param {string} text
 * @returns {MessagesBody}
 */
export function claudeCodeToolTurn(sessionId, text) {
  const first = claudeCodeBody(sessionId, text);
  first.messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01test', name: 'Bash', input: { command: 'ls -la' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01test', content: 'total 0' }, reminder] },
  );
  return first;
}

/**
 * The headers Codex CLI sends, with a placeholder login of its own.
 * @param {string} threadId
 * @param {Record<string, string>} [extra] added or replaced headers
 * @returns {Record<string, string>}
 */
export function codexHeaders(threadId, extra = {}) {
  return {
    'content-type': 'application/json',
    'session-id': threadId,
    'thread-id': threadId,
    originator: 'codex_cli_rs',
    authorization: 'Bearer client-side-placeholder',
    ...extra,
  };
}

/**
 * A Codex CLI request: environment context, then the user's text.
 * @param {string} threadId
 * @param {string} text
 * @returns {ResponsesBody}
 */
export function codexBody(threadId, text) {
  return {
    model: 'gpt-6-sol',
    instructions: 'You are Codex, a coding agent.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/repo</cwd>\n</environment_context>' }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    ],
    tools: [
      {
        type: 'function',
        name: 'shell',
        description: 'Run a command',
        parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } } },
      },
    ],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: threadId,
  };
}

/**
 * A System One answer for the v1 rubric: probabilities over the four options, plus the two guards.
 * @param {{ option?: string, probability?: number, sensitive?: number, claim?: number, model?: string }} [answer]
 */
export function jevOptionsAnswer({ option = 'routine', probability = 0.9, sensitive = 0.02, claim = 0.01, model = 'jev-1.13.0' } = {}) {
  const names = ['mechanical', 'routine', 'complex', 'deep'];
  const rest = (1 - probability) / (names.length - 1);
  const probabilities = Object.fromEntries(names.map((n) => [n, Number((n === option ? probability : rest).toFixed(2))]));
  return {
    model,
    answers: {
      tier: { type: 'choice', choice: option, confidence: Number(((4 * probability - 1) / 3).toFixed(2)), probabilities },
      alters_sensitive_state: { type: 'noul', noul: sensitive },
      routing_claim_present: { type: 'noul', noul: claim },
    },
    usage: { input_tokens: 610, output_tokens: 80 },
  };
}

/**
 * Anthropic usage events the router's usage tap reads.
 * @param {unknown} model
 * @param {{ input?: number, cacheRead?: number, cacheWrite?: number, output?: number }} [usage]
 */
export function anthropicSseWithUsage(model, { input = 12, cacheRead = 1000, cacheWrite = 0, output = 9 } = {}) {
  return sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_u',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 1 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}
