// Integration tests: the whole router against a mock Jev and mock upstreams on local ports. No network.
// Assertions count calls per test (call deltas), so a leftover call from an earlier test can't pass one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createRouter } from '../src/router.mjs';
import { validateConfig } from '../src/config.mjs';
import {
  anthropicSseWithUsage, claudeCodeBody, claudeCodeHeaders, claudeCodeToolTurn, close, codexBody, codexHeaders,
  jevOptionsAnswer, json, listen, mockServer, responsesSse, sha256, sleep,
} from './helpers.mjs';

const fake = (...parts) => parts.join('');
const AWS_KEY = fake('AKIA', 'QWERTYUIOPASDFGH');
const KEYS = {
  TYPESAFE_API_KEY: 'test-typesafe-key-DO-NOT-LOG',
  OPENROUTER_API_KEY: 'test-openrouter-key-DO-NOT-LOG',
  ANTHROPIC_API_KEY: 'test-anthropic-key-DO-NOT-LOG',
  OLLAMA_API_KEY: 'test-ollama-key-DO-NOT-LOG',
  OPENAI_API_KEY: 'test-openai-key-DO-NOT-LOG',
};

let jevA, jevB, anthropic, ollama, openai;
const plans = { a: {}, b: {} };
const routers = [];
const allLogs = [];

// A scriptable System One server: `plan.queue` holds per-call overrides, then `plan` applies.
function jevMock(plan) {
  return mockServer(async (call, res) => {
    const step = plan.queue?.shift() ?? plan;
    if (step.delayMs) await sleep(step.delayMs);
    if (step.html403) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<html><body>Attention Required! | Cloudflare</body></html>'); }
    if (step.status) return json(res, step.status, { detail: { error_type: 'api_error', message: `mock ${step.status}` } });
    json(res, 200, jevOptionsAnswer(step), { 'x-typesafe-request-id': 'req_mock_jev' });
  });
}

before(async () => {
  jevA = await jevMock(plans.a);
  jevB = await jevMock(plans.b);
  const messages = async (call, res) => {
    if (call.url.startsWith('/v1/messages/count_tokens')) return json(res, 200, { input_tokens: 42 });
    if (!call.body.stream) return json(res, 200, { id: 'msg', type: 'message', role: 'assistant', model: call.body.model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 1 } });
    const gap = Number(call.headers['x-test-chunk-gap-ms'] ?? 0);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_mock_sse', 'retry-after': '7' });
    const bytes = anthropicSseWithUsage(call.body.model);
    for (const piece of [bytes.subarray(0, 50), bytes.subarray(50, 300), bytes.subarray(300)]) { res.write(piece); if (gap) await sleep(gap); }
    res.end();
  };
  const responses = async (call, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(responsesSse(call.body.model)); };
  anthropic = await mockServer(messages);
  ollama = await mockServer((call, res) => (call.url.startsWith('/v1/messages') ? messages(call, res) : responses(call, res)));
  openai = await mockServer(responses);
});

after(async () => { await Promise.all([...routers.map(close), jevA.close(), jevB.close(), anthropic.close(), ollama.close(), openai.close()]); });

const shipped = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));

function testConfig(patch = {}) {
  const cfg = structuredClone(shipped);
  const hosts = { 'https://api.anthropic.com': anthropic.url, 'https://ollama.com': ollama.url, 'https://api.openai.com': openai.url };
  for (const targets of Object.values(cfg.surfaces)) for (const target of Object.values(targets)) target.url = hosts[target.url];
  cfg.jev.channels = [
    { name: 'typesafe', baseUrl: jevA.url, model: 'jev-1.13.0', keyEnv: 'TYPESAFE_API_KEY', timeoutMs: 400 },
    { name: 'openrouter', baseUrl: jevB.url, model: 'typesafe/jev-1.13', keyEnv: 'OPENROUTER_API_KEY', timeoutMs: 400 },
  ];
  cfg.jev.deadlineMs = 1500;
  return validateConfig({ ...cfg, stateFile: null, ...patch, policy: { ...cfg.policy, ...patch.policy } });
}

