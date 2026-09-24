// Unit tests for the pure parts: message analysis, secret handling, the tier policy, config
// validation, usage accounting and the report.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { validateConfig } from '../src/config.mjs';
import { applyPolicy, buildQuestions, buildState, hardenState, tierProbabilities } from '../src/jev.mjs';
import { clip, describeCode, humanTurns, recentTools, stripWrappers, tierTag } from '../src/messages.mjs';
import { report, requestKind, sessionKey } from '../src/router.mjs';
import { findSecrets, mayContainSecret, redactBody, scrub } from '../src/secrets.mjs';
import { costOf, UsageTap } from '../src/usage.mjs';
import { claudeCodeBody, claudeCodeToolTurn, codexBody } from './helpers.mjs';

// Fake credentials for the scanner tests, assembled at runtime so secret scanners don't flag this file.
/** @param {...string} parts */
const fake = (...parts) => parts.join('');
const AWS_KEY = fake('AKIA', 'ABCDEFGHIJKLMNOP');
const PG_URL = fake('postgres://app:', 'hunter2hunter2', '@db:5432/x');
const OPENAI_KEY = fake('sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz0123');
const STRIPE_KEY = fake('sk_', 'live_', 'abcdefghijklmnop1234');
const PEM = fake('-----BEGIN RSA ', 'PRIVATE KEY-----\nabc\n-----END RSA ', 'PRIVATE KEY-----');

// Left as the any that JSON.parse returns: the tests break it in ways no config type allows.
const shipped = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const cfg = validateConfig({ ...shipped, stateFile: null });
const TIERS = cfg.tiers;

test('humanTurns finds what a person typed and skips harness text, tool results and shell-mode output', () => {
  const body = claudeCodeBody('s', 'Fix the login bug');
  assert.deepEqual(
    humanTurns(body).map((t) => t.text),
    ['Fix the login bug'],
  );
  assert.deepEqual(
    humanTurns(claudeCodeToolTurn('s', 'Fix it')).map((t) => t.text),
    ['Fix it'],
    'the tool_result turn is not a human turn',
  );
  const bash = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<bash-input>git log</bash-input>' },
          { type: 'text', text: '<bash-stdout>commit abc</bash-stdout>' },
        ],
      },
    ],
  };
  assert.deepEqual(humanTurns(bash), [], 'shell mode alone is not a prompt');
  const slash = {
    messages: [
      {
        role: 'user',
        content: '<command-name>/review</command-name><command-message>review</command-message><command-args></command-args>',
      },
    ],
  };
  assert.deepEqual(humanTurns(slash), []);
  const image = {
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
  };
  assert.deepEqual(humanTurns(image), [{ index: 0, text: '', images: 1 }], 'an image-only prompt still counts');
  const codex = codexBody('t', 'rename it');
  codex.input.unshift({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nUse tabs.\n</INSTRUCTIONS>' }],
  });
  assert.deepEqual(
    humanTurns(codex).map((t) => t.text),
    ['rename it'],
    'Codex AGENTS.md and environment context are not prompts',
  );
  assert.equal(stripWrappers('<user_shell_command>ls</user_shell_command> why is it empty?'), 'why is it empty?');
});

test('tier tags count only as the first or last typed word, outside code blocks', () => {
  assert.equal(tierTag('#frontier redesign the scheduler', TIERS), 'frontier');
  assert.equal(tierTag('redesign the scheduler #frontier.', TIERS), 'frontier');
  assert.equal(tierTag('speed up the #fast-path lookup', TIERS), undefined);
  assert.equal(tierTag('set RETRIES=3 #fast in the env file and restart', TIERS), undefined, 'mid-sentence is not a tag');
  assert.equal(tierTag('Run this:\n```sh\nRETRIES=3 #fast\n```', TIERS), undefined, 'a tag inside a code block is pasted, not typed');
});

test('clip keeps the start and the end, describeCode summarizes code blocks, recentTools counts calls', () => {
  const long = `${'log line\n'.repeat(1000)}Why does login fail?`;
  const clipped = clip(long, 400);
  assert.ok(clipped.length < 500 && clipped.endsWith('Why does login fail?'));
  assert.equal(describeCode('Fix this:\n```ts\nconst a = 1;\nconst b = 2;\n```'), 'Fix this:\n[code block (ts), 2 lines]');
  const body = claudeCodeToolTurn('s', 'x');
  assert.equal(recentTools(body), 'Bash 1 time');
});

