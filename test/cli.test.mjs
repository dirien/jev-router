// CLI tests. Every command runs through the real bin/jev-router.mjs in a child process, with its own
// HOME, XDG directories and CODEX_HOME, and a PATH that holds only node. test/fakes/fake-agent.mjs
// stands in for claude and codex; Jev and the upstream providers are local mocks. No network, no real agent.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.mjs';
import { createRouter, VERSION } from '../src/router.mjs';
import { close, jevOptionsAnswer, json, listen, mockServer, sleep } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/jev-router.mjs', import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL('./fakes/fake-agent.mjs', import.meta.url));
const DEFAULT_CONFIG = fileURLToPath(new URL('../config/default.json', import.meta.url));
const ANTHROPIC_ONLY_CONFIG = fileURLToPath(new URL('../config/anthropic-only.json', import.meta.url));
const CODEX_MODELS = fileURLToPath(new URL('../examples/codex/jev-models.json', import.meta.url));
const shipped = JSON.parse(readFileSync(DEFAULT_CONFIG, 'utf8'));

// Fake credentials, assembled at runtime so secret scanners don't flag this file.
/** @param {string[]} parts */
const fake = (...parts) => parts.join('');
const JEV_KEY = fake('ts-', 'test-jev-', 'DO-NOT-PRINT');
const OLLAMA_KEY = fake('ol-', 'test-ollama-', 'DO-NOT-PRINT');
const MOCK_KEY = fake('mk-', 'test-mock-', 'DO-NOT-PRINT');
const CLIENT_KEY = fake('client-', 'login-', 'placeholder');
const TOKEN = fake('router-', "to'k$en");

/** @type {string[]} */
const roots = [];
/** @type {import('node:http').Server[]} */
const servers = [];
after(async () => {
  await Promise.all(servers.map(close));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A throwaway home for one test: HOME, XDG directories and CODEX_HOME, and a bin directory that
 * holds only node (the fake agent's shebang needs it), so no real claude or codex is ever on PATH.
 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'jev-cli-'));
  roots.push(root);
  const dirs = {
    home: join(root, 'home'),
    config: join(root, 'config'),
    state: join(root, 'state'),
    codex: join(root, 'codex'),
    bin: join(root, 'bin'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  symlinkSync(process.execPath, join(dirs.bin, 'node'));
  const report = join(root, 'agent.json');
  /** @type {Record<string, string>} */
  const env = {
    PATH: dirs.bin,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_STATE_HOME: dirs.state,
    CODEX_HOME: dirs.codex,
    FAKE_AGENT_REPORT: report,
  };
  // --experimental-test-coverage collects child processes through NODE_V8_COVERAGE.
  if (process.env.NODE_V8_COVERAGE) env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
  return { root, ...dirs, env, report, agent: () => JSON.parse(readFileSync(report, 'utf8')) };
}

/**
 * @typedef {{ code: number | null, signal: string | null, stdout: string, stderr: string }} Result
 */
/**
 * Starts bin/jev-router.mjs with exactly `env`: nothing leaks in from the test runner's environment.
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function start(args, env) {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    out.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    out.stderr += chunk;
  });
  /** @type {Promise<Result>} */
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`jev-router ${args.join(' ')} timed out\n${out.stderr}`));
    }, 20000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ...out });
    });
  });
  return { child, out, done };
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
const run = (args, env) => start(args, env).done;

/**
 * Polls until `check` returns something truthy.
 * @template T
 * @param {() => T} check
 * @param {string} what
 * @returns {Promise<NonNullable<T>>}
 */
async function waitFor(check, what) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Writes a config file based on the packaged default.
 * @param {string} path
 * @param {Record<string, unknown>} [patch] top-level fields to replace
 * @param {{ upstream?: string, jev?: string }} [mocks] point every upstream target, or the Jev channels, at a local mock
 */
function writeConfig(path, patch = {}, { upstream, jev } = {}) {
  const cfg = { ...structuredClone(shipped), stateFile: null, ...patch };
  if (upstream) for (const targets of Object.values(cfg.surfaces)) for (const target of Object.values(targets)) target.url = upstream;
  if (jev) cfg.jev.channels = [{ name: 'mock', baseUrl: jev, model: 'jev-1.13.0', keyEnv: 'MOCK_JEV_KEY', timeoutMs: 1000 }];
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

/** @import { MockCall } from './helpers.mjs' */
/**
 * A local mock server that records every call; it's closed after the tests.
 * @param {(call: MockCall, res: import('node:http').ServerResponse) => unknown} handler
 */
async function mock(handler) {
  const server = await mockServer(handler);
  servers.push(server.server);
  return server;
}

/** A mock provider that answers every request with a small message. */
function mockUpstream() {
  return mock((call, res) =>
    json(res, 200, {
      id: 'msg_cli',
      type: 'message',
      role: 'assistant',
      model: call.body.model,
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 1 },
    }),
  );
}

/**
 * A real router in this process, as `jev-router serve` would run it, on an ephemeral port.
 * @param {Record<string, string>} [env]
 */