async function startRouter({ cfg = testConfig(), env = {} } = {}) {
  const logs = [];
  const server = createRouter(cfg, { env: { ...KEYS, ...env }, log: (e) => { logs.push(e); allLogs.push(e); } });
  routers.push(server);
  const url = await listen(server);
  return { url, server, logs, routes: () => logs.filter((e) => e.event === 'route'), done: () => logs.filter((e) => e.event === 'done') };
}

async function post(base, path, body, headers) {
  const res = await fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: bytes.toString() };
}

// Runs fn and returns what it sent to each mock: { anthropic: [calls], ollama: [...], jevA: [...], ... }
async function delta(fn) {
  const mocks = { anthropic, ollama, openai, jevA, jevB };
  const before = Object.fromEntries(Object.entries(mocks).map(([k, m]) => [k, m.calls.length]));
  const result = await fn();
  const calls = Object.fromEntries(Object.entries(mocks).map(([k, m]) => [k, m.calls.slice(before[k])]));
  return { result, ...calls };
}
const reset = (plan, value = {}) => { for (const k of Object.keys(plan)) delete plan[k]; Object.assign(plan, value); };
const cc = (session, text, opts) => claudeCodeBody(session, text, { stream: false, ...opts });
const ccHeaders = (session, extra) => claudeCodeHeaders(session, { 'x-claude-code-request-class': 'main', ...extra });

test('a Claude Code prompt goes to the tier Jev picks, with only model and credentials changed', async () => {
  reset(plans.a, { option: 'deep', probability: 0.9 });
  const { url, routes } = await startRouter();
  const body = cc('s-route', 'Design the zero-downtime migration for the orders table and its rollback.');
  const d = await delta(() => post(url, '/v1/messages?beta=true', body, ccHeaders('s-route')));
  assert.equal(d.result.status, 200);
  assert.equal(d.anthropic.length, 1);
  const up = d.anthropic[0];
  assert.equal(up.url, '/v1/messages?beta=true');
  assert.deepEqual(up.body, { ...body, model: 'claude-opus-5-5' });
  assert.equal(up.headers['x-api-key'], KEYS.ANTHROPIC_API_KEY);
  assert.equal(up.headers['anthropic-beta'], ccHeaders('s-route')['anthropic-beta'], 'betas are forwarded unchanged');
  assert.equal(d.jevA.length, 1);
  const ask = d.jevA[0];
  assert.equal(ask.headers.authorization, `Bearer ${KEYS.TYPESAFE_API_KEY}`);
  assert.equal(ask.body.model, 'jev-1.13.0');
  assert.deepEqual(Object.keys(ask.body.state), ['request', 'session']);
  assert.equal(ask.body.state.request, 'Design the zero-downtime migration for the orders table and its rollback.');
  assert.equal(ask.body.state.session.harness, 'Claude Code');
  const [route] = routes();
  assert.equal(route.reason, 'jev');
  assert.equal(route.jev.requestId, 'req_mock_jev');
  assert.deepEqual(route.jev.tiers, { fast: 0.03, balanced: 0.03, frontier: 0.93 });
  assert.equal(d.result.headers.get('x-jev-tier'), 'frontier');
});

test('Codex traffic goes to Ollama Cloud with a bearer key, minimal headers and no metadata', async () => {
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const { url } = await startRouter();
  const body = { ...codexBody('thread-1', 'Rename parse_args to parse_cli_args in cli.py'), metadata: { account: 'acct-1' } };
  const d = await delta(() => post(url, '/v1/responses', body, codexHeaders('thread-1')));
  assert.equal(d.result.status, 200);
  assert.deepEqual(d.result.bytes, responsesSse('glm-5.3-flash'));
  const up = d.ollama[0];
  assert.equal(up.body.model, 'glm-5.3-flash');
  assert.equal(up.headers.authorization, `Bearer ${KEYS.OLLAMA_API_KEY}`);
  assert.equal(up.headers['session-id'], undefined, 'client ids stay with first-party providers');
  assert.equal(up.body.metadata, undefined);
  assert.equal(d.jevA[0].body.state.session.harness, 'Codex CLI');
});

