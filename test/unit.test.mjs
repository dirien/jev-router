// Unit tests for the parts that need no router: message analysis, secret handling, the tier policy,
// the Jev client (against a fake fetch), config validation, session state, usage accounting and the report.

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { test } from 'node:test';
import { loadConfig, validateConfig } from '../src/config.mjs';
import { applyPolicy, buildQuestions, buildState, hardenState, JevClient, tierProbabilities } from '../src/jev.mjs';
import { appendLogLine } from '../src/logfile.mjs';
import { clip, describeCode, harness, header, humanTurns, recentTools, stripWrappers, tierTag } from '../src/messages.mjs';
import { report, requestKind, sessionKey } from '../src/router.mjs';
import { findSecrets, mayContainSecret, redactBody, scrub } from '../src/secrets.mjs';
import { hashKey, SessionStore } from '../src/sessions.mjs';
import { costOf, UsageTap } from '../src/usage.mjs';
import { claudeCodeBody, claudeCodeToolTurn, codexBody, jevOptionsAnswer } from './helpers.mjs';

/** @import { FetchLike, JevConfig, JevState, SessionEntry } from '../src/types.js' */

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

test('harness tells the clients apart, and header() reads one string value', () => {
  assert.equal(harness({ 'user-agent': 'codex_exec/0.156.1' }), 'Codex CLI');
  assert.equal(harness({ originator: 'codex_cli_rs' }), 'Codex CLI');
  assert.equal(harness({ 'user-agent': 'curl/8.7.1' }), 'unknown');
  assert.equal(header({ 'x-openai-subagent': 'review' }, 'x-openai-subagent'), 'review');
  assert.equal(header({ 'set-cookie': ['a=1', 'b=2'] }, 'set-cookie'), undefined, 'only set-cookie is ever a list');
  assert.equal(requestKind({ 'x-openai-subagent': 'review' }), 'subagent');
});

test('secret patterns: every kind is found and scrubbed, and references are not secrets', () => {
  /** @type {Record<string, string>} */
  const samples = {
    'private-key': fake('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaA\n'),
    'anthropic-key': fake('sk-', 'ant-', 'api03-', 'A'.repeat(24)),
    'openrouter-key': fake('sk-', 'or-', 'v1-', 'a1'.repeat(16)),
    'openai-key': fake('sk-', 'svcacct-', 'b'.repeat(24)),
    'aws-access-key': fake('ASIA', 'ZYXWVUTSRQPONMLK'),
    'aws-secret-key': fake('aws_secret_', 'access_key = ', 'A'.repeat(40)),
    'github-token': fake('gh', 'p_', 'c'.repeat(36)),
    'gitlab-token': fake('gl', 'pat-', 'd'.repeat(20)),
    'slack-token': fake('xo', 'xb-', '1234567890-abc'),
    'stripe-key': fake('rk_', 'test_', 'e'.repeat(16)),
    'google-api-key': fake('AI', 'za', 'f'.repeat(35)),
    'pulumi-token': fake('pul-', 'a'.repeat(40)),
    jwt: fake('ey', 'JhbGciOiJIUzI1', '.ey', 'JzdWIiOiIxMjM0', '.', 'signature12'),
    'url-credentials': fake('https://deploy:', 's3cretpass', '@git.example.com/repo.git'),
    assignment: fake('client_secret: "', 'q'.repeat(12), '"'),
  };
  for (const [kind, sample] of Object.entries(samples)) {
    assert.ok(findSecrets(`before ${sample} after`).includes(kind), kind);
    assert.ok(mayContainSecret(sample), `${kind}: the quick check agrees`);
    assert.ok(scrub(sample).text.includes(`[REDACTED ${kind}]`), `${kind} is scrubbed`);
  }
  assert.ok(findSecrets(fake('github_', 'pat_', 'g'.repeat(40))).includes('github-token'));
  assert.ok(findSecrets(fake('sk-', 'h'.repeat(40))).includes('openai-key'));
  const references = [
    'password = $DB_PASSWORD',
    fake('password = $', '{DB_PASSWORD}'),
    'api_key: <your-key-here>',
    'auth_token: {{ secrets.TOKEN }}',
    'secret = os.environ["APP_SECRET"]',
    'password: ***hidden***',
    'apiKey = env.API_KEY',
    'pwd=short',
  ];
  for (const text of references) assert.deepEqual(findSecrets(text), [], text);
  assert.deepEqual(scrub('nothing to see').count, 0);
});