async function runningRouter(env = {}) {
  // The router's own log isn't under test here.
  const server = createRouter(validateConfig({ ...structuredClone(shipped), stateFile: null }), { env, log: () => true });
  servers.push(server);
  const url = await listen(server);
  return { url, port: Number(new URL(url).port) };
}

/** A port nothing listens on: the OS hands it out, and it's closed again at once. */
async function freePort() {
  const server = http.createServer();
  const port = Number(new URL(await listen(server)).port);
  await close(server);
  return port;
}

/** @param {number} port */
function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** @param {string} text */
const logEvents = (text) =>
  text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).event);

/** @param {string} url */
const portOf = (url) => Number(new URL(url).port);

/**
 * Sends one small Claude Code shaped request through the router at `url`, with a client login.
 * @param {string} url
 */
async function ask(url) {
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CLIENT_KEY },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'Add a test' }] }),
  });
  await res.text();
  return res;
}

/**
 * @param {string} url a router's base URL
 * @returns {Promise<{ ok: boolean, version: string }>}
 */
const healthz = async (url) => /** @type {{ ok: boolean, version: string }} */ (await (await fetch(`${url}/healthz`)).json());

test('version, help, and a short error for an unknown command, option or usage', async () => {
  const { env } = sandbox();
  for (const args of [['version'], ['--version']]) {
    assert.deepEqual(await run(args, env), { code: 0, signal: null, stdout: `${VERSION}\n`, stderr: '' });
  }
  for (const args of [['help'], ['--help'], ['-h']]) {
    const help = await run(args, env);
    assert.equal(help.code, 0);
    for (const usage of ['launch claude', 'launch codex', 'env claude|codex', 'doctor', 'init', 'report [<log.jsonl>]']) {
      assert.ok(help.stdout.includes(`jev-router ${usage}`), usage);
    }
  }
  const unknown = await run(['frobnicate'], env);
  assert.deepEqual(unknown, {
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'jev-router: unknown command "frobnicate". Run "jev-router help" for usage.\n',
  });
  const usage = {
    '--frobnicate': ['--frobnicate'],
    'Usage: jev-router launch claude|codex': ['launch', 'gemini'],
    'Usage: jev-router env claude|codex': ['env'],
    'Usage: jev-router doctor': ['doctor', 'now'],
    'Usage: jev-router init': ['init', 'here'],
    'Usage: jev-router report': ['report', 'a.jsonl', 'b.jsonl'],
    'serve takes no arguments, got "now"': ['serve', 'now'],
    '--force takes no value': ['init', '--force=yes'],
    '--config needs a value': ['doctor', '--config'],
    'port must be a number from 0 to 65535, got "70000"': ['serve', '--port=70000'],
    'env needs the port the router listens on, not 0': ['env', 'claude', '--port', '0'],
  };
  for (const [message, args] of Object.entries(usage)) {
    const result = await run(args, env);
    assert.equal(result.code, 1, args.join(' '));
    assert.ok(result.stderr.startsWith('jev-router: ') && result.stderr.includes(message), `${args.join(' ')}: ${result.stderr}`);
  }
});

test('config resolution: --config, then JEV_ROUTER_CONFIG, then the user config, then the packaged default', async () => {
  const box = sandbox();
  /**
   * @param {string[]} args
   * @param {Record<string, string>} [extra] added to the sandbox environment
   * @param {Record<string, string>} [base] the environment to start from
   */
  const baseUrl = async (args, extra = {}, base = box.env) => {
    const result = await run(['env', 'claude', ...args], { ...base, ...extra });
    assert.equal(result.code, 0, result.stderr);
    return /^export ANTHROPIC_BASE_URL=(.*)$/m.exec(result.stdout)?.[1];
  };
  assert.equal(await baseUrl([]), 'http://127.0.0.1:4000', 'the packaged default');
  mkdirSync(join(box.config, 'jev-router'));
  writeConfig(join(box.config, 'jev-router', 'config.json'), { port: 4103 });
  assert.equal(await baseUrl([]), 'http://127.0.0.1:4103', 'the user config');
  const fromEnv = writeConfig(join(box.root, 'env.json'), { port: 4102 });
  assert.equal(await baseUrl([], { JEV_ROUTER_CONFIG: fromEnv }), 'http://127.0.0.1:4102', 'JEV_ROUTER_CONFIG beats the user config');
  const fromFlag = writeConfig(join(box.root, 'flag.json'), { port: 4101 });
  assert.equal(await baseUrl(['--config', fromFlag], { JEV_ROUTER_CONFIG: fromEnv }), 'http://127.0.0.1:4101', '--config beats both');
  assert.equal(await baseUrl([`--config=${fromFlag}`]), 'http://127.0.0.1:4101', '--name=value works too');

  assert.equal(await baseUrl([], { JEV_ROUTER_PORT: '4104' }), 'http://127.0.0.1:4104', 'JEV_ROUTER_PORT beats the config');
  assert.equal(await baseUrl(['--port', '4105'], { JEV_ROUTER_PORT: '4104' }), 'http://127.0.0.1:4105', '--port beats JEV_ROUTER_PORT');
  assert.equal(await baseUrl([], { JEV_ROUTER_HOST: '::1' }), "'http://[::1]:4103'", 'IPv6 in brackets, quoted against globbing');
  assert.equal(
    await baseUrl([], { JEV_ROUTER_HOST: '0.0.0.0' }),
    'http://127.0.0.1:4103',
    'a router on every interface is reached on loopback',
  );

  const { XDG_CONFIG_HOME, ...noXdg } = box.env;
  mkdirSync(join(box.home, '.config', 'jev-router'), { recursive: true });
  writeConfig(join(box.home, '.config', 'jev-router', 'config.json'), { port: 4106 });
  assert.equal(await baseUrl([], {}, noXdg), 'http://127.0.0.1:4106', 'without XDG_CONFIG_HOME, ~/.config');

  const missing = await run(['env', 'claude'], { ...box.env, JEV_ROUTER_CONFIG: join(box.root, 'missing.json') });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^jev-router: Cannot read config .*missing\.json/);
});