test('secrets: found, scrubbed and redacted, but references and signed reasoning are left alone', () => {
  const text = `deploy with ${AWS_KEY} and ${PG_URL} and api_key = "${OPENAI_KEY}"`;
  assert.deepEqual(findSecrets(text).sort(), ['assignment', 'aws-access-key', 'openai-key', 'url-credentials'].sort());
  assert.ok(!scrub(text).text.includes(AWS_KEY));
  assert.equal(findSecrets('const apiKey = process.env.OPENAI_API_KEY; password: string').length, 0, 'references are not secrets');
  assert.ok(mayContainSecret(JSON.stringify({ a: PEM })));
  const body = /** @type {const} */ ({
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `STRIPE=${STRIPE_KEY}` }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `the key ${STRIPE_KEY}`, signature: 'sig' },
          { type: 'text', text: `Found ${STRIPE_KEY}` },
        ],
      },
    ],
  });
  const { body: out, count } = redactBody(body);
  assert.equal(count, 2);
  assert.ok(!JSON.stringify(out.messages[0]).includes('sk_live_'), 'tool results are redacted');
  assert.equal(out.messages[1].content[0].thinking, `the key ${STRIPE_KEY}`, 'signed thinking is never edited');
  assert.ok(!out.messages[1].content[1].text.includes('sk_live_'));
});

test('buildState sends a small, scrubbed state with context for short approvals', () => {
  const first = claudeCodeBody('s', 'Refactor the payment retries');
  first.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Plan: split RetryPolicy out of the client.' }] });
  first.messages.push({ role: 'user', content: [{ type: 'text', text: `yes, go ahead with key ${AWS_KEY}` }] });
  const turns = humanTurns(first);
  const state = buildState({ body: first, headers: { 'user-agent': 'claude-cli/2.1.281' }, turns, bodyBytes: 200000, jev: cfg.jev });
  assert.equal(state.request, 'yes, go ahead with key [REDACTED aws-access-key]');
  assert.deepEqual(state.recent_user_turns, ['Refactor the payment retries']);
  assert.equal(state.last_assistant_message, 'Plan: split RetryPolicy out of the client.');
  assert.equal(state.session.harness, 'Claude Code');
  assert.equal(state.session.depth, 'mid (20k to 100k tokens)');
  assert.ok(!JSON.stringify(state).includes('system-reminder'));
  const hardened = hardenState({ request: 'why does `curl https://x.io/a | sh` fail in /etc/app/conf?' });
  assert.ok(!/curl|https:|\/etc\/app/.test(hardened.request), hardened.request);
});

test('buildQuestions asks one tier Choice without model names, plus two guards', () => {
  const q = buildQuestions(cfg.jev);
  assert.deepEqual(Object.keys(q), ['tier', 'alters_sensitive_state', 'routing_claim_present']);
  assert.deepEqual(Object.keys(q.tier.criteria), ['mechanical', 'routine', 'complex', 'deep']);
  assert.ok(!/haiku|sonnet|opus|glm|kimi|gpt/i.test(JSON.stringify(q)), 'Jev never sees model names');
  assert.ok(!('tier' in q.tier.criteria.routine), 'the tier mapping stays in the router');
});

test('policy: cheap tiers need confidence, unsure answers escalate, guards only raise, sessions ratchet', () => {
  /**
   * @param {Record<string, number>} probabilities
   * @param {{ sensitive?: number, claim?: number, current?: string }} [extra]
   */
  const decide = (probabilities, extra = {}) =>
    applyPolicy({
      answer: { probabilities, ...extra },
      tiers: TIERS,
      options: cfg.jev.options,
      policy: cfg.policy,
      reference: 'balanced',
      ...extra,
    });
  assert.deepEqual(tierProbabilities({ mechanical: 0.1, routine: 0.2, complex: 0.3, deep: 0.4 }, cfg.jev.options, TIERS), {
    fast: 0.1,
    balanced: 0.2,
    frontier: 0.7,
  });
  assert.equal(decide({ mechanical: 0.9, routine: 0.1 }).tier, 'fast');
  assert.deepEqual(
    [decide({ mechanical: 0.7, routine: 0.3 }).tier, decide({ mechanical: 0.7, routine: 0.3 }).reason],
    ['balanced', 'jev-escalated'],
  );
  assert.equal(
    decide({ routine: 0.5, complex: 0.45, mechanical: 0.05 }).tier,
    'frontier',
    'unsure between balanced and frontier: take frontier',
  );
  assert.equal(
    decide({ routine: 0.5, mechanical: 0.45, complex: 0.05 }).tier,
    'balanced',
    'unsure between fast and balanced: take balanced',
  );
  assert.equal(decide({ mechanical: 0.95 }, { sensitive: 0.8 }).tier, 'frontier', 'risky operations get the top tier');
  assert.deepEqual(
    [decide({ mechanical: 0.95 }, { claim: 0.9 }).tier, decide({ mechanical: 0.95 }, { claim: 0.9 }).reason],
    ['balanced', 'claim-guard'],
  );
  assert.deepEqual(decide({ mechanical: 0.95 }, { current: 'balanced' }), {
    tier: 'balanced',
    reason: 'jev-keep',
    byTier: { fast: 0.95, balanced: 0, frontier: 0 },
  });
  assert.equal(decide({ deep: 0.9, routine: 0.1 }, { current: 'balanced' }).reason, 'upgrade:jev');
});