test('loadConfig reads and validates a file, and names the file it cannot read', () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-config-`);
  assert.throws(() => loadConfig(`${dir}/missing.json`), /^Error: Cannot read config .*missing\.json: ENOENT/);
  writeFileSync(`${dir}/broken.json`, '{ "tiers": [');
  assert.throws(() => loadConfig(`${dir}/broken.json`), /Cannot read config .*broken\.json: /);
  writeFileSync(`${dir}/ok.json`, JSON.stringify({ ...shipped, stateFile: '~/state/s.jsonl', logFile: '~/logs/router.log' }));
  const loaded = loadConfig(`${dir}/ok.json`, {});
  assert.equal(loaded.stateFile, `${homedir()}/state/s.jsonl`, 'a leading ~ is the home directory');
  assert.equal(loaded.logFile, `${homedir()}/logs/router.log`);
  assert.equal(loadConfig(new URL(`file://${dir}/ok.json`)).port, 4000, 'a file URL works too');
});

test('config validation names each kind of problem', () => {
  /** @type {Array<[(raw: typeof shipped) => void, RegExp]>} */
  const cases = [
    [(c) => (c.port = 0), /port must be an integer between 1 and 65535/],
    [(c) => (c.allowedHosts = 'localhost:4000'), /allowedHosts must be an array/],
    [(c) => (c.tiers = []), /tiers must list tier names/],
    [(c) => (c.policy.mode = 'eager'), /policy\.mode must be "ratchet" or "sticky"/],
    [(c) => (c.policy.accept.turbo = 0.5), /policy\.accept names unknown tier "turbo"/],
    [(c) => (c.policy.claimGuard = 1.5), /policy\.claimGuard must be a probability/],
    [(c) => (c.jev.channels = [{ baseUrl: 'https://jev.example' }]), /jev\.channels\[0\]\.name is required/],
    [(c) => (c.jev.channels = [{ name: 'x', baseUrl: 'https://jev.example' }]), /jev\.channels\[0\]\.model is required/],
    [(c) => (c.jev.channels = [{ name: 'x', baseUrl: 'https://jev.example', model: 'm' }]), /jev\.channels\[0\]\.keyEnv is required/],
    [(c) => (c.jev.question = ''), /jev\.question is required/],
    [(c) => (c.jev.options = { only: { tier: 'fast' } }), /jev\.options needs at least two options/],
    [(c) => (c.jev.options.routine.tier = 'turbo'), /jev\.options\.routine\.tier must be one of tiers/],
    [(c) => delete c.surfaces, /surfaces is required/],
    [(c) => delete c.surfaces.anthropic.frontier, /surfaces\.anthropic has no target for tier "frontier"/],
    [(c) => (c.surfaces.openai.frontier.url = 'not a url'), /surfaces\.openai\.frontier\.url must be an http\(s\) URL/],
    [(c) => (c.surfaces.openai.frontier.model = ''), /surfaces\.openai\.frontier\.model is required/],
    [(c) => delete c.surfaces.openai.frontier.keyEnv, /surfaces\.openai\.frontier needs keyEnv or clientAuth/],
    [(c) => (c.surfaces.anthropic.side.omit = 'thinking'), /surfaces\.anthropic\.side\.omit must be a list of field paths/],
    [(c) => (c.surfaces.anthropic.side.maxOutputTokens = 0), /surfaces\.anthropic\.side\.maxOutputTokens must be a positive whole number/],
    [(c) => (c.surfaces.anthropic.side.foldSystemMessages = 'yes'), /surfaces\.anthropic\.side\.foldSystemMessages must be true or false/],
    [(c) => (c.surfaces.anthropic.side.omitBetas = 'context-1m'), /surfaces\.anthropic\.side\.omitBetas must be a list of beta names/],
    [(c) => (c.modelPins.opus = 'turbo'), /modelPins\.opus must be one of tiers/],
    [(c) => (c.host = ''), /host must be an address or a host name/],
    [(c) => (c.allowedHosts = ['localhost:4000', 4000]), /allowedHosts must be an array of host\[:port\] strings/],
    [(c) => (c.allowedOrigins = 'https://app.example'), /allowedOrigins must be an array of origins/],
    [(c) => (c.maxBodyBytes = '32mb'), /maxBodyBytes must be a whole number of bytes above 0/],
    [(c) => (c.maxBodyBytes = 0), /maxBodyBytes must be a whole number of bytes above 0/],
    [(c) => (c.sideCallModel = '('), /sideCallModel must be a regular expression/],
    [(c) => (c.pinOnModelChange = 'false'), /pinOnModelChange must be true or false/],
    [(c) => (c.policy.maxProvisional = -1), /policy\.maxProvisional must be a whole number, 0 or more/],
    [(c) => (c.policy.idleResetMinutes = '10'), /policy\.idleResetMinutes must be a number of minutes/],
    [(c) => (c.policy.failClosed = 'false'), /policy\.failClosed must be true or false/],
    [(c) => (c.jev.deadlineMs = '2500'), /jev\.deadlineMs must be a whole number of milliseconds above 0/],
    [(c) => (c.jev.requestChars = 0), /jev\.requestChars must be a whole number above 0/],
    [(c) => (c.jev.stripCode = 'no'), /jev\.stripCode must be true or false/],
    [(c) => (c.jev.guards = 1), /jev\.guards must be true or false/],
    [(c) => (c.jev.channels[0].timeoutMs = 'fast'), /jev\.channels\[0\]\.timeoutMs must be a whole number of milliseconds above 0/],
  ];
  for (const [change, message] of cases) {
    const raw = structuredClone(shipped);
    change(raw);
    assert.throws(() => validateConfig({ ...raw, stateFile: null }), message, String(message));
  }
  // A number would be taken for a file descriptor.
  assert.throws(() => validateConfig({ ...shipped, stateFile: 5 }), /stateFile must be a file path or null/);
  assert.equal(
    validateConfig({ ...shipped, stateFile: null, policy: { ...shipped.policy, idleResetMinutes: 0.5 } }).policy.idleResetMinutes,
    0.5,
  );
});