test('env claude prints shell-safe exports, and env codex explains the profile', async () => {
  const box = sandbox();
  const plain = await run(['env', 'claude', '--port', '4555'], box.env);
  assert.equal(
    plain.stdout,
    'export ANTHROPIC_BASE_URL=http://127.0.0.1:4555\nexport CLAUDE_CODE_GATEWAY_HINT_HEADERS=1\nexport CLAUDE_CODE_AUTO_COMPACT_WINDOW=160000\n',
  );
  assert.equal(plain.stderr, 'jev-router: nothing answers at http://127.0.0.1:4555 yet. Start a router with: jev-router serve\n');

  const withToken = await run(['env', 'claude', '--port', '4555'], {
    ...box.env,
    JEV_ROUTER_TOKEN: `${TOKEN}$(touch pwned)`,
    ANTHROPIC_CUSTOM_HEADERS: 'x-team: blue\nX-Jev-Router-Token: stale',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000',
  });
  assert.ok(!withToken.stdout.includes('CLAUDE_CODE_AUTO_COMPACT_WINDOW'), "the user's own compaction window stays");
  // A real shell evaluates the exports: quotes, $ and newlines must survive, and nothing may run.
  const shell = spawnSync('/bin/sh', ['-c', `${withToken.stdout}printf '%s' "$ANTHROPIC_CUSTOM_HEADERS"`], {
    cwd: box.root,
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
  assert.equal(shell.stdout, `x-team: blue\nx-jev-router-token: ${TOKEN}$(touch pwned)`);
  assert.ok(!existsSync(join(box.root, 'pwned')));

  const { port } = await runningRouter();
  assert.equal((await run(['env', 'claude', '--port', String(port)], box.env)).stderr, '', 'no hint when a router answers');

  const codex = await run(['env', 'codex', '--port', '4555'], box.env);
  assert.equal(codex.code, 0);
  assert.ok(
    codex.stdout
      .trimEnd()
      .split('\n')
      .every((line) => line.startsWith('#')),
    'only comments, so eval runs nothing',
  );
  assert.ok(codex.stdout.includes(`# Profile: ${join(box.codex, 'jev.config.toml')} (not written yet`));
  assert.ok(codex.stdout.includes('# Router:  http://127.0.0.1:4555/v1'));
  assert.ok(codex.stdout.includes('codex --profile jev'));
});

test('init writes the user config once; --force overwrites it', async () => {
  const box = sandbox();
  const target = join(box.config, 'jev-router', 'config.json');
  const first = await run(['init'], box.env);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(first.stdout.includes(target));
  assert.equal(readFileSync(target, 'utf8'), readFileSync(DEFAULT_CONFIG, 'utf8'));
  assert.equal(statSync(target).mode & 0o777, 0o600);

  writeFileSync(target, '{"edited": true}');
  const again = await run(['init', '--anthropic-only'], box.env);
  assert.equal(again.code, 1);
  assert.equal(again.stderr, `jev-router: ${target} already exists. Pass --force to overwrite it.\n`);
  assert.equal(readFileSync(target, 'utf8'), '{"edited": true}');

  const forced = await run(['init', '--anthropic-only', '--force'], box.env);
  assert.equal(forced.code, 0);
  assert.equal(readFileSync(target, 'utf8'), readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8'));
  assert.match((await run(['doctor'], box.env)).stdout, /config {4}.*config\.json \(user config\)/, 'the next command uses it');

  const { XDG_CONFIG_HOME, ...noXdg } = box.env;
  assert.equal((await run(['init'], noXdg)).code, 0);
  assert.ok(existsSync(join(box.home, '.config', 'jev-router', 'config.json')), 'without XDG_CONFIG_HOME, ~/.config');
});

test('doctor reports config, keys, proxy and router, exits 1 only when routing cannot work, and never prints a secret', async () => {
  const box = sandbox();
  const env = { ...box.env, JEV_ROUTER_PORT: String(await freePort()) };
  const none = await run(['doctor'], env);
  assert.equal(none.code, 1);
  assert.match(none.stdout, /^jev-router \d+\.\d+\.\d+ doctor$/m);
  assert.match(none.stdout, /^ {2}ok {3}config {4}.*default\.json \(packaged default\)$/m);
  assert.match(none.stdout, /^ {2}ok {3}node {6}v\d+/m);
  assert.match(none.stdout, /^ {2}FAIL jev {7}no Jev channel has a key, so every session would get the default tier "balanced"/m);
  assert.match(none.stdout, /^ {2}info router {4}nothing answers at http:\/\/127\.0\.0\.1:\d+; start one with: jev-router serve$/m);
  assert.match(none.stdout, /Not ready: fix the FAIL lines above\.\n$/);

  const proxy = fake('http://user:', 'proxy-pass', '@proxy.example:3128');
  const keys = { TYPESAFE_API_KEY: JEV_KEY, OLLAMA_API_KEY: OLLAMA_KEY, HTTPS_PROXY: proxy };
  const ready = await run(['doctor'], { ...env, ...keys });
  assert.equal(ready.code, 0, ready.stdout);
  for (const line of [
    /ok {3}jev {7}typesafe: TYPESAFE_API_KEY is set$/m,
    /warn jev {7}openrouter: OPENROUTER_API_KEY is not set$/m,
    /ok {3}upstream {2}ANTHROPIC_API_KEY is not set: anthropic\.side, .*anthropic\.trusted pass the client's own login through$/m,
    /ok {3}upstream {2}OLLAMA_API_KEY is set: anthropic\.fast, openai\.fast, openai\.balanced$/m,
    /warn upstream {2}OPENAI_API_KEY is not set: openai\.frontier, openai\.trusted will fail$/m,
    /hint proxy {5}HTTPS_PROXY is set, but Node ignores it without NODE_USE_ENV_PROXY=1$/m,
    /Ready\. Start a session with: jev-router launch claude\n$/,
  ]) {
    assert.match(ready.stdout, line);
  }
  for (const secret of [JEV_KEY, OLLAMA_KEY, 'proxy-pass']) {
    assert.ok(!`${ready.stdout}${ready.stderr}`.includes(secret), 'a secret reached the output');
  }
  assert.match(
    (await run(['doctor'], { ...env, ...keys, NODE_USE_ENV_PROXY: '1' })).stdout,
    /ok {3}proxy {5}HTTPS_PROXY is set and NODE_USE_ENV_PROXY=1/,
  );

  const direct = await run(['doctor'], { ...env, JEV_BASE_URL: 'http://127.0.0.1:9', JEV_API_KEY: JEV_KEY });
  assert.equal(direct.code, 0, 'JEV_BASE_URL with JEV_API_KEY is a Jev channel too');
  assert.match(direct.stdout, /ok {3}jev {7}env: JEV_BASE_URL and JEV_API_KEY are set/);

  const bad = writeConfig(join(box.root, 'bad.json'), { port: 'eighty', defaultTier: 'cheapest' });
  const invalid = await run(['doctor', '--config', bad], { ...env, ...keys });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stdout, /FAIL config {4}.*bad\.json \(--config\)\n {17}Invalid router config:/);
  assert.match(invalid.stdout, /- port must be an integer between 1 and 65535/);
  assert.match(invalid.stdout, /- defaultTier "cheapest" is not one of tiers/);
  assert.doesNotMatch(invalid.stdout, /upstream/, 'no key checks against a config that failed to load');

  const badPort = await run(['doctor'], { ...box.env, ...keys, JEV_ROUTER_PORT: 'eighty' });
  assert.equal(badPort.code, 1);
  assert.match(badPort.stdout, /FAIL router {4}port must be a number from 0 to 65535, got "eighty"/);
});

test('doctor shows a running router with its version and Jev channels, and spots other servers on the port', async () => {
  const box = sandbox();
  const { port } = await runningRouter({ TYPESAFE_API_KEY: JEV_KEY });
  const running = await run(['doctor'], { ...box.env, TYPESAFE_API_KEY: JEV_KEY, JEV_ROUTER_PORT: String(port) });
  assert.equal(running.code, 0);
  assert.match(
    running.stdout,
    new RegExp(
      `ok {3}router {4}jev-router ${VERSION} answers at http://127\\.0\\.0\\.1:${port} \\(up \\d+ s, 0 sessions\\); Jev: typesafe ok \\(0 calls, 0 errors\\)`,
    ),
  );
  const { port: keyless } = await runningRouter();
  assert.match((await run(['doctor'], { ...box.env, JEV_ROUTER_PORT: String(keyless) })).stdout, /Jev: no channel has a key$/m);

  // Healthy JSON on /healthz isn't enough: it has to be a jev-router's.
  const other = http.createServer((_req, res) => json(res, 200, { ok: true }));
  servers.push(other);
  const otherPort = portOf(await listen(other));
  const found = await run(['doctor'], { ...box.env, JEV_ROUTER_PORT: String(otherPort) });
  assert.match(
    found.stdout,
    new RegExp(`warn router {4}something answers at http://127\\.0\\.0\\.1:${otherPort}, but it is not a jev-router`),
  );

  // A server that takes the request and never answers costs a second, not a hang.
  const silent = http.createServer(() => {
    // never answers
  });
  servers.push(silent);
  const silentPort = portOf(await listen(silent));
  const hung = await run(['doctor'], { ...box.env, JEV_ROUTER_PORT: String(silentPort) });
  assert.match(hung.stdout, new RegExp(`info router {4}nothing answers at http://127\\.0\\.0\\.1:${silentPort}`));
});

test('doctor --live makes one Jev call through a local System One mock', async () => {
  const box = sandbox();
  const jev = await mock((_call, res) => json(res, 200, jevOptionsAnswer({ option: 'routine', model: 'jev-1.13.0-mock' })));
  const down = await mock((_call, res) => json(res, 401, { detail: { message: 'invalid key' } }));
  const env = { ...box.env, MOCK_JEV_KEY: MOCK_KEY, JEV_ROUTER_PORT: String(await freePort()) };

  const live = await run(['doctor', '--live', '--config', writeConfig(join(box.root, 'live.json'), {}, { jev: jev.url })], env);
  assert.equal(live.code, 0, live.stdout);
  assert.match(live.stdout, /ok {3}live {6}mock answered in \d+ ms with jev-1\.13\.0-mock \(choice: routine\)$/m);
  assert.equal(jev.calls.length, 1, 'exactly one Jev call');
  assert.equal(jev.calls[0].url, '/v1/systemone');
  assert.equal(jev.calls[0].headers.authorization, `Bearer ${MOCK_KEY}`);
  assert.ok(!`${live.stdout}${live.stderr}`.includes(MOCK_KEY), 'the key never reaches the output');

  const failing = await run(['doctor', '--live', '--config', writeConfig(join(box.root, 'down.json'), {}, { jev: down.url })], env);
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /FAIL live {6}no answer after \d+ ms: mock: HTTP 401 invalid key$/m);

  const { MOCK_JEV_KEY, ...keyless } = env;
  const skipped = await run(['doctor', '--live', '--config', writeConfig(join(box.root, 'keyless.json'), {}, { jev: jev.url })], keyless);
  assert.match(skipped.stdout, /info live {6}skipped: no Jev channel has a key$/m);
  assert.equal(jev.calls.length, 1, 'no call without a key');
});

test('report reads a log file, the config logFile, or the log launch writes', async () => {
  const box = sandbox();
  const lines = [
    { event: 'route', session: 's1', jev: { ok: true, ms: 120, inputTokens: 600 } },
    { event: 'done', model: 'claude-sonnet-5', usage: { input: 10, cacheRead: 0, output: 5 }, cost_usd: 0.001, baseline_usd: 0.004 },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  const file = join(box.root, 'router.jsonl');
  writeFileSync(file, lines);

  const direct = await run(['report', file], box.env);
  assert.equal(direct.code, 0, direct.stderr);
  const summary = JSON.parse(direct.stdout);
  assert.equal(summary.requests, 1);
  assert.equal(summary.saved_usd, 0.003);
  assert.equal(summary.jev.calls, 1);

  const nothing = await run(['report'], box.env);
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /Usage: jev-router report <log\.jsonl> \(or set logFile in the config\)/);
  const configured = await run(['report', '--config', writeConfig(join(box.root, 'log.json'), { logFile: file })], box.env);
  assert.equal(JSON.parse(configured.stdout).requests, 1, 'the config logFile');
  mkdirSync(join(box.state, 'jev-router'));
  writeFileSync(join(box.state, 'jev-router', 'router.log'), `${lines}\n${lines}`);
  assert.equal(JSON.parse((await run(['report'], box.env)).stdout).requests, 2, 'the log launch writes');
  const missing = await run(['report', join(box.root, 'nope.jsonl')], box.env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /ENOENT/);
});

test('serve logs JSON to stdout and the logFile, reloads on SIGHUP, and drains on SIGTERM', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const logFile = join(box.root, 'serve.log');
  const config = writeConfig(join(box.root, 'serve.json'), { logFile }, { upstream: upstream.url });
  // `jev-router --config …` is `jev-router serve --config …`
  const serving = start(['--config', config, '--port', '0'], box.env);
  const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1], 'the router to listen');
  assert.equal((await healthz(url)).ok, true);

  assert.equal((await ask(url)).status, 200);
  await waitFor(() => serving.out.stdout.includes('"event":"done"'), 'the done line');
  assert.deepEqual(logEvents(serving.out.stdout), ['warning', 'route', 'done']);
  assert.equal(readFileSync(logFile, 'utf8'), serving.out.stdout, 'the logFile gets the same lines');
  assert.equal(upstream.calls[0].headers['x-api-key'], CLIENT_KEY, "no router key, so the client's login goes through");

  writeFileSync(config, '{ not json');
  serving.child.kill('SIGHUP');
  await waitFor(() => serving.out.stderr.includes('reload failed, keeping the old config'), 'the failed reload');
  writeConfig(config, { logFile: join(box.root, 'no-such-dir', 'serve.log') }, { upstream: upstream.url });
  serving.child.kill('SIGHUP');
  await waitFor(() => serving.out.stderr.includes('jev-router: config reloaded'), 'the reload');

  // Neither a logFile that can't be written nor a closed stdout pipe may stop the router.
  const logged = readFileSync(logFile, 'utf8');
  assert.equal((await ask(url)).status, 200);
  await waitFor(() => logEvents(serving.out.stdout).length === 5, 'the next two lines on stdout');
  assert.equal(readFileSync(logFile, 'utf8'), logged, 'the reloaded config moved the logFile');
  serving.child.stdout.destroy();
  for (let i = 0; i < 3; i += 1) assert.equal((await ask(url)).status, 200);

  serving.child.kill('SIGTERM');
  const { code } = await serving.done;
  assert.equal(code, 0);
  assert.match(serving.out.stderr, /shutting down, waiting for 0 request\(s\)/);
  assert.equal(await isListening(portOf(url)), false);
});