test('a session ratchets: tool loops never ask Jev, a harder new turn upgrades, an easier one keeps the tier', async () => {
  const { url, routes } = await startRouter();
  const h = ccHeaders('s-ratchet');
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const first = cc('s-ratchet', 'What does git status -sb print?');
  const d1 = await delta(async () => {
    await post(url, '/v1/messages', first, h);
    await post(url, '/v1/messages', { ...claudeCodeToolTurn('s-ratchet', 'What does git status -sb print?'), stream: false }, h);
  });
  assert.equal(d1.jevA.length, 1, 'the tool-loop turn did not ask Jev');
  assert.deepEqual(d1.ollama.map((c) => c.body.model), ['glm-5.3-flash', 'glm-5.3-flash']);

  reset(plans.a, { option: 'complex', probability: 0.9 });
  const history = [...first.messages, { role: 'assistant', content: [{ type: 'text', text: 'It prints a short status.' }] }];
  const second = cc('s-ratchet', 'Now find why the auth test fails intermittently across the session and token modules.', { history });
  const d2 = await delta(() => post(url, '/v1/messages', second, h));
  assert.equal(d2.anthropic[0].body.model, 'claude-opus-5-5');

  reset(plans.a, { option: 'mechanical', probability: 0.99 });
  const third = cc('s-ratchet', 'thanks', { history: [...second.messages, { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] }] });
  const d3 = await delta(() => post(url, '/v1/messages', third, h));
  assert.equal(d3.anthropic[0].body.model, 'claude-opus-5-5', 'no downgrade inside a session');
  assert.deepEqual(routes().map((r) => r.reason), ['jev', 'sticky', 'upgrade:jev', 'jev-keep']);
});

test('sticky mode decides once per session', async () => {
  const { url, routes } = await startRouter({ cfg: testConfig({ policy: { mode: 'sticky' } }) });
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const first = cc('s-sticky', 'Add a test for the parser');
  await post(url, '/v1/messages', first, ccHeaders('s-sticky'));
  reset(plans.a, { option: 'deep', probability: 0.99 });
  const d = await delta(() => post(url, '/v1/messages', cc('s-sticky', 'Now redesign everything', { history: [...first.messages, { role: 'assistant', content: 'ok' }] }), ccHeaders('s-sticky')));
  assert.equal(d.jevA.length, 0);
  assert.equal(d.anthropic[0].body.model, 'claude-sonnet-5');
  assert.deepEqual(routes().map((r) => r.reason), ['jev', 'sticky']);
});

test('when Jev fails, the session is provisional: default tier now, Jev asked again on the next turn', async () => {
  const { url, routes } = await startRouter();
  reset(plans.a, { status: 500 });
  reset(plans.b, { status: 402 });
  const first = cc('s-prov', 'Rename foo to bar');
  const d1 = await delta(() => post(url, '/v1/messages', first, ccHeaders('s-prov')));
  assert.equal(d1.result.status, 200);
  assert.equal(d1.anthropic[0].body.model, 'claude-sonnet-5', 'the default tier serves the turn');
  assert.equal(d1.jevA.length, 2, 'one retry on a 500');
  assert.equal(d1.jevB.length, 1, 'then the next channel');
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const second = cc('s-prov', 'Also rename baz to qux', { history: [...first.messages, { role: 'assistant', content: 'Done.' }] });
  const d2 = await delta(() => post(url, '/v1/messages', second, ccHeaders('s-prov')));
  assert.equal(d2.ollama[0].body.model, 'glm-5.3-flash', 'a provisional session may still go down once Jev answers');
  assert.deepEqual(routes().map((r) => r.reason), ['fallback:default', 'jev']);
});