/** @type {(request: string) => JevState} */
const stateOf = (request) => ({ request, session: { harness: 'Claude Code', depth: 'new session' } });
/** @type {JevConfig} */
const JEV = {
  ...cfg.jev,
  deadlineMs: 2000,
  channels: [
    { name: 'one', baseUrl: 'http://one.invalid', model: 'jev-1.13.0', keyEnv: 'ONE_KEY', timeoutMs: 500 },
    { name: 'two', baseUrl: 'http://two.invalid/', model: 'jev-1.13.0', keyEnv: 'TWO_KEY', timeoutMs: 500 },
  ],
};
/**
 * @param {number} status
 * @param {unknown} body a string is sent as is
 * @param {Record<string, string>} [headers]
 */
const reply = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const good = () => reply(200, jevOptionsAnswer({ option: 'routine', probability: 0.9 }));

/**
 * A reply that never comes: it waits for the call's signal. The pending timer keeps the event loop
 * alive meanwhile, which AbortSignal.timeout's own timer doesn't.
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
const hang = (init) =>
  new Promise((_, reject) => {
    const alive = setTimeout(() => reject(new Error('the call was never aborted')), 5000);
    init.signal?.addEventListener('abort', () => {
      clearTimeout(alive);
      reject(init.signal?.reason);
    });
  });

/**
 * A Jev client whose channels answer from a script: each host's replies are used up in order.
 * @param {Record<string, Array<(init: RequestInit) => Response | Promise<Response>>>} script
 * @param {{ env?: Record<string, string>, jev?: JevConfig }} [options]
 */
function scripted(script, { env = { ONE_KEY: 'key-one', TWO_KEY: 'key-two' }, jev = JEV } = {}) {
  /** @type {Array<{ host: string, init: RequestInit }>} */
  const calls = [];
  /** @type {FetchLike} */
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host;
    calls.push({ host, init });
    const next = script[host]?.shift();
    if (!next) throw new Error(`no scripted reply for ${host}`);
    return next(init);
  };
  return { client: new JevClient(jev, env, { fetchImpl }), calls };
}