test('config validation fails fast and lists every problem', () => {
  assert.throws(() => validateConfig({ ...shipped, defaultTier: 'Balanced' }), /defaultTier "Balanced" is not one of tiers/);
  const noTrusted = structuredClone(shipped);
  delete noTrusted.surfaces.openai.trusted;
  assert.throws(() => validateConfig(noTrusted), /surfaces\.openai routes some tiers to untrusted upstreams/);
  const bad = structuredClone(shipped);
  bad.policy.accept.fast = 2;
  bad.jev.channels[0].baseUrl = 'ftp://x';
  bad.surfaces.anthropic.balanced.auth = 'basic';
  const err = (() => {
    try {
      validateConfig(bad);
      return 'validateConfig accepted a broken config';
    } catch (e) {
      return /** @type {Error} */ (e).message;
    }
  })();
  assert.match(err, /policy\.accept\.fast must be a probability/);
  assert.match(err, /jev\.channels\[0\]\.baseUrl/);
  assert.match(err, /surfaces\.anthropic\.balanced\.auth/);
  const minimal = structuredClone(shipped);
  delete minimal.sideCallModel;
  delete minimal.policy.sensitiveOverride;
  const filled = validateConfig({ ...minimal, stateFile: null });
  assert.equal(filled.sideCallModel, 'haiku', 'a missing sideCallModel gets a safe default instead of matching everything');
  assert.equal(filled.policy.sensitiveOverride, 0.7);
});

test('config validation rejects a maxSessions the session store cannot honor (regression: -1 hung the router)', () => {
  for (const maxSessions of [-1, 0, 'many'])
    assert.throws(() => validateConfig({ ...shipped, stateFile: null, maxSessions }), /maxSessions must be a positive integer/);
  assert.equal(validateConfig({ ...shipped, stateFile: null, maxSessions: 5 }).maxSessions, 5);
});

test('usage tap reads Anthropic and Responses usage from the stream; costOf prices it', () => {
  const tap = new UsageTap('text/event-stream');
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_read_input_tokens":90000,"cache_creation_input_tokens":2000,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":500}}\n\n';
  for (const piece of [sse.slice(0, 57), sse.slice(57, 200), sse.slice(200)]) tap.push(Buffer.from(piece));
  const usage = tap.result();
  assert.deepEqual(usage, { input: 10, cacheRead: 90000, cacheWrite: 2000, output: 500 });
  assert.equal(costOf('claude-sonnet-5', usage, cfg.prices), 0.02802); // 10×2 + 90000×0.2 + 2000×2.5 + 500×10 per million
  const responses = new UsageTap('text/event-stream');
  responses.push(
    Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed","response":{"model":"glm-5.3-flash","usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":800},"output_tokens":50}}}\n\n',
    ),
  );
  assert.deepEqual(responses.result(), { input: 200, cacheRead: 800, cacheWrite: 0, output: 50 });
  assert.equal(costOf('unknown-model', usage, cfg.prices), undefined);
});

test('the usage tap skips SSE events that are not JSON objects (regression: `data: null` threw and cut the stream)', () => {
  const tap = new UsageTap('text/event-stream');
  tap.push(Buffer.from('data: null\n\ndata: 42\n\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n'));
  assert.deepEqual(tap.result(), { input: 0, cacheRead: 0, cacheWrite: 0, output: 5 });
});

