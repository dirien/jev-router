// The harness of the CLI tests: every command runs through the real bin/jev-router.mjs in a child
// process, with its own HOME, XDG directories and CODEX_HOME, and a PATH that holds only node (and
// the fakes a test copies in). Jev and the upstream providers are local mocks; nothing reaches the
// network, the real HOME or a real service manager.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.mjs';
import { createRouter } from '../src/router.mjs';
import { close, json, listen, mockServer, sleep } from './helpers.mjs';

export const BIN = fileURLToPath(new URL('../bin/jev-router.mjs', import.meta.url));
export const FAKE_AGENT = fileURLToPath(new URL('./fakes/fake-agent.mjs', import.meta.url));
export const DEFAULT_CONFIG = fileURLToPath(new URL('../config/default.json', import.meta.url));
export const ANTHROPIC_ONLY_CONFIG = fileURLToPath(new URL('../config/anthropic-only.json', import.meta.url));
export const CODEX_MODELS = fileURLToPath(new URL('../examples/codex/jev-models.json', import.meta.url));
export const shipped = JSON.parse(readFileSync(DEFAULT_CONFIG, 'utf8'));

// Fake credentials, assembled at runtime so secret scanners don't flag this file.
/** @param {string[]} parts */
export const fake = (...parts) => parts.join('');
export const JEV_KEY = fake('ts-', 'test-jev-', 'DO-NOT-PRINT');
export const OLLAMA_KEY = fake('ol-', 'test-ollama-', 'DO-NOT-PRINT');
export const MOCK_KEY = fake('mk-', 'test-mock-', 'DO-NOT-PRINT');
export const CLIENT_KEY = fake('client-', 'login-', 'placeholder');
export const TOKEN = fake('router-', "to'k$en");

/** @type {string[]} */
const roots = [];
/** Servers the tests started in this process; they're closed after the tests. @type {import('node:http').Server[]} */
export const servers = [];
after(async () => {
  await Promise.all(servers.map(close));
  for (const root of roots) {
    stopFakeService(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Stops a router that test/fakes/fake-service.mjs started for a sandbox, if one still runs.
 * @param {string} root
 */
function stopFakeService(root) {
  const pid = join(root, 'fake-service.pid');
  if (!existsSync(pid)) return;
  try {
    process.kill(Number(readFileSync(pid, 'utf8')), 'SIGKILL');
  } catch {
    // gone already
  }
}

/**
 * A throwaway home for one test: HOME, XDG directories and CODEX_HOME, and a bin directory that
 * holds only node (the fake agent's shebang needs it), so no real claude or codex is ever on PATH.
 */
export function sandbox() {
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
 * @typedef {object} StartOptions
 * @property {string | null} [input] what the command reads on stdin, which then ends; null keeps stdin open
 *   for the test to write to; without it, stdin is empty
 * @property {string[]} [node] flags for node itself, such as `--import` of a fake
 * @property {string} [bin] another copy of bin/jev-router.mjs to run
 */
/**
 * Starts bin/jev-router.mjs with exactly `env`: nothing leaks in from the test runner's environment.
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {StartOptions} [options]
 */
export function start(args, env, { input, node = [], bin = BIN } = {}) {
  // stdin is null when it's ignored; nothing here writes to it then.
  const child = /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (
    spawn(process.execPath, [...node, bin, ...args], { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  );
  if (typeof input === 'string') child.stdin.end(input);
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
 * @param {StartOptions} [options]
 */
export const run = (args, env, options) => start(args, env, options).done;

/**
 * Polls until `check` returns something truthy.
 * @template T
 * @param {() => T} check
 * @param {string} what
 * @returns {Promise<NonNullable<T>>}
 */
export async function waitFor(check, what) {
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
export function writeConfig(path, patch = {}, { upstream, jev } = {}) {
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
export async function mock(handler) {
  const server = await mockServer(handler);
  servers.push(server.server);
  return server;
}

/** A mock provider that answers every request with a small message. */
export function mockUpstream() {
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
export async function runningRouter(env = {}) {
  // The router's own log isn't under test here.
  const server = createRouter(validateConfig({ ...structuredClone(shipped), stateFile: null }), { env, log: () => true });
  servers.push(server);
  const url = await listen(server);
  return { url, port: Number(new URL(url).port) };
}

/** A port nothing listens on: the OS hands it out, and it's closed again at once. */
export async function freePort() {
  const server = http.createServer();
  const port = Number(new URL(await listen(server)).port);
  await close(server);
  return port;
}

/** @param {number} port */
export function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * The complete lines of a log as entries. Output that is still arriving can end in part of a line,
 * or be empty, and neither is an entry yet.
 * @param {string} text
 */
export const logEntries = (text) =>
  text
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line));
/** @param {string} text */
export const logEvents = (text) => logEntries(text).map((entry) => entry.event);

/** @param {string} url */
export const portOf = (url) => Number(new URL(url).port);

/**
 * Sends one small Claude Code shaped request through the router at `url`, with a client login.
 * @param {string} url
 */
export async function ask(url) {
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
export const healthz = async (url) => /** @type {{ ok: boolean, version: string }} */ (await (await fetch(`${url}/healthz`)).json());