test('Jev client: 401, 402 and a JSON 403 skip the channel for five minutes and move on', async () => {
  for (const status of [401, 402, 403]) {
    const { client, calls } = scripted({
      'one.invalid': [() => reply(status, { error: { message: 'bad key' } })],
      'two.invalid': [good, good],
    });
    const before = Date.now();
    const answer = await client.decide(stateOf('Add a test'));
    assert.ok(answer.ok && answer.channel === 'two', `${status}: the next channel answers`);
    const one = client.health().one;
    assert.equal(one.open, true);
    assert.ok(one.openUntil >= before + 300000 && one.openUntil <= Date.now() + 300000, `${status}: open for five minutes`);
    assert.equal(one.lastError, `HTTP ${status} bad key`);
    await client.decide(stateOf('Add another test'));
    assert.deepEqual(
      calls.map((c) => c.host),
      ['one.invalid', 'two.invalid', 'two.invalid'],
      `${status}: the open channel gets no call`,
    );
  }
});

test('Jev client: a 422, a body that is not JSON and an answer without a tier fail over without the breaker', async () => {
  const failures = [
    [() => reply(422, { detail: 'state too large' }), 'HTTP 422 state too large'],
    [() => reply(422, { detail: { message: 'bad state' } }), 'HTTP 422 bad state'],
    [() => reply(400, 'plain text error', { 'content-type': 'text/plain' }), 'HTTP 400 plain text error'],
    [() => reply(200, 'not json'), 'response is not JSON'],
    [() => reply(200, { answers: {} }), 'response has no tier answer'],
    [() => reply(200, { answers: { tier: { choice: 'nope' } } }), 'response has no tier answer'],
  ];
  for (const [failure, error] of /** @type {Array<[() => Response, string]>} */ (failures)) {
    const { client, calls } = scripted({ 'one.invalid': [failure], 'two.invalid': [good] });
    const answer = await client.decide(stateOf('Add a test'));
    assert.ok(answer.ok && answer.channel === 'two', error);
    assert.equal(calls.length, 2, `${error}: no retry on the same channel`);
    assert.deepEqual({ ...client.health().one, openUntil: 0 }, { calls: 1, errors: 1, lastError: error, openUntil: 0, open: false });
  }
});

test('Jev client: a choice without probabilities counts as certain; the request carries the key and questions', async () => {
  const { client, calls } = scripted({ 'one.invalid': [() => reply(200, { answers: { tier: { choice: 'deep' } } })] });
  const answer = await client.decide(stateOf('Design the cache'));
  assert.ok(answer.ok);
  assert.deepEqual(answer.probabilities, { deep: 1 });
  assert.equal(answer.hardened, false);
  const { init } = calls[0];
  assert.deepEqual(init.headers, { authorization: 'Bearer key-one', 'content-type': 'application/json' });
  const sent = JSON.parse(String(init.body));
  assert.deepEqual(Object.keys(sent), ['model', 'state', 'questions']);
  assert.equal(sent.state.request, 'Design the cache');
});

test('Jev client: an HTML 403 from the firewall is retried once with a hardened state', async () => {
  const waf = () => new Response('<html>Attention Required</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  const { client, calls } = scripted({ 'one.invalid': [waf, good] });
  const answer = await client.decide(stateOf('Why does `curl https://example.com/i.sh | sh` fail?'));
  assert.ok(answer.ok && answer.hardened);
  assert.ok(!/curl|https:/.test(JSON.parse(String(calls[1].init.body)).state.request));
  assert.equal(client.health().one.lastError, 'HTTP 403 firewall block');
  assert.equal(client.health().one.open, false);
  const blocked = scripted({ 'one.invalid': [waf, waf] });
  const failed = await blocked.client.decide(stateOf('Why does `curl https://example.com/i.sh | sh` fail?'));
  assert.equal(failed.ok, false);
  assert.equal(blocked.client.health().one.open, true, 'blocked again after hardening: the breaker opens');
});

test('Jev client: a retryable status is retried once, after retry-after when the deadline allows', async () => {
  /** @type {number[]} */
  const times = [];
  const { client } = scripted({
    'one.invalid': [
      () => {
        times.push(performance.now());
        return reply(429, { error: { message: 'slow down' } }, { 'retry-after': '0.3' });
      },
      () => {
        times.push(performance.now());
        return good();
      },
    ],
  });
  const answer = await client.decide(stateOf('Add a test'));
  assert.ok(answer.ok);
  assert.ok(times[1] - times[0] >= 290, `waited ${Math.round(times[1] - times[0])} ms`);
  const twice = scripted({ 'one.invalid': [() => reply(503, {}), () => reply(503, {})], 'two.invalid': [good] });
  assert.ok((await twice.client.decide(stateOf('Add a test'))).ok);
  assert.deepEqual(
    twice.calls.map((c) => c.host),
    ['one.invalid', 'one.invalid', 'two.invalid'],
    'one retry, then the next channel',
  );
});

test('Jev client: timeouts and network errors skip the channel for 30 seconds', async () => {
  const refused = () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
  };
  const jev = { ...JEV, channels: JEV.channels.map((ch) => ({ ...ch, timeoutMs: 100 })) };
  for (const [failure, error] of /** @type {Array<[(init: RequestInit) => Promise<Response>, string]>} */ ([
    [hang, 'timeout after 100 ms'],
    [refused, 'ECONNREFUSED'],
  ])) {
    const { client } = scripted({ 'one.invalid': [failure], 'two.invalid': [good] }, { jev });
    const before = Date.now();
    assert.ok((await client.decide(stateOf('Add a test'))).ok);
    const one = client.health().one;
    assert.equal(one.lastError, error);
    assert.ok(one.open && one.openUntil >= before + 30000 && one.openUntil <= Date.now() + 30000, `${error}: open for 30 s`);
  }
});