test('serve refuses to listen on a network address without a token, or on a taken port', async () => {
  const box = sandbox();
  const open = await run(['serve', '--host', '0.0.0.0', '--port', '0'], box.env);
  assert.equal(open.code, 1);
  assert.equal(open.stderr, 'jev-router: Refusing to listen on 0.0.0.0 without a token: set JEV_ROUTER_TOKEN.\n');
  const { port } = await runningRouter();
  const taken = await run(['serve', '--port', String(port)], box.env);
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, new RegExp(`^jev-router: cannot listen on 127\\.0\\.0\\.1:${port}: listen EADDRINUSE`));
});

test('launch claude starts a router for the session, hands the agent its args and env, and exits with its code', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const logFile = join(box.root, 'extra.log');
  const config = writeConfig(join(box.root, 'launch.json'), { logFile }, { upstream: upstream.url });
  const env = {
    ...box.env,
    JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT,
    FAKE_AGENT_REQUEST: '1',
    FAKE_AGENT_STDOUT: 'fake agent output\n',
    FAKE_AGENT_EXIT: '7',
    FAKE_CLIENT_KEY: CLIENT_KEY,
  };
  const result = await run(['launch', 'claude', '--config', config, '--port', '0', '--', '--config', 'x', 'fix the bug'], env);
  assert.equal(result.code, 7, result.stderr);
  assert.equal(result.stdout, 'fake agent output\n', "only the agent's own output reaches stdout");
  assert.match(
    result.stderr,
    /^jev-router: routing claude through http:\/\/127\.0\.0\.1:\d+ \(log: .*router\.log\)\n$/,
    'one line, before the agent starts',
  );

  const agent = box.agent();
  assert.deepEqual(agent.argv, ['--config', 'x', 'fix the bug'], 'everything after -- is the agent’s');
  const port = portOf(agent.env.ANTHROPIC_BASE_URL);
  assert.deepEqual(
    agent.env,
    { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '160000' },
    'no API key, auth token or custom headers are set for the agent',
  );
  assert.equal(agent.health.version, VERSION);

  assert.equal(agent.request.status, 200);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].body.model, 'claude-sonnet-5');
  assert.equal(upstream.calls[0].headers['x-api-key'], CLIENT_KEY, "the agent's own login goes through");
  const log = join(box.state, 'jev-router', 'router.log');
  assert.deepEqual(logEvents(readFileSync(log, 'utf8')), ['warning', 'route', 'done'], 'the router logs to its file');
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(readFileSync(logFile, 'utf8'), readFileSync(log, 'utf8'), 'and to the config logFile');
  assert.equal(await isListening(port), false, 'the router stops with the agent');

  const loose = await run(['launch', 'claude', '--config', config, '--port', '0', '--resume', 'abc'], {
    ...env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000',
  });
  assert.equal(loose.code, 7);
  assert.deepEqual(box.agent().argv, ['--resume', 'abc'], 'the first argument that is not ours starts the agent’s');
  assert.equal(box.agent().env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000', "the user's own compaction window stays");
});

