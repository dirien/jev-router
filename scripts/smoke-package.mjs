#!/usr/bin/env node
// Package smoke test: installs jev-router the way people do on their own machine, with no Docker
// Sandbox, and runs the installed command. It packs the package (or takes --tarball), installs it
// with `npm install -g --prefix` into a temporary directory, and with --git also installs a git clone
// of HEAD, the way npm installs `github:dirien/jev-router#semver:^1`. Each install then runs under a
// temporary HOME, with no proxy variables and no keys in its environment: `version`, `init
// --anthropic-only`, and `serve --port 0 --ui 127.0.0.1:0` with a mode 0600 env file (skipped with a
// note when the version has no --env-file). While the router runs, it checks /healthz, the live
// view's page and event stream, `env claude`, and `launch claude` with a stand-in agent; then that
// SIGTERM stops the router cleanly. Nothing touches the network. Exits 1 on the first failed check.
//
//   node scripts/smoke-package.mjs [--git] [--tarball <file.tgz>] [--keep]
//
//   --git      also install from git: the last commit, so uncommitted changes aren't part of it
//   --tarball  install this tarball instead of packing the working tree (the release workflow's)
//   --keep     keep the temporary directory and print where it is
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** @typedef {{ status: number | null, stdout: string, stderr: string }} Result */
/** @typedef {{ code: number | null, signal: NodeJS.Signals | null }} Exit */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const WAIT_MS = 20000;
/** Environment variables that route traffic through a proxy; the no-sandbox path needs none of them. */
const PROXY_VARS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  'NPM_CONFIG_PROXY',
  'NPM_CONFIG_HTTPS_PROXY',
]);
/** Files the installed command reads at run time, and the files the docs send people to. */
const REQUIRED = [
  'bin/jev-router.mjs',
  'config/default.json',
  'config/anthropic-only.json',
  'examples/claude-code.env',
  'examples/codex/jev.config.toml',
  'examples/codex/jev-models.json',
  'examples/service/launchd/io.github.dirien.jev-router.plist',
  'examples/service/systemd/jev-router.service',
  'sbx/jev-router-kit/spec.yaml',
  'ui/index.html',
  'ui/app.js',
  'ui/app.css',
  'ui/favicon.svg',
  'LICENSE',
  'NOTICE',
  'README.md',
];
/** What must stay out of the package. */
const EXCLUDED = ['test', 'eval', 'docs', 'scripts', '.github', 'coverage', 'node_modules'];
/** Written to the env file; not a key, only proof that the file was read. */
const ENV_FILE_VALUE = 'smoke-test-placeholder';

/**
 * @param {string} topic
 * @param {string} text
 */
const ok = (topic, text) => console.log(`  ok    ${topic.padEnd(9)}${text}`);
/**
 * @param {string} topic
 * @param {string} text
 */
const note = (topic, text) => console.log(`  note  ${topic.padEnd(9)}${text}`);

/**
 * Runs a command to completion.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [options]
 * @returns {Result}
 */