test('Jev client: a client that goes away ends the decision without counting an error', async () => {
  const controller = new AbortController();
  const { client } = scripted({ 'one.invalid': [hang] });
  setTimeout(() => controller.abort(), 50);
  const answer = await client.decide(stateOf('Add a test'), { signal: controller.signal });
  assert.equal(answer.ok, false);
  assert.ok(!answer.ok && answer.aborted && answer.error === 'client went away');
  assert.equal(client.health().one.errors, 0);
});

test('Jev client: a client gone before the first call or between retries is an abort, not a Jev failure', async () => {
  const gone = scripted({ 'one.invalid': [good] });
  const before = await gone.client.decide(stateOf('Add a test'), { signal: AbortSignal.abort() });
  assert.ok(!before.ok && before.aborted, 'already gone: aborted');
  assert.equal(gone.calls.length, 0, 'and no call is made');
  const controller = new AbortController();
  const retrying = scripted({ 'one.invalid': [() => reply(503, {}, { 'retry-after': '0.3' }), good], 'two.invalid': [good] });
  setTimeout(() => controller.abort(), 100);
  const between = await retrying.client.decide(stateOf('Add a test'), { signal: controller.signal });
  assert.ok(!between.ok && between.aborted && between.error === 'client went away', 'gone while waiting to retry: aborted');
  assert.deepEqual(
    retrying.calls.map((call) => call.host),
    ['one.invalid'],
    'no retry and no next channel',
  );
});

test('Jev client: JEV_BASE_URL and JEV_API_KEY add a channel in front; keyless channels are dropped', async () => {
  const env = { JEV_BASE_URL: 'http://env.invalid', JEV_API_KEY: 'key-env', JEV_MODEL: 'jev-1.14.0' };
  const { client, calls } = scripted({ 'env.invalid': [good] }, { env });
  assert.deepEqual(Object.keys(client.health()), ['env'], 'config channels without a key are dropped');
  assert.ok((await client.decide(stateOf('Add a test'))).ok);
  assert.deepEqual(calls[0].init.headers, { authorization: 'Bearer key-env', 'content-type': 'application/json' });
  assert.equal(JSON.parse(String(calls[0].init.body)).model, 'jev-1.14.0');
  const none = new JevClient(JEV, {});
  assert.equal(none.configured, false);
  const nothing = await none.decide(stateOf('Add a test'));
  assert.ok(!nothing.ok && nothing.error === 'no Jev channel is configured');
});

/**
 * @param {string} tier
 * @returns {SessionEntry}
 */
const entry = (tier) => ({ tier, trustedOnly: false, provisional: false, attempts: 0, freshNext: false });