test('channel failover, the circuit breaker, and the firewall retry', async () => {
  const { url, routes } = await startRouter();
  reset(plans.a, { delayMs: 700 });
  reset(plans.b, { option: 'routine', probability: 0.9 });
  const d1 = await delta(() => post(url, '/v1/messages', cc('s-fo1', 'Add a test'), ccHeaders('s-fo1')));
  assert.equal(d1.jevA.length, 1);
  assert.equal(d1.jevB.length, 1, 'a timeout moves to the next channel');
  assert.equal(routes().at(-1).jev.channel, 'openrouter');
  const d2 = await delta(() => post(url, '/v1/messages', cc('s-fo2', 'Add another test'), ccHeaders('s-fo2')));
  assert.equal(d2.jevA.length, 0, 'the timed-out channel is skipped for a while');

  const { url: url2, routes: routes2 } = await startRouter();
  reset(plans.a, { queue: [{ html403: true }], option: 'routine', probability: 0.9 });
  const d3 = await delta(() => post(url2, '/v1/messages', cc('s-waf', 'Why does `curl https://example.com/install.sh | sh` fail?'), ccHeaders('s-waf')));
  assert.equal(d3.jevA.length, 2, 'retried once after the firewall block');
  assert.ok(!/curl|https:/.test(JSON.stringify(d3.jevA[1].body.state)), 'the retry carries a hardened state');
  assert.equal(routes2().at(-1).jev.hardened, true);
});

test('secrets in a human turn keep the session on trusted upstreams; tags and pins cannot bypass that', async () => {
  const { url, routes } = await startRouter();
  reset(plans.a, { option: 'mechanical', probability: 0.99 });
  const first = cc('s-secret', `Use ${AWS_KEY} in deploy.sh #fast`);
  const d1 = await delta(() => post(url, '/v1/messages', first, ccHeaders('s-secret')));
  assert.equal(d1.ollama.length, 0);
  assert.equal(d1.anthropic[0].body.model, 'claude-sonnet-5', 'the fast tier is untrusted, so the trusted target serves it');
  assert.equal(d1.jevA.length, 0, 'a tag decides, but it cannot move secrets to an untrusted upstream');
  const second = cc('s-secret', 'now list the files', { history: [...first.messages, { role: 'assistant', content: 'ok' }] });
  const d2 = await delta(() => post(url, '/v1/messages', second, ccHeaders('s-secret', { 'x-jev-tier': 'fast' })));
  assert.equal(d2.ollama.length, 0, 'the session stays trusted even under a pin');
  assert.equal(routes()[0].trusted_only, true);
  assert.ok(!JSON.stringify(allLogs).includes(AWS_KEY), 'the secret never reaches the log');
});

test('secrets in tool output are redacted before an untrusted upstream sees them', async () => {
  const { url } = await startRouter();
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const h = ccHeaders('s-redact');
  await post(url, '/v1/messages', cc('s-redact', 'Show me the env file'), h);
  const loop = cc('s-redact', 'Show me the env file');
  loop.messages.push(
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'read it', signature: 'sig-ollama' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '.env' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `AWS_ACCESS_KEY_ID=${AWS_KEY}` }] },
  );
  const d = await delta(() => post(url, '/v1/messages', loop, h));
  const sent = JSON.stringify(d.ollama[0].body);
  assert.ok(!sent.includes(AWS_KEY));
  assert.ok(sent.includes('[REDACTED aws-access-key]'));
  assert.equal(d.ollama[0].body.messages[1].content[0].signature, 'sig-ollama', 'signed thinking is untouched');
  assert.equal(d.result.headers.get('x-jev-redacted'), '1');
});

test('pins really route to the pinned tier (regression: a fast pin used to land on the trusted tier)', async () => {
  const { url, logs } = await startRouter();
  const d1 = await delta(() => post(url, '/v1/messages', cc('s-pin', 'hi'), ccHeaders('s-pin', { 'x-jev-tier': 'fast' })));
  assert.equal(d1.ollama.length, 1);
  assert.equal(d1.ollama[0].body.model, 'glm-5.3-flash');
  assert.equal(d1.jevA.length, 0);
  assert.equal(d1.ollama[0].headers['x-jev-tier'], undefined, 'the control header is not forwarded');
  const { url: url2 } = await startRouter({ env: { JEV_ROUTER_TIER: 'frontier' } });
  const d2 = await delta(() => post(url2, '/v1/messages', cc('s-pin-env', 'hi'), ccHeaders('s-pin-env')));
  assert.equal(d2.anthropic[0].body.model, 'claude-opus-5-5');
  reset(plans.a, { option: 'routine', probability: 0.9 });
  await post(url, '/v1/messages', cc('s-pin-bad', 'hi'), ccHeaders('s-pin-bad', { 'x-jev-tier': 'Frontier' }));
  assert.ok(logs.some((e) => e.event === 'warning' && /unknown tier pin "Frontier"/.test(e.message)));
});