function run(command, args, { env = process.env, cwd = ROOT } = {}) {
  const result = spawnSync(command, args, { env, cwd, encoding: 'utf8', timeout: 180000 });
  if (result.error) throw new Error(`${command} ${args.join(' ')}: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Like run(), and fails unless the command exits 0.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [options]
 * @returns {Result}
 */
function runOk(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`${[command, ...args].join(' ')} exited with ${result.status}\n${result.stderr.trim()}`);
  return result;
}

/**
 * This environment without proxy settings, for npm. The installs read only local files.
 * @returns {NodeJS.ProcessEnv}
 */
const npmEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !PROXY_VARS.has(key.toUpperCase())));

/**
 * npm flags that keep a run to itself: a private cache, and no audit, funding or update checks.
 * @param {string} work
 */
const npmFlags = (work) => ['--cache', join(work, 'npm-cache'), '--no-audit', '--no-fund', '--no-update-notifier'];

/** @param {number} bytes */
const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;

/**
 * Every file under `dir`, relative to it.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

/**
 * `npm pack` of the working tree.
 * @param {string} work
 * @returns {string} the tarball
 */
function pack(work) {
  const out = join(work, 'pack');
  mkdirSync(out);
  const { stdout } = runOk('npm', ['pack', '--json', '--pack-destination', out, ...npmFlags(work)], { env: npmEnv() });
  const [info] = JSON.parse(stdout);
  ok('pack', `${info.filename}: ${info.entryCount} files, ${kb(info.size)}`);
  return join(out, info.filename);
}

/**
 * The spec npm gets for a GitHub install, pointed at this repository's last commit.
 * @returns {string}
 */
function gitSpec() {
  const sha = runOk('git', ['rev-parse', 'HEAD']).stdout.trim();
  if (runOk('git', ['status', '--porcelain']).stdout.trim())
    note('git', `installs commit ${sha.slice(0, 12)}; your uncommitted changes aren't part of it`);
  return `git+${pathToFileURL(ROOT).href}#${sha}`;
}

/**
 * Checks what an install put on disk.
 * @param {string} topic
 * @param {string} prefix the npm prefix it went to
 * @returns {string} the installed `jev-router` command
 */
function checkFiles(topic, prefix) {
  const dir = join(prefix, 'lib', 'node_modules', ...PKG.name.split('/'));
  const bin = join(prefix, 'bin', 'jev-router');
  if (!existsSync(bin) || (statSync(bin).mode & 0o111) === 0) throw new Error(`${bin} is missing or not executable`);
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  if (version !== PKG.version) throw new Error(`installed version ${version}, expected ${PKG.version}`);
  const sources = readdirSync(join(ROOT, 'src')).filter((name) => name.endsWith('.mjs'));
  const missing = [...REQUIRED, ...sources.map((name) => `src/${name}`)].filter((file) => !existsSync(join(dir, file)));
  if (missing.length) throw new Error(`missing from the package: ${missing.join(', ')}`);
  const extra = EXCLUDED.filter((name) => existsSync(join(dir, name)));
  if (extra.length) throw new Error(`in the package but shouldn't be: ${extra.join(', ')}`);
  ok(topic, `${listFiles(dir).length} files installed, the bin linked; none of ${EXCLUDED.join(', ')}`);
  return bin;
}

/**
 * The environment a person's shell would give the command after `npm install -g`: the prefix's bin
 * and node on PATH, and a fresh HOME. No proxy variables, no keys, nothing from this process.
 * @param {string} prefix
 * @param {string} home
 * @returns {NodeJS.ProcessEnv}
 */
function userEnv(prefix, home) {
  return {
    PATH: [join(prefix, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
  };
}

/**
 * GET over plain HTTP. `agent: false` keeps any proxy agent out of a loopback request.
 * @param {string} url
 * @returns {Promise<{ status: number, type: string, body: string }>}
 */
function get(url) {
  return new Promise((done, fail) => {
    const req = http.get(url, { agent: false, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => done({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', fail);
  });
}

/**
 * Opens the live view's event stream and returns the first `snapshot` event it sends.
 * @param {string} url
 * @returns {Promise<{ type: string, data: { events: Array<{ event: string }> } }>}
 */
function snapshot(url) {
  return new Promise((done, fail) => {
    const req = http.get(url, { agent: false }, (res) => {
      const type = String(res.headers['content-type'] ?? '');
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`GET ${url} answered ${res.statusCode}`));
        return;
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        const match = /^event: snapshot\ndata: (.*)\n\n/m.exec(text);
        if (!match) return;
        req.destroy();
        done({ type, data: JSON.parse(match[1]) });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`no snapshot from ${url} within 5 s`)), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', fail);
  });
}

/**
 * Resolves with `value()` once it returns something; fails when `exited` settles first or time runs out.
 * @template T
 * @param {() => T | undefined} value
 * @param {Promise<Exit>} exited
 * @param {() => string} explain what to say when it fails
 * @returns {Promise<T>}
 */
async function waitFor(value, exited, explain) {
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = value();
    if (found !== undefined) return found;
    if (gone || Date.now() > deadline) throw new Error(explain());
    await new Promise((later) => setTimeout(later, 50));
  }
}

/**
 * Starts `jev-router serve` on free ports and waits until the router and its live view listen.
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} extra more arguments
 */
async function startServe(bin, env, extra) {
  const child = spawn(bin, ['serve', '--port', '0', '--ui', '127.0.0.1:0', ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    output.stderr += chunk;
  });
  /** @type {Promise<Exit>} */
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
  const urls = await waitFor(
    () => {
      const router = /listening on (http:\/\/\S+)/.exec(output.stderr)?.[1];
      const view = /live view on (http:\/\/\S+)/.exec(output.stderr)?.[1];
      return router && view ? { router, view } : undefined;
    },
    exited,
    () => `serve didn't report the router's and the live view's addresses:\n${output.stderr.trim()}`,
  );
  return { child, exited, output, ...urls };
}

/**
 * Checks the running router and its live view.
 * @param {string} topic
 * @param {{ router: string, view: string }} urls
 * @param {boolean} withKey whether the env file handed the router a Jev key
 */
async function checkServer(topic, { router, view }, withKey) {
  const health = await get(`${router}/healthz`);
  const body = health.status === 200 ? JSON.parse(health.body) : undefined;
  if (body?.ok !== true || body.version !== PKG.version) throw new Error(`/healthz answered ${health.status}: ${health.body}`);
  if (body.jev.configured !== withKey || (withKey && !('typesafe' in body.jev.channels)))
    throw new Error(`/healthz: expected Jev ${withKey ? 'configured from the env file' : 'unconfigured'}, got ${JSON.stringify(body.jev)}`);
  ok(topic, `/healthz: ${body.version}, Jev ${withKey ? 'configured from the env file' : 'not configured (no keys given)'}`);
  const page = await get(view);
  if (page.status !== 200 || !page.type.startsWith('text/html') || !page.body.includes('app.js'))
    throw new Error(`the live view's page answered ${page.status} (${page.type})`);
  for (const asset of ['app.js', 'app.css', 'favicon.svg']) {
    const res = await get(`${view}${asset}`);
    if (res.status !== 200) throw new Error(`the live view's ${asset} answered ${res.status}`);
  }
  ok(topic, 'live view: page, app.js, app.css and favicon.svg');
  const stream = await snapshot(`${view}events`);
  if (!stream.type.startsWith('text/event-stream') || !stream.data.events.some((entry) => entry.event === 'config'))
    throw new Error(`/events: expected a snapshot with the config entry, got ${JSON.stringify(stream.data).slice(0, 300)}`);
  ok(topic, '/events: a snapshot that holds the config entry');
}

/**
 * `env claude` and `launch claude` against the running router; a stand-in `claude` prints what it got.
 * @param {string} topic
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} env
 * @param {string} router
 */
function checkClients(topic, bin, env, router) {
  const port = new URL(router).port;
  const exports = runOk(bin, ['env', 'claude', '--port', port], { env });
  if (!exports.stdout.includes(`export ANTHROPIC_BASE_URL=${router}\n`) || !exports.stdout.includes('export ENABLE_TOOL_SEARCH=true'))
    throw new Error(`env claude printed:\n${exports.stdout}`);
  if (exports.stderr.includes('nothing answers')) throw new Error(`env claude didn't find the router: ${exports.stderr.trim()}`);
  ok(topic, 'env claude: exports for the running router');
  const agent = join(String(env.HOME), 'claude');
  writeFileSync(agent, '#!/bin/sh\nprintf "base=%s tool_search=%s args=%s\\n" "$ANTHROPIC_BASE_URL" "$ENABLE_TOOL_SEARCH" "$*"\n', {
    mode: 0o755,
  });
  const launched = runOk(bin, ['launch', 'claude', '--port', port, '--', '--print', 'hello'], {
    env: { ...env, JEV_ROUTER_CLAUDE_BIN: agent },
  });
  if (launched.stdout.trim() !== `base=${router} tool_search=true args=--print hello`)
    throw new Error(`launch claude ran the agent with:\n${launched.stdout}`);
  ok(topic, 'launch claude: reused the router and handed the agent its settings');
}

/**
 * Installs one package source and runs the installed command through the no-sandbox flow.
 * @param {string} topic
 * @param {string} spec what npm installs
 * @param {string} work
 */
async function checkInstall(topic, spec, work) {
  const prefix = join(work, `prefix-${topic}`);
  runOk('npm', ['install', '--global', '--prefix', prefix, ...npmFlags(work), spec], { env: npmEnv(), cwd: work });
  ok(topic, `npm install -g ${spec.startsWith('git+') ? 'git+file://…#<HEAD>' : 'of the tarball'} into a temporary prefix`);
  const bin = checkFiles(topic, prefix);
  const home = join(work, `home-${topic}`);
  mkdirSync(home);
  const env = userEnv(prefix, home);
  const version = runOk(bin, ['version'], { env }).stdout.trim();
  if (version !== PKG.version) throw new Error(`jev-router version printed ${version}, expected ${PKG.version}`);
  ok(topic, `jev-router version: ${version}`);
  runOk(bin, ['init', '--anthropic-only'], { env });
  const config = join(home, '.config', 'jev-router', 'config.json');
  const packaged = join(prefix, 'lib', 'node_modules', ...PKG.name.split('/'), 'config', 'anthropic-only.json');
  if (!readFileSync(config).equals(readFileSync(packaged))) throw new Error(`${config} isn't the packaged anthropic-only.json`);
  if ((statSync(config).mode & 0o777) !== 0o600) throw new Error(`${config} has mode ${(statSync(config).mode & 0o777).toString(8)}`);
  ok(topic, 'init --anthropic-only: wrote ~/.config/jev-router/config.json, mode 600');
  const envFile = runOk(bin, ['help'], { env }).stdout.includes('--env-file') ? join(home, '.config', 'jev-router', 'env') : undefined;
  if (envFile) {
    writeFileSync(envFile, `TYPESAFE_API_KEY=${ENV_FILE_VALUE}\n`, { mode: 0o600 });
    chmodSync(envFile, 0o600);
  } else note(topic, "--env-file: skipped, this version doesn't have it");
  const server = await startServe(bin, env, envFile ? ['--env-file', envFile] : []);
  try {
    ok(topic, `serve${envFile ? ' --env-file' : ''}: router on ${server.router}, live view on ${server.view}`);
    await checkServer(topic, server, envFile !== undefined);
    checkClients(topic, bin, env, server.router);
    const first = server.output.stdout.split('\n', 1)[0];
    if (JSON.parse(first || '{}').event !== 'config') throw new Error(`the first log line on stdout isn't the config entry: ${first}`);
    server.child.kill('SIGTERM');
    const timeout = new Promise((later) => setTimeout(later, 10000, { code: null, signal: null }));
    const exit = /** @type {Exit} */ (await Promise.race([server.exited, timeout]));
    if (exit.code !== 0)
      throw new Error(
        `serve ended with ${exit.code ?? exit.signal ?? 'no exit within 10 s'} after SIGTERM\n${server.output.stderr.trim()}`,
      );
    ok(topic, 'SIGTERM: the router drained and exited with 0');
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { git: { type: 'boolean' }, tarball: { type: 'string' }, keep: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log('Usage: node scripts/smoke-package.mjs [--git] [--tarball <file.tgz>] [--keep]');
    return 0;
  }
  if (process.platform === 'win32') throw new Error('the package smoke test runs on macOS and Linux');
  const work = mkdtempSync(join(tmpdir(), 'jev-router-smoke-'));
  try {
    const npm = runOk('npm', ['--version'], { env: npmEnv() }).stdout.trim();
    console.log(`jev-router package smoke test: ${PKG.name} ${PKG.version}, Node.js ${process.version}, npm ${npm}`);
    const tarball = values.tarball ? resolve(values.tarball) : pack(work);
    await checkInstall('tarball', tarball, work);
    if (values.git) await checkInstall('git', gitSpec(), work);
    console.log('All checks passed.');
    return 0;
  } finally {
    if (values.keep) console.log(`Kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