test('sessions: the state file survives a restart, is compacted on load, and drops expired sessions and a torn last line', () => {
  const file = `${mkdtempSync(`${tmpdir()}/jev-sessions-`)}/nested/sessions.jsonl`;
  const one = new SessionStore({ file });
  one.set('alpha', entry('fast'));
  one.set('beta', entry('balanced'));
  one.set('alpha', entry('frontier'));
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3, 'every change is appended');
  const old = { k: hashKey('old'), ...entry('fast'), updated: Date.now() - 8 * 24 * 3600 * 1000 };
  appendFileSync(file, `${JSON.stringify(old)}\n{"k":"torn`);
  /** @type {unknown[]} */
  const errors = [];
  const two = new SessionStore({ file, onError: (err) => errors.push(err) });
  assert.deepEqual(errors, []);
  assert.equal(two.size, 2, 'the expired session is dropped');
  assert.equal(two.get('alpha')?.tier, 'frontier', 'the last line for a session wins');
  assert.equal(two.get('beta')?.tier, 'balanced');
  assert.equal(two.get('old'), undefined);
  const beta = two.get('beta');
  assert.equal(beta?.lastSeen, beta?.updated, 'a loaded session was last seen when it was stored');
  const text = readFileSync(file, 'utf8');
  assert.equal(text.trim().split('\n').length, 2, 'rewritten with one line per live session');
  assert.ok(!text.includes('lastSeen') && !/alpha|beta/.test(text), 'only hashed keys, and no activity times');
});

test('sessions: the least recently used session goes first, in memory and when the file is loaded', () => {
  const store = new SessionStore({ max: 2 });
  store.set('a', entry('fast'));
  store.set('b', entry('fast'));
  assert.ok(store.get('a'), 'reading a makes it the most recently used');
  store.set('c', entry('fast'));
  assert.equal(store.get('b'), undefined);
  assert.ok(store.get('a') && store.get('c'));
  store.touch('a');
  store.touch('missing');
  assert.ok(store.get('a')?.lastSeen);
  const file = `${mkdtempSync(`${tmpdir()}/jev-sessions-`)}/sessions.jsonl`;
  const writer = new SessionStore({ file });
  for (const key of ['x', 'y', 'z']) writer.set(key, entry('balanced'));
  const reader = new SessionStore({ file, max: 2 });
  assert.equal(reader.get('x'), undefined, 'the oldest line goes first');
  assert.ok(reader.get('y') && reader.get('z'));
});