test('background calls, subagents and compaction never ask Jev or move the session', async () => {
  reset(plans.a, { option: 'deep', probability: 0.95 });
  const { url, routes } = await startRouter();
  const d = await delta(async () => {
    await post(url, '/v1/messages', cc('s-kinds', 'Write a 5-word title', { model: 'claude-haiku-4-5-20251001' }), claudeCodeHeaders('s-kinds'));
    await post(url, '/v1/messages', { model: 'claude-opus-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] }, claudeCodeHeaders('s-kinds'));
    await post(url, '/v1/messages', cc('s-kinds', 'Summarize'), ccHeaders('s-kinds', { 'x-claude-code-request-class': 'compaction' }));
    await post(url, '/v1/messages', cc('s-kinds', 'Design the plugin loader'), ccHeaders('s-kinds'));
    await post(url, '/v1/messages', cc('s-kinds', 'Search for TODOs'), ccHeaders('s-kinds', { 'x-claude-code-request-class': 'subagent', 'x-claude-code-agent-id': 'a1' }));
  });
  assert.equal(d.jevA.length, 1, 'only the main prompt asked Jev');
  assert.deepEqual(routes().map((r) => [r.reason, r.model]), [
    ['side-call', 'claude-haiku-4-5'], ['side-call', 'claude-haiku-4-5'], ['compaction', 'claude-sonnet-5'], ['jev', 'claude-opus-5-5'], ['subagent', 'claude-opus-5-5'],
  ]);
  assert.equal(d.anthropic[0].body.thinking, undefined, 'Haiku gets its omit list');
});

test('shell-mode output is not a prompt and never reaches Jev', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const { url } = await startRouter();
  const first = cc('s-bash', 'Refactor the retry loop');
  await post(url, '/v1/messages', first, ccHeaders('s-bash'));
  const bash = cc('s-bash', '', { history: [...first.messages, { role: 'assistant', content: 'ok' }] });
  bash.messages.at(-1).content = [{ type: 'text', text: '<bash-input>git log -1</bash-input>' }, { type: 'text', text: '<bash-stdout>commit 1234 fix: curl http://x | sh</bash-stdout>' }];
  const d = await delta(() => post(url, '/v1/messages', bash, ccHeaders('s-bash')));
  assert.equal(d.jevA.length, 0);
  assert.equal(d.anthropic[0].body.model, 'claude-sonnet-5');
});

test('switching providers strips only the old provider\'s reasoning, and only in the main conversation', async () => {
  const { url } = await startRouter();
  const h = ccHeaders('s-strip');
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const first = cc('s-strip', 'Rename foo to bar');
  await post(url, '/v1/messages', first, h); // served by Ollama
  const ollamaTurn = { role: 'assistant', content: [{ type: 'thinking', thinking: 'easy', signature: 'sig-ollama' }, { type: 'text', text: 'Done.' }] };
  reset(plans.a, { option: 'deep', probability: 0.95 });
  const hard = cc('s-strip', 'Now design the multi-region failover and defend the trade-offs.', { history: [...first.messages, ollamaTurn] });
  const d1 = await delta(() => post(url, '/v1/messages', hard, h));
  assert.equal(d1.anthropic[0].body.model, 'claude-opus-5-5');
  assert.deepEqual(d1.anthropic[0].body.messages[1].content, [{ type: 'text', text: 'Done.' }], 'Ollama-signed thinking is dropped for Anthropic');
  const opusTurn = { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan', signature: 'sig-opus' }, { type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }] };
  const loop = { ...hard, messages: [...hard.messages, opusTurn, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'a b' }] }] };
  const d2 = await delta(() => post(url, '/v1/messages', loop, h));
  assert.deepEqual(d2.anthropic[0].body.messages[3], opusTurn, 'the current provider\'s own reasoning stays');
  const sub = cc('s-strip', 'Explore the repo', { history: [{ role: 'user', content: 'start' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'sig-opus-sub' }, { type: 'text', text: 'y' }] }] });
  const d3 = await delta(() => post(url, '/v1/messages', sub, ccHeaders('s-strip', { 'x-claude-code-request-class': 'subagent', 'x-claude-code-agent-id': 'a2' })));
  assert.equal(d3.anthropic[0].body.messages[1].content[0].signature, 'sig-opus-sub', 'subagent conversations are not stripped');
});