test('launch claude adds the router token to the user’s custom headers, and the router accepts it', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'token.json'), { token: 'from-config' }, { upstream: upstream.url });
  const env = {
    ...box.env,
    JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT,
    FAKE_AGENT_REQUEST: '1',
    FAKE_CLIENT_KEY: CLIENT_KEY,
    ANTHROPIC_CUSTOM_HEADERS: 'x-team: blue\nx-jev-router-token: stale',
  };
  const fromEnv = await run(['launch', 'claude', '--config', config, '--port', '0'], { ...env, JEV_ROUTER_TOKEN: TOKEN });
  assert.equal(fromEnv.code, 0, fromEnv.stderr);
  assert.equal(box.agent().env.ANTHROPIC_CUSTOM_HEADERS, `x-team: blue\nx-jev-router-token: ${TOKEN}`, 'the stale token line is replaced');
  assert.equal(box.agent().request.status, 200, 'the router took the token');
  assert.equal(upstream.calls[0].headers['x-team'], 'blue');
  assert.equal(upstream.calls[0].headers['x-jev-router-token'], undefined, 'the token stays with the router');

  const fromConfig = await run(['launch', 'claude', '--config', config, '--port', '0'], env);
  assert.equal(fromConfig.code, 0, fromConfig.stderr);
  assert.equal(box.agent().env.ANTHROPIC_CUSTOM_HEADERS, 'x-team: blue\nx-jev-router-token: from-config');
  assert.equal(box.agent().request.status, 200);
});