test('sessions: file errors go to onError, and the store keeps working in memory', () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-sessions-`);
  mkdirSync(`${dir}/sessions.jsonl`); // a directory where the file should be
  /** @type {unknown[]} */
  const errors = [];
  const store = new SessionStore({ file: `${dir}/sessions.jsonl`, onError: (err) => errors.push(err) });
  store.set('a', entry('fast'));
  assert.equal(errors.length, 2, 'the load and the append both failed');
  assert.equal(store.get('a')?.tier, 'fast');
  assert.doesNotThrow(() => new SessionStore({ file: `${dir}/sessions.jsonl` }).set('b', entry('fast')), 'without onError too');
});

test('the usage tap reads JSON bodies and skips junk; costOf falls back to undated prices', () => {
  const anthropicJson = new UsageTap('application/json');
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 10 },
  });
  for (const part of [body.slice(0, 20), body.slice(20)]) anthropicJson.push(Buffer.from(part));
  const usage = anthropicJson.result();
  assert.deepEqual(usage, { input: 100, cacheRead: 1000, cacheWrite: 100, output: 10 });
  assert.equal(anthropicJson.model, 'claude-haiku-4-5-20251001');
  assert.equal(costOf('claude-haiku-4-5-20251001', usage, cfg.prices), 0.000375, 'priced as claude-haiku-4-5');
  const responsesJson = new UsageTap('application/json; charset=utf-8');
  responsesJson.push(
    Buffer.from(
      JSON.stringify({
        model: 'gpt-6-sol',
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600 }, output_tokens: 20 },
      }),
    ),
  );
  assert.deepEqual(responsesJson.result(), { input: 400, cacheRead: 600, cacheWrite: 0, output: 20 });
  const cut = new UsageTap('application/json');
  cut.push(Buffer.from('{"usage":{"input_tok'));
  assert.equal(cut.result(), undefined, 'a cut-off body has no usage');
  const noUsage = new UsageTap();
  noUsage.push(Buffer.from('{"id":"x"}'));
  assert.equal(noUsage.result(), undefined);
  const junk = new UsageTap('text/event-stream');
  junk.push(Buffer.from('data: [DONE]\n\ndata: {oops\n\ndata:\n\nevent: ping\n\n'));
  junk.push(Buffer.from('data: {"type":"response.incomplete","response":{"model":"m","usage":{"input_tokens":5,"output_tokens":1}}}\n\n'));
  assert.deepEqual(junk.result(), { input: 5, cacheRead: 0, cacheWrite: 0, output: 1 });
  assert.equal(junk.model, 'm');
  const flat = { input: 1e6, cacheRead: 0, cacheWrite: 1e6, output: 0 };
  assert.equal(costOf('glm-5.3-flash', flat, cfg.prices), 0.3, 'a missing cacheWrite price is the input price');
  assert.equal(costOf('', usage, cfg.prices), undefined);
  assert.equal(costOf('glm-5.3-flash', undefined, cfg.prices), undefined);
});

test('report counts unpriced responses and uses the cost as baseline when there is none', () => {
  const r = report(
    [
      { event: 'done', session: 's', model: 'mystery-model', usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 1 } },
      { event: 'done', session: 's', model: 'glm-5.3-flash', cost_usd: 0.001 },
      { event: 'done', session: 's', status: 499, client_aborted: true },
      { event: 'warning', message: 'no Jev key' },
    ].map((e) => JSON.stringify(e)),
  );
  assert.equal(r.unpriced_responses, 1);
  assert.equal(r.baseline_usd, 0.001);
  assert.equal(r.saved_usd, 0);
  assert.deepEqual(r.models['mystery-model'], { requests: 1, cost_usd: 0, input: 5, cache_read: 0, output: 1 });
  assert.deepEqual(r.jev, { calls: 0, fallbacks: 0, fallback_rate: 0, p50_ms: null, p95_ms: null, cost_usd: 0 });
});

test('config validation reports malformed Jev channels instead of crashing', () => {
  for (const channels of ['typesafe', { name: 'typesafe' }, [null], [42]]) {
    const cfg = structuredClone(shipped);
    cfg.jev.channels = channels;
    assert.throws(() => validateConfig(cfg), /jev\.channels( must be an array|\[0\] must be an object)/, JSON.stringify(channels));
  }
});

test('the log file rotates to <file>.1 before a line would take it past logMaxBytes, and never loses a line', () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-log-`);
  const file = `${dir}/router.log`;
  const line = (/** @type {number} */ n) => `${JSON.stringify({ event: 'done', req: n, pad: 'x'.repeat(40) })}\n`;
  const size = line(1).length;
  const rotations = [1, 2, 3, 4, 5, 6, 7].map((n) => appendLogLine(file, line(n), 3 * size));
  assert.deepEqual(rotations, [false, false, false, true, false, false, true], 'three lines fit, the fourth starts a new file');
  assert.equal(readFileSync(`${file}.1`, 'utf8'), [4, 5, 6].map(line).join(''), 'one old file is kept, the one before it goes');
  assert.equal(readFileSync(file, 'utf8'), line(7));
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const off = `${dir}/off.log`;
  for (let n = 0; n < 5; n += 1) assert.equal(appendLogLine(off, line(n), 0), false, '0 never rotates');
  assert.equal(readFileSync(off, 'utf8').length, 5 * size);
  const big = `${dir}/big.log`;
  assert.equal(appendLogLine(big, line(1), 10), false, 'a line longer than the limit still goes into an empty file');
  assert.equal(appendLogLine(big, line(2), 10), true);
  assert.equal(readFileSync(big, 'utf8'), line(2));

  const stuck = `${dir}/stuck.log`;
  writeFileSync(stuck, line(1));
  mkdirSync(`${stuck}.1/busy`, { recursive: true }); // a directory that can't be replaced
  assert.equal(appendLogLine(stuck, line(2), size), false, 'a rotation that fails keeps the line in the old file');
  assert.equal(readFileSync(stuck, 'utf8'), line(1) + line(2));
  const target = `${dir}/target.log`;
  writeFileSync(target, line(1));
  symlinkSync(target, `${dir}/link.log`);
  assert.equal(appendLogLine(`${dir}/link.log`, line(2), size), false, 'a symbolic link is not rotated');
  assert.ok(!existsSync(`${dir}/link.log.1`));
  assert.throws(() => appendLogLine(`${dir}/no-such-dir/router.log`, line(1), size), /ENOENT/, 'a line that cannot be written throws');
});