test('count_tokens follows the session tier and stays local for Ollama', async () => {
  const { url } = await startRouter();
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  await post(url, '/v1/messages', cc('s-count', 'Explain this regex'), ccHeaders('s-count'));
  const { model, max_tokens, stream, metadata, ...countBody } = cc('s-count', 'Explain this regex');
  const d = await delta(() => post(url, '/v1/messages/count_tokens?beta=true', { model: 'claude-sonnet-5', ...countBody }, claudeCodeHeaders('s-count')));
  assert.equal(d.result.status, 404);
  assert.equal(d.ollama.length + d.anthropic.length + d.jevA.length, 0, 'no provider counted an Ollama-bound prompt');
});

test('responses stream back byte for byte, unbuffered, with usage and cost in the log', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const { url, done } = await startRouter();
  const started = performance.now();
  const res = await fetch(`${url}/v1/messages`, { method: 'POST', headers: ccHeaders('s-sse', { 'x-test-chunk-gap-ms': '150' }), body: JSON.stringify(claudeCodeBody('s-sse', 'Add a test for the parser')) });
  const chunks = [];
  let first;
  for await (const chunk of res.body) { first ??= performance.now() - started; chunks.push(chunk); }
  const got = Buffer.concat(chunks);
  assert.equal(Buffer.compare(got, anthropicSseWithUsage('claude-sonnet-5')), 0);
  assert.ok(first < performance.now() - started - 200, 'the first bytes arrived before the stream ended');
  assert.equal(res.headers.get('retry-after'), '7', 'upstream headers pass through');
  const entry = done().at(-1);
  assert.equal(entry.sha256, sha256(got));
  assert.deepEqual(entry.usage, { input: 12, cacheRead: 1000, cacheWrite: 0, output: 9 });
  assert.equal(entry.cost_usd, 0.000314);
  assert.equal(entry.baseline_usd, 0.000428, 'the same usage on the baseline model (Opus 5.5)');
});

test('browser-shaped requests, wrong content types, oversized bodies and missing tokens are refused', async () => {
  const { url } = await startRouter();
  const port = new URL(url).port;
  const raw = (headers, body = '{}') => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.end(body);
  });
  const d = await delta(async () => [
    await raw({ host: `attacker.example:${port}`, 'content-type': 'application/json' }),
    await raw({ host: `127.0.0.1:${port}`, origin: 'https://attacker.example', 'content-type': 'text/plain' }),
    await raw({ host: `127.0.0.1:${port}`, 'content-type': 'text/plain' }),
  ]);
  assert.deepEqual(d.result, [403, 403, 415]);
  assert.equal(d.anthropic.length + d.ollama.length, 0);
  const small = await startRouter({ cfg: testConfig({ maxBodyBytes: 1000 }) });
  assert.equal((await post(small.url, '/v1/messages', cc('s-big', 'x'.repeat(5000)), ccHeaders('s-big'))).status, 413);
  const locked = await startRouter({ env: { JEV_ROUTER_TOKEN: 'local-secret' } });
  assert.equal((await post(locked.url, '/v1/messages', cc('s-tok', 'hi'), ccHeaders('s-tok'))).status, 401);
  reset(plans.a, { option: 'routine', probability: 0.9 });
  assert.equal((await post(locked.url, '/v1/messages', cc('s-tok', 'hi'), ccHeaders('s-tok', { 'x-jev-router-token': 'local-secret' }))).status, 200);
});