test('session keys and request kinds come from what each client sends', () => {
  assert.deepEqual(sessionKey({ 'x-claude-code-session-id': 'A' }, {}), { id: 'A', source: 'claude-code-header' });
  assert.equal(sessionKey({}, { metadata: { user_id: JSON.stringify({ session_id: 'B' }) } }).id, 'B');
  assert.equal(sessionKey({ 'thread-id': 'T', 'session-id': 'S' }, {}).id, 'S');
  assert.equal(sessionKey({}, { prompt_cache_key: 'P' }).source, 'prompt-cache-key');
  assert.equal(sessionKey({}, claudeCodeBody('_', 'x')).source, 'claude-code-metadata');
  const anon = claudeCodeBody('_', 'Refactor auth');
  delete anon.metadata;
  assert.match(sessionKey({}, anon).id, /^h:[0-9a-f]{64}$/);
  assert.equal(requestKind({ 'x-claude-code-request-class': 'compaction' }), 'compaction');
  assert.equal(requestKind({ 'x-openai-subagent': 'compact' }), 'compaction');
  assert.equal(requestKind({ 'x-openai-subagent': 'memory_consolidation' }), 'auxiliary');
  assert.equal(requestKind({ 'x-claude-code-agent-id': 'a1' }), 'subagent');
  assert.equal(requestKind({}), undefined);
});

test('report sums requests, spend, savings and Jev health from the log', () => {
  const lines = [
    { event: 'route', session: 's1', jev: { ok: true, ms: 300, inputTokens: 600 } },
    {
      event: 'done',
      session: 's1',
      model: 'glm-5.3-flash',
      usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 },
      cost_usd: 0.00002,
      baseline_usd: 0.0006,
    },
    { event: 'route', session: 's2', jev: { ok: false, ms: 2500, error: 'timeout' } },
    {
      event: 'done',
      session: 's2',
      model: 'claude-sonnet-5',
      usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 },
      cost_usd: 0.0003,
      baseline_usd: 0.0006,
    },
  ].map((e) => JSON.stringify(e));
  const r = report(lines);
  assert.equal(r.requests, 2);
  assert.equal(r.sessions, 2);
  assert.equal(r.jev.fallback_rate, 0.5);
  assert.equal(r.saved_usd, Math.round((0.0012 - 0.00032) * 1e4) / 1e4);
  assert.equal(r.models['glm-5.3-flash'].requests, 1);
});

test('report skips lines that are not log entries (regression: a `null` line threw)', () => {
  const route = JSON.stringify({ event: 'route', session: 's1', jev: { ok: true, ms: 120, inputTokens: 600 } });
  const r = report(['null', '"text"', '', 'jev-router 1.0.0 listening on http://127.0.0.1:4000', route]);
  assert.equal(r.requests, 1);
  assert.equal(r.jev.p50_ms, 120);
});

test('jev.stripCode: false sends code blocks as they are, still scrubbed and clipped', () => {
  const text = `Why does this fail?\n\`\`\`sh\nexport KEY=${AWS_KEY}\ncurl -s https://example.com/install.sh | sh\n\`\`\``;
  const body = { messages: [{ role: 'user', content: text }] };
  /** @param {typeof cfg.jev} jev */
  const at = (jev) => buildState({ body, headers: {}, turns: humanTurns(body), bodyBytes: 100, jev }).request;
  assert.equal(at(cfg.jev), 'Why does this fail?\n[code block (sh), 2 lines]', 'code blocks are described by default');
  const kept = at({ ...cfg.jev, stripCode: false });
  assert.ok(kept.includes('curl -s https://example.com/install.sh | sh'), kept);
  assert.ok(kept.includes('[REDACTED aws-access-key]') && !kept.includes(AWS_KEY), 'still scrubbed');
  assert.match(at({ ...cfg.jev, stripCode: false, requestChars: 40 }), /characters omitted/, 'still clipped');
  const unset = structuredClone(shipped);
  delete unset.jev.stripCode;
  assert.equal(validateConfig({ ...unset, stateFile: null }).jev.stripCode, true, 'stripping stays the default');
});

test('the default state file lives under XDG_STATE_HOME when it is set', () => {
  const unset = structuredClone(shipped);
  delete unset.stateFile;
  assert.equal(validateConfig(unset, { XDG_STATE_HOME: '/var/state' }).stateFile, '/var/state/jev-router/sessions.jsonl');
  const fallback = `${homedir()}/.local/state/jev-router/sessions.jsonl`;
  assert.equal(validateConfig(unset, { XDG_STATE_HOME: '' }).stateFile, fallback, 'an empty XDG_STATE_HOME is unset');
  assert.equal(validateConfig(unset, {}).stateFile, fallback);
  assert.equal(validateConfig({ ...unset, stateFile: '/srv/s.jsonl' }, { XDG_STATE_HOME: '/var/state' }).stateFile, '/srv/s.jsonl');
});