test('config: logMaxBytes defaults to 50 MiB and takes 0 to never rotate; logFile must be a path', () => {
  assert.equal(cfg.logMaxBytes, 50 * 1024 * 1024);
  const { logMaxBytes, ...unset } = shipped;
  assert.equal(validateConfig({ ...unset, stateFile: null }).logMaxBytes, 52428800, 'the default without the key');
  assert.equal(validateConfig({ ...shipped, stateFile: null, logMaxBytes: 0 }).logMaxBytes, 0);
  assert.equal(validateConfig({ ...shipped, stateFile: null, logMaxBytes: null }).logMaxBytes, 52428800, 'null is the default');
  for (const bad of [-1, 1.5, '50MB'])
    assert.throws(
      () => validateConfig({ ...shipped, stateFile: null, logMaxBytes: bad }),
      /logMaxBytes must be a whole number of bytes/,
      String(bad),
    );
  for (const bad of [2, '', true])
    assert.throws(() => validateConfig({ ...shipped, stateFile: null, logFile: bad }), /logFile must be a file path or null/, String(bad));
  assert.equal(validateConfig({ ...shipped, stateFile: null, logFile: null }).logFile, null);
});

test('sessions: the state file is rewritten while the router runs, so it stays near one line per session', () => {
  const file = `${mkdtempSync(`${tmpdir()}/jev-sessions-`)}/sessions.jsonl`;
  const store = new SessionStore({ file });
  const lines = () => readFileSync(file, 'utf8').trim().split('\n').length;
  for (let i = 0; i < 1000; i += 1) store.set(i % 2 ? 'odd' : 'even', entry(i % 3 ? 'fast' : 'frontier'));
  assert.equal(lines(), 1000, 'every change is appended');
  store.set('even', entry('balanced'));
  assert.equal(lines(), 2, 'one change more, and the file holds one line per session');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!existsSync(`${file}.tmp`));
  const reloaded = new SessionStore({ file });
  assert.equal(reloaded.get('even')?.tier, 'balanced');
  assert.equal(reloaded.get('odd')?.tier, 'frontier');
});

test('the usage tap drops an SSE line that never ends instead of holding it', () => {
  const tap = new UsageTap('text/event-stream');
  tap.push(Buffer.from(`data: ${'x'.repeat(9 * 1024 * 1024)}`));
  assert.equal(tap.pending, '', 'more than 8 MiB without a newline is let go');
  tap.push(Buffer.from('xx\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n'));
  assert.deepEqual(tap.result(), { input: 0, cacheRead: 0, cacheWrite: 0, output: 5 }, 'and the lines after it are read');
});

test('Jev client: a long error body is cut to 200 characters, and an odd one does not throw', async () => {
  const { client } = scripted({
    'one.invalid': [() => reply(422, { detail: 'y'.repeat(10000) })],
    'two.invalid': [() => reply(500, { error: { message: 42 } }), () => reply(500, { error: { message: 42 } })],
  });
  const answer = await client.decide(stateOf('Add a test'));
  assert.ok(!answer.ok);
  assert.equal(client.health().one.lastError, `HTTP 422 ${'y'.repeat(200)}`);
  assert.equal(client.health().two.lastError, 'HTTP 500 42');
});

test('sessions: a rewrite that fails, as on a full or read-only disk, is reported and changes nothing', {
  skip: process.getuid?.() === 0 && 'root ignores file modes',
}, () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-sessions-`);
  const file = `${dir}/sessions.jsonl`;
  /** @type {unknown[]} */
  const errors = [];
  const store = new SessionStore({ file, onError: (err) => errors.push(err) });
  store.set('kept', entry('frontier'));
  chmodSync(dir, 0o500); // the file can still be appended to, but no new file can be made next to it
  try {
    for (let i = 0; i < 1000; i += 1) store.set('busy', entry('fast'));
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(errors.length, 1, 'the failed rewrite is reported once');
  assert.match(String(/** @type {Error} */ (errors[0]).message), /EACCES/);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1001, 'the file is left as it was, every line in it');
  assert.equal(store.get('kept')?.tier, 'frontier', 'and the store goes on');
  assert.equal(new SessionStore({ file }).get('busy')?.tier, 'fast');
});