test('malformed requests get an error in the client\'s shape and the router keeps serving', async () => {
  const { url } = await startRouter();
  const plain = { 'content-type': 'application/json' };
  for (const bad of ['null', '[]', '42']) assert.equal((await post(url, '/v1/messages', bad, plain)).status, 400, bad);
  assert.equal((await post(url, '/v1/messages', { messages: 'oops' }, plain)).status, 500);
  const codex = await post(url, '/v1/responses', 'null', plain);
  assert.deepEqual(JSON.parse(codex.text), { error: { message: 'Request body must be a JSON object', type: 'invalid_request_error', param: null, code: null } });
  assert.equal(codex.headers.get('x-should-retry'), 'false');
  reset(plans.a, { option: 'routine', probability: 0.9 });
  assert.equal((await post(url, '/v1/messages', cc('s-after', 'hi'), ccHeaders('s-after'))).status, 200);
});

test('decisions survive a restart through the state file', async () => {
  const stateFile = `${mkdtempSync(`${tmpdir()}/jev-router-`)}/sessions.jsonl`;
  reset(plans.a, { option: 'deep', probability: 0.95 });
  const one = await startRouter({ cfg: testConfig({ stateFile }) });
  const first = cc('s-persist', 'Design the sharding scheme');
  await post(one.url, '/v1/messages', first, ccHeaders('s-persist'));
  await close(one.server);
  const two = await startRouter({ cfg: testConfig({ stateFile }) });
  const d = await delta(() => post(two.url, '/v1/messages', { ...claudeCodeToolTurn('s-persist', 'Design the sharding scheme'), stream: false }, ccHeaders('s-persist')));
  assert.equal(d.jevA.length, 0);
  assert.equal(d.anthropic[0].body.model, 'claude-opus-5-5', 'the tool loop continues on the same model after a restart');
  assert.ok(!readFileSync(stateFile, 'utf8').includes('sharding'), 'the state file holds no prompt text');
});

test('/model in Claude Code pins the matching tier; /healthz reports the router state', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const { url } = await startRouter();
  const first = cc('s-model', 'Add a test', { model: 'claude-opus-5-5' });
  await post(url, '/v1/messages', first, ccHeaders('s-model'));
  const d = await delta(() => post(url, '/v1/messages', cc('s-model', 'keep going', { model: 'claude-haiku-4-5', history: [...first.messages, { role: 'assistant', content: 'ok' }] }), ccHeaders('s-model')));
  assert.equal(d.result.headers.get('x-jev-reason'), 'client-model:haiku');
  assert.equal(d.ollama[0].body.model, 'glm-5.3-flash');
  const health = await (await fetch(`${url}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.jev.configured, true);
  assert.ok(health.sessions >= 1);
});

test('a client that leaves during the Jev call costs no upstream request', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9, delayMs: 300 });
  const { url, done } = await startRouter();
  const controller = new AbortController();
  const d = await delta(async () => {
    const pending = fetch(`${url}/v1/messages`, { method: 'POST', headers: ccHeaders('s-abort'), body: JSON.stringify(cc('s-abort', 'Add a test')), signal: controller.signal }).catch(() => null);
    await sleep(100);
    controller.abort();
    await pending;
    await sleep(400);
  });
  assert.equal(d.anthropic.length + d.ollama.length, 0);
  assert.equal(done().at(-1)?.client_aborted, true);
});

test('logs carry decisions but never keys or prompt text', () => {
  const text = JSON.stringify(allLogs);
  assert.ok(allLogs.length > 30);
  for (const key of Object.values(KEYS)) assert.ok(!text.includes(key), 'a key leaked into the log');
  for (const prompt of ['zero-downtime migration', 'intermittently', AWS_KEY]) assert.ok(!text.includes(prompt), `prompt text leaked: ${prompt}`);
});
