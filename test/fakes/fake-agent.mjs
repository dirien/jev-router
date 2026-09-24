#!/usr/bin/env node
// Stands in for `claude` and `codex` in test/cli.test.mjs, so the tests never start a real agent.
// It records how it was started, proves the router answers, can send one request through it the
// way the real agent would, and exits the way the test asks. Its settings come from the environment:
//   FAKE_AGENT_REPORT   JSON file to write { argv, env, health, request } to (required)
//   FAKE_AGENT_REQUEST  "1": send one Claude Code (or Codex) shaped request through the router
//   FAKE_AGENT_STDOUT   text to print on stdout
//   FAKE_AGENT_WAIT     "1": stay up until a signal arrives; SIGHUP exits with 42, SIGTERM kills it
//   FAKE_AGENT_EXIT     the exit code (default 0)
//   FAKE_CLIENT_KEY     the credential the agent sends, as a claude.ai login would be
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { env } = process;
const argv = process.argv.slice(2);
// `jev-router launch codex` starts `codex --profile jev …`; Codex then reads the router from the profile.
const codex = argv[0] === '--profile';
const SEEN = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_GATEWAY_HINT_HEADERS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'NODE_USE_ENV_PROXY',
];

/**
 * @typedef {{ base: string, headers: Record<string, string> }} Target where requests go, and the extra headers they carry
 */

/**
 * A TOML basic string's value. The tests only write strings that JSON can read; anything else is
 * taken as it stands, so a deliberately broken profile still lets the agent start.
 * @param {string} quoted
 */
function unquote(quoted) {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return quoted.slice(1, -1);
  }
}

/** @returns {Target} what Codex reads from $CODEX_HOME/jev.config.toml */
function codexTarget() {
  const text = readFileSync(join(env.CODEX_HOME || join(homedir(), '.codex'), 'jev.config.toml'), 'utf8');
  const base = /^base_url = (".*")$/m.exec(text)?.[1];
  const token = /^http_headers = \{ "x-jev-router-token" = (".*") \}$/m.exec(text)?.[1];
  if (!base) throw new Error('the Codex profile has no base_url');
  return { base: unquote(base), headers: token ? { 'x-jev-router-token': unquote(token) } : {} };
}

/** @returns {Target} what Claude Code reads from its environment */
function claudeTarget() {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { base: env.ANTHROPIC_BASE_URL ?? '', headers };
}

/**
 * Sends one request the way the agent would: Claude Code to /v1/messages with its own login, Codex to /v1/responses.
 * @param {Target} target
 */
async function send({ base, headers }) {
  const key = env.FAKE_CLIENT_KEY ?? '';
  const [path, auth, body] = codex
    ? [
        `${base}/responses`,
        { authorization: `Bearer ${key}` },
        {
          model: 'jev-auto',
          stream: false,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Rename foo to bar' }] }],
        },
      ]
    : [
        `${base}/v1/messages`,
        { 'x-api-key': key },
        { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'Add a unit test for the parser' }] },
      ];
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, tier: res.headers.get('x-jev-tier'), body: await res.text() };
}

const reportFile = env.FAKE_AGENT_REPORT;
if (!reportFile) throw new Error('FAKE_AGENT_REPORT is not set');
const wait = env.FAKE_AGENT_WAIT === '1';
// Ready for signals before the report says the agent is up.
if (wait) process.on('SIGHUP', () => process.exit(42));
const target = codex ? codexTarget() : claudeTarget();
const health = await (await fetch(new URL('/healthz', target.base))).json();
const request = env.FAKE_AGENT_REQUEST === '1' ? await send(target) : undefined;
const seen = Object.fromEntries(SEEN.filter((name) => name in env).map((name) => [name, env[name]]));
writeFileSync(reportFile, JSON.stringify({ argv, env: seen, health, request }));
if (env.FAKE_AGENT_STDOUT) process.stdout.write(env.FAKE_AGENT_STDOUT);
if (wait) {
  setInterval(() => {
    // stay up until the test sends a signal
  }, 60000);
} else {
  process.exitCode = Number(env.FAKE_AGENT_EXIT ?? 0);
}