test('launch reuses a router that already answers on the port, and leaves it running', async () => {
  const box = sandbox();
  const { url, port } = await runningRouter();
  const result = await run(['launch', 'claude', '--port', String(port)], { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, `jev-router: reusing the jev-router ${VERSION} at http://127.0.0.1:${port}\n`);
  assert.equal(box.agent().env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`);
  assert.equal((await healthz(url)).ok, true, 'the shared router keeps running');
  assert.ok(!existsSync(join(box.state, 'jev-router')), 'no router of its own, so no log of its own');
});

test("a second launch doesn't lean on another session's router, which stops with that session", async () => {
  const box = sandbox();
  const port = await freePort();
  const env = { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT };
  const first = start(['launch', 'claude', '--port', String(port)], { ...env, FAKE_AGENT_WAIT: '1' });
  await waitFor(() => existsSync(box.report), 'the first agent to start');
  assert.equal(portOf(box.agent().env.ANTHROPIC_BASE_URL), port);
  const marker = join(box.state, 'jev-router', `launch-${port}.pid`);
  assert.equal(readFileSync(marker, 'utf8'), String(first.child.pid));

  const report = join(box.root, 'second.json');
  const second = await run(['launch', 'claude', '--port', String(port)], { ...env, FAKE_AGENT_REPORT: report });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stderr, /^jev-router: routing claude through /);
  assert.notEqual(portOf(JSON.parse(readFileSync(report, 'utf8')).env.ANTHROPIC_BASE_URL), port, 'its own router, on a free port');

  first.child.kill('SIGHUP');
  assert.equal((await first.done).code, 42);
  assert.ok(!existsSync(marker), 'the marker goes with its router');

  // A marker left behind by a launch that died doesn't stop a router on that port from being shared.
  const { port: shared } = await runningRouter();
  writeFileSync(join(box.state, 'jev-router', `launch-${shared}.pid`), '2147483647');
  assert.match((await run(['launch', 'claude', '--port', String(shared)], env)).stderr, /^jev-router: reusing the jev-router/);
});

test('launch moves to a free port when something else holds the configured one', async () => {
  const box = sandbox();
  const other = http.createServer((_req, res) => res.end('<html>a dev server</html>'));
  servers.push(other);
  const taken = portOf(await listen(other));
  const result = await run(['launch', 'claude', '--port', String(taken)], { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT });
  assert.equal(result.code, 0, result.stderr);
  const agent = box.agent();
  assert.notEqual(portOf(agent.env.ANTHROPIC_BASE_URL), taken);
  assert.equal(agent.health.version, VERSION, 'the agent reaches the router on its new port');
});

test('launch finds the agent on PATH, and exits 127 when it is missing or cannot start', async () => {
  const box = sandbox();
  const missing = await run(['launch', 'claude', '--port', '0'], box.env);
  assert.deepEqual(missing, {
    code: 127,
    signal: null,
    stdout: '',
    stderr: 'jev-router: cannot find claude. Install it, or set JEV_ROUTER_CLAUDE_BIN to its path.\n',
  });
  const override = await run(['launch', 'codex', '--port', '0'], { ...box.env, JEV_ROUTER_CODEX_BIN: join(box.root, 'no-codex') });
  assert.equal(override.code, 127);
  assert.match(override.stderr, /cannot find .*no-codex\. Install it, or set JEV_ROUTER_CODEX_BIN to its path\.\n$/);

  const broken = join(box.root, 'broken-agent');
  writeFileSync(broken, '#!/nonexistent/interpreter\n');
  chmodSync(broken, 0o755);
  const cannot = await run(['launch', 'claude', '--port', '0'], { ...box.env, JEV_ROUTER_CLAUDE_BIN: broken });
  assert.equal(cannot.code, 127);
  assert.match(cannot.stderr, /jev-router: cannot run .*broken-agent: spawn .*ENOENT\n$/);

  copyFileSync(FAKE_AGENT, join(box.bin, 'claude'));
  chmodSync(join(box.bin, 'claude'), 0o755);
  const found = await run(['launch', 'claude', '--port', '0', 'hello'], box.env);
  assert.equal(found.code, 0, found.stderr);
  assert.deepEqual(box.agent().argv, ['hello']);

  const bad = writeConfig(join(box.root, 'bad.json'), { defaultTier: 'cheapest' });
  rmSync(box.report);
  const invalid = await run(['launch', 'claude', '--config', bad], box.env);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /^jev-router: Invalid router config:\n {2}- defaultTier "cheapest" is not one of tiers/);
  assert.ok(!existsSync(box.report), 'the agent never started');
});

test('while the agent runs, Ctrl-C is left to it, and SIGHUP and SIGTERM are forwarded', async () => {
  const box = sandbox();
  const env = { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT, FAKE_AGENT_WAIT: '1' };
  const hup = start(['launch', 'claude', '--port', '0'], env);
  await waitFor(() => existsSync(box.report), 'the agent to start');
  hup.child.kill('SIGINT');
  await sleep(300);
  assert.equal(hup.child.exitCode, null, 'SIGINT did not stop the launcher');
  hup.child.kill('SIGHUP');
  assert.equal((await hup.done).code, 42, 'the agent got SIGHUP, and its exit code came back');
  assert.equal(await isListening(portOf(box.agent().env.ANTHROPIC_BASE_URL)), false);

  rmSync(box.report);
  const term = start(['launch', 'claude', '--port', '0'], env);
  await waitFor(() => existsSync(box.report), 'the agent to start');
  term.child.kill('SIGTERM');
  assert.equal((await term.done).code, 128 + 15, 'the agent died of SIGTERM, which is exit code 128 + 15');
});

test('launch codex writes the profile, starts codex --profile jev, and routes through it', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'codex.json'), {}, { upstream: upstream.url });
  /** @type {Record<string, string>} */
  const env = { ...box.env, JEV_ROUTER_CODEX_BIN: FAKE_AGENT, FAKE_AGENT_REQUEST: '1', FAKE_AGENT_EXIT: '3', JEV_ROUTER_TOKEN: TOKEN };
  const result = await run(['launch', 'codex', '--config', config, '--port', '0', 'exec', 'fix the tests'], env);
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stdout, '');
  const agent = box.agent();
  assert.deepEqual(agent.argv, ['--profile', 'jev', 'exec', 'fix the tests']);
  assert.equal(agent.env.ANTHROPIC_BASE_URL, undefined, 'Codex gets the router from its profile');

  const path = join(box.codex, 'jev.config.toml');
  const profile = readFileSync(path, 'utf8');
  const baseUrl = JSON.parse(/^base_url = (".*")$/m.exec(profile)?.[1] ?? '""');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(JSON.parse(/^model_catalog_json = (".*")$/m.exec(profile)?.[1] ?? '""'), CODEX_MODELS);
  assert.ok(existsSync(CODEX_MODELS));
  assert.ok(profile.includes(`http_headers = { "x-jev-router-token" = ${JSON.stringify(TOKEN)} }`));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(agent.health.version, VERSION);
  assert.equal(agent.request.status, 200, 'the router took the token from the profile');
  assert.equal(upstream.calls[0].url, '/v1/responses');
  assert.equal(upstream.calls[0].body.model, 'kimi-k2.7-code');
  assert.equal(await isListening(portOf(baseUrl)), false);

  const { CODEX_HOME, ...noCodexHome } = env;
  assert.equal((await run(['launch', 'codex', '--config', config, '--port', '0'], noCodexHome)).code, 3);
  assert.ok(existsSync(join(box.home, '.codex', 'jev.config.toml')), 'without CODEX_HOME, ~/.codex');
});

test('launch codex keeps an edited profile with one note, follows the router in its own, and --force rewrites', async () => {
  const box = sandbox();
  const { port } = await runningRouter();
  const env = { ...box.env, JEV_ROUTER_CODEX_BIN: FAKE_AGENT };
  const path = join(box.codex, 'jev.config.toml');
  const launchCodex = (/** @type {string[]} */ ...args) => run(['launch', 'codex', '--port', String(port), ...args], env);

  assert.equal((await launchCodex()).code, 0);
  const generated = readFileSync(path, 'utf8');
  assert.equal((await launchCodex()).stderr.split('\n').filter(Boolean).length, 1, 'the same profile again: no note');

  const edited = generated.replace('web_search = "disabled"', 'web_search = "live"');
  writeFileSync(path, edited);
  const kept = await launchCodex();
  assert.equal(kept.code, 0, kept.stderr);
  assert.equal(readFileSync(path, 'utf8'), edited);
  const notes = kept.stderr.split('\n').filter((line) => line.includes('kept'));
  assert.deepEqual(notes, [
    `jev-router: kept ${path} because it was edited. Pass --force to replace it with the profile for http://127.0.0.1:${port}/v1.`,
  ]);

  const unreadable = generated.replace(/^(base_url = .*)$/m, '$1\nhttp_headers = { "x-jev-router-token" = "\\q" }');
  writeFileSync(path, unreadable);
  assert.match((await launchCodex()).stderr, /kept .* because it was edited/, 'a string it cannot read back is an edit too');
  assert.equal(readFileSync(path, 'utf8'), unreadable);

  assert.equal((await launchCodex('--force')).code, 0);
  assert.equal(readFileSync(path, 'utf8'), generated);

  // Its own, unedited profile follows the router to another port or token without a note.
  const moved = await run(['launch', 'codex', '--port', '0'], { ...env, JEV_ROUTER_TOKEN: TOKEN });
  assert.equal(moved.code, 0, moved.stderr);
  assert.doesNotMatch(moved.stderr, /kept/);
  assert.notEqual(readFileSync(path, 'utf8'), generated);
  assert.equal(box.agent().health.version, VERSION, 'Codex reaches the new router');
});
