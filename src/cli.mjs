// The jev-router command. `serve` runs the router in the foreground; `launch` runs Claude Code or
// Codex through a router for one session; `env`, `doctor`, `init`, `report` and `ui` set it up and
// read its log. What scripts consume (exports, reports, the router log under `serve`) goes to stdout,
// messages for people go to stderr.
import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, constants as osConstants } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { JevClient } from './jev.mjs';
import { appendLogLine } from './logfile.mjs';
import { createRouter, describeConfig, report, VERSION } from './router.mjs';
import { createUiServer } from './ui.mjs';

/** @import { Config, Health, RouterServer, UiServer } from './types.js' */

/**
 * @typedef {'ok' | 'warn' | 'FAIL' | 'hint' | 'info'} Status
 * @typedef {{ add: (status: Status, topic: string, text: string) => void, lines: string[], readonly failed: boolean }} Checklist
 */

/** @param {string} path a path inside the package */
const packaged = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const DEFAULT_CONFIG = packaged('config/default.json');
const ANTHROPIC_ONLY_CONFIG = packaged('config/anthropic-only.json');
const CODEX_TEMPLATE = packaged('examples/codex/jev.config.toml');
const CODEX_MODELS = packaged('examples/codex/jev-models.json');
const LOOPBACK = '127.0.0.1';
const UI_PORT = 4100;
const TOKEN_HEADER = 'x-jev-router-token';
// Claude Code can't learn a routed model's context window through a gateway, so it compacts well
// before the smallest window among the tiers.
const COMPACT_WINDOW = '160000';

const HELP = `jev-router ${VERSION}: picks a model tier for every Claude Code or Codex turn with Jev.

Usage:
  jev-router [serve] [--config <file>] [--env-file <file>] [--log-file <file>] [--host <h>] [--port <n>]
                     [--ui [<host>:]<port>]
  jev-router launch claude [--config <file>] [--env-file <file>] [--port <n>] [--] [claude args…]
  jev-router launch codex  [--config <file>] [--env-file <file>] [--port <n>] [--force] [--] [codex args…]
  jev-router env claude|codex [--config <file>] [--env-file <file>] [--port <n>]
  jev-router doctor [--config <file>] [--live]
  jev-router init [--anthropic-only] [--force]
  jev-router report [<log.jsonl>]
  jev-router ui [<log.jsonl>] [--port <n>]
  jev-router version | help

  serve    run the router in the foreground (the default command); --ui also serves the live view
  launch   run Claude Code or Codex through the router on the configured port, starting one if none runs
  env      print shell exports for a running router: eval "$(jev-router env claude)"
  doctor   check the config, the keys and a running router; --live makes one Jev call (~$0.00003)
  init     write the user config; --anthropic-only sends every Claude Code tier to Anthropic
  report   sum up requests, spend and savings from a router log
  ui       serve the live view for a router log another process writes (http://127.0.0.1:4100)

Config: --config, else $JEV_ROUTER_CONFIG, else $XDG_CONFIG_HOME/jev-router/config.json
(~/.config by default) if it exists, else the packaged default. JEV_ROUTER_HOST and
JEV_ROUTER_PORT override the config's host and port; the flags override both.
JEV_ROUTER_UI works like --ui.

Keys: --env-file, else $JEV_ROUTER_ENV_FILE, names a file of KEY=VALUE lines (such as
~/.config/jev-router/env, mode 600) that is loaded before anything reads the environment.
Variables already set win. launch keeps the file's variables away from the agent. Proxy
settings (HTTPS_PROXY, NODE_USE_ENV_PROXY) don't work from it: Node reads them at startup.

Log: serve writes JSON lines to stdout and to --log-file, else $JEV_ROUTER_LOG_FILE, else the
config's logFile (its directory is created for --log-file and $JEV_ROUTER_LOG_FILE). The file
rotates to <file>.1 at the config's logMaxBytes (50 MiB). report and ui read $JEV_ROUTER_LOG_FILE,
else the config's logFile, else the log launch writes.
`;

/**
 * Runs one jev-router command.
 * @param {string[]} argv the arguments after the program name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number | undefined>} the exit code, or undefined while `serve` keeps running
 */
export async function main(argv, env = process.env) {
  const [first] = argv;
  // `jev-router --port 4001` means `jev-router serve --port 4001`.
  const implicit = first === undefined || (first.startsWith('-') && !Object.hasOwn(COMMANDS, first));
  const name = implicit ? 'serve' : first;
  if (!Object.hasOwn(COMMANDS, name)) throw new Error(`unknown command "${name}". Run "jev-router help" for usage.`);
  return COMMANDS[name](implicit ? argv : argv.slice(1), env);
}

/**
 * Parses `--name value`, `--name=value` and boolean `--flag` options.
 * @param {string[]} args
 * @param {Record<string, 'value' | 'flag'>} spec the options the command takes
 * @param {{ passthrough?: boolean }} [mode] passthrough: stop at the first argument that isn't
 *   ours (or at `--`) and hand the rest to the agent untouched
 * @returns {{ values: Record<string, string | undefined>, flags: Set<string>, rest: string[] }}
 */
function parseArgs(args, spec, { passthrough = false } = {}) {
  /** @type {{ values: Record<string, string | undefined>, flags: Set<string>, rest: string[] }} */
  const parsed = { values: {}, flags: new Set(), rest: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const option = readOption(arg, spec);
    if (arg === '--' || (passthrough && !option)) {
      parsed.rest.push(...args.slice(arg === '--' ? i + 1 : i));
      break;
    }
    if (!option) {
      if (arg.startsWith('-')) throw new Error(`unknown option ${arg}. Run "jev-router help" for usage.`);
      parsed.rest.push(arg);
      continue;
    }
    if (option.kind === 'flag') {
      if (option.inline !== undefined) throw new Error(`${option.name} takes no value`);
      parsed.flags.add(option.key);
      continue;
    }
    const value = option.inline ?? args[i + 1];
    if (option.inline === undefined) i += 1;
    if (!value) throw new Error(`${option.name} needs a value`);
    parsed.values[option.key] = value;
  }
  return parsed;
}

/**
 * @param {string} arg
 * @param {Record<string, 'value' | 'flag'>} spec
 * @returns {{ name: string, key: string, kind: 'value' | 'flag', inline?: string } | undefined} the option `arg` names, if the command takes it
 */
function readOption(arg, spec) {
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  const name = eq > 2 ? arg.slice(0, eq) : arg;
  if (!Object.hasOwn(spec, name)) return undefined;
  return { name, key: name.slice(2), kind: spec[name], inline: eq > 2 ? arg.slice(eq + 1) : undefined };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string | undefined} the variable, with an empty one counted as unset
 */
const envValue = (env, name) => env[name] || undefined;

/**
 * An XDG base directory: the variable when it holds an absolute path (as the spec requires), else the default under $HOME.
 * @param {NodeJS.ProcessEnv} env
 * @param {'XDG_CONFIG_HOME' | 'XDG_STATE_HOME'} name
 * @param {string} fallback relative to $HOME
 */
function xdgDir(env, name, fallback) {
  const dir = envValue(env, name);
  return dir && isAbsolute(dir) ? dir : join(homedir(), fallback);
}

/** @param {NodeJS.ProcessEnv} env */
const userConfigPath = (env) => join(xdgDir(env, 'XDG_CONFIG_HOME', '.config'), 'jev-router', 'config.json');
/** @param {NodeJS.ProcessEnv} env */
const routerLogPath = (env) => join(xdgDir(env, 'XDG_STATE_HOME', join('.local', 'state')), 'jev-router', 'router.log');
/**
 * A path as given, with a leading ~ for the home directory: launchd and systemd pass arguments
 * without a shell to expand it.
 * @param {string} path
 */
const expandHome = (path) => resolve(path.replace(/^~(?=$|[/\\])/, () => homedir()));
/**
 * Creates a directory (mode 0700) with its parents. One that can't be made is reported by what
 * then fails to write into it.
 * @param {string} dir
 */
function makeDirectory(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // the log's own warning names the problem on the first line it can't write
  }
}

/**
 * The log file named by `serve --log-file`, else by JEV_ROUTER_LOG_FILE. It wins over the config's logFile.
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function namedLogFile(flag, env) {
  const given = flag ?? envValue(env, 'JEV_ROUTER_LOG_FILE');
  return given === undefined ? undefined : expandHome(given);
}
/** @param {NodeJS.ProcessEnv} env */
const codexProfilePath = (env) => join(envValue(env, 'CODEX_HOME') ?? join(homedir(), '.codex'), 'jev.config.toml');

/**
 * Picks the config file: --config, then JEV_ROUTER_CONFIG, then the user config if it exists, then the packaged default.
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ path: string, source: string }}
 */
function configFile(flag, env) {
  const fromEnv = envValue(env, 'JEV_ROUTER_CONFIG');
  if (flag) return { path: resolve(flag), source: '--config' };
  if (fromEnv) return { path: resolve(fromEnv), source: 'JEV_ROUTER_CONFIG' };
  const user = userConfigPath(env);
  if (existsSync(user)) return { path: user, source: 'user config' };
  return { path: DEFAULT_CONFIG, source: 'packaged default' };
}

/**
 * Variables Node reads only when it starts: an env file loaded later can set them, but they change
 * nothing. (NODE_OPTIONS isn't listed: Node itself applies it from a file named by --env-file.)
 * @type {ReadonlySet<string>}
 */
const STARTUP_ONLY = new Set(['NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);

/**
 * @typedef {object} EnvFile
 * @property {string} path
 * @property {string} source `--env-file` or `JEV_ROUTER_ENV_FILE`
 * @property {string[]} names the variables it set; a variable that was set already keeps its value and isn't listed
 */

/**
 * A file error in a few words: the file's path is in the message around it already.
 * @param {unknown} err
 */
function fileProblem(err) {
  const code = errorCode(err);
  if (code === 'ENOENT') return 'no such file';
  if (code === 'EACCES') return 'permission denied';
  return errorMessage(err);
}

/**
 * Loads the env file that --env-file or JEV_ROUTER_ENV_FILE names into the environment, with
 * Node's own loader: its KEY=VALUE lines are there before anything reads a key or a setting, and a
 * variable that is set already wins. The file holds API keys, so a mode that lets other users read
 * or change it gets a warning, as do variables that Node reads only when it starts.
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {EnvFile | undefined} undefined when no env file is given
 */
function loadEnvFile(flag, env) {
  const given = flag ?? envValue(env, 'JEV_ROUTER_ENV_FILE');
  if (given === undefined) return undefined;
  const path = expandHome(given);
  const source = flag === undefined ? 'JEV_ROUTER_ENV_FILE' : '--env-file';
  const before = new Set(Object.keys(process.env));
  let mode = 0;
  try {
    const info = statSync(path);
    if (!info.isFile()) throw new Error('not a file');
    mode = info.mode;
    process.loadEnvFile(path);
  } catch (err) {
    throw new Error(`Cannot read env file ${path} (${source}): ${fileProblem(err)}`);
  }
  const names = Object.keys(process.env).filter((name) => !before.has(name));
  // `env` is process.env unless a caller passed its own; it gets the file's variables too.
  if (env !== process.env) for (const name of names) env[name] ??= process.env[name];
  const loose = looseFile(path, mode);
  if (loose) console.error(`jev-router: ${loose}`);
  const late = names.filter((name) => STARTUP_ONLY.has(name.toUpperCase()));
  if (late.length) {
    const [they, have] = late.length === 1 ? ['it', 'has'] : ['them', 'have'];
    console.error(
      `jev-router: ${late.join(', ')} in ${path} ${have} no effect: Node reads ${they} only when it starts. Set ${they} where jev-router is started instead.`,
    );
  }
  return { path, source, names };
}

/**
 * The warning for a file of keys that other users can read or change. Windows has no such mode bits.
 * @param {string} path
 * @param {number} mode the file's mode
 * @returns {string | undefined} undefined when only its owner can
 */
function looseFile(path, mode) {
  if (process.platform === 'win32' || (mode & 0o066) === 0) return undefined;
  const verbs = [mode & 0o044 ? 'read' : '', mode & 0o022 ? 'change' : ''].filter(Boolean).join(' and ');
  const octal = (mode & 0o777).toString(8).padStart(3, '0');
  return `other users can ${verbs} ${path} (mode ${octal}), which holds API keys. Run: chmod 600 ${shellQuote(path)}`;
}

/**
 * The agent's environment under `launch`: the user's, without what the env file added. Those are
 * the router's keys, and every command the agent runs would see them.
 * @param {NodeJS.ProcessEnv} env
 * @param {EnvFile | undefined} file
 * @returns {NodeJS.ProcessEnv}
 */
function agentEnv(env, file) {
  if (!file?.names.length) return env;
  const added = new Set(file.names);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !added.has(name)));
}

/**
 * Loads the config and works out where the router listens and which token it expects.
 * @param {Record<string, string | undefined>} values the parsed --config, --host and --port
 * @param {NodeJS.ProcessEnv} env
 */
function settings(values, env) {
  const { path, source } = configFile(values.config, env);
  const cfg = loadConfig(path);
  const host = values.host ?? envValue(env, 'JEV_ROUTER_HOST') ?? cfg.host;
  const port = parsePort(values.port ?? envValue(env, 'JEV_ROUTER_PORT') ?? cfg.port);
  // The router reads the token the same way, so an empty JEV_ROUTER_TOKEN turns it off in both.
  const token = env.JEV_ROUTER_TOKEN ?? cfg.token;
  return { cfg, path, source, host, port, token };
}

/**
 * @param {string | number} value
 * @returns {number} a TCP port; 0 asks the OS for any free one
 */
function parsePort(value) {
  const port = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`port must be a number from 0 to 65535, got "${value}"`);
  return port;
}

/** @param {string} host */
const urlHost = (host) => (host.includes(':') ? `[${host}]` : host);
/**
 * The address a client on this machine uses for a router bound to `host`: one bound to every interface is reached on loopback.
 * @param {string} host
 */
const clientHost = (host) => (host === '0.0.0.0' || host === '::' ? LOOPBACK : urlHost(host));
/** @param {string} host */
const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);
/** @param {unknown} err */
const errorMessage = (err) => (err instanceof Error ? err.message : String(err));
/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
const errorCode = (err) => (err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined);

/**
 * Why a log line couldn't be written, in a few words.
 * @param {unknown} err
 */
function writeProblem(err) {
  const code = errorCode(err);
  if (code === 'ENOENT') return 'its directory does not exist';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ENOSPC') return 'no space left on the device';
  if (code === 'EISDIR') return 'it is a directory';
  return errorMessage(err);
}

/**
 * The router's log: one JSON line per event, for `echo` and appended to each file (created with
 * mode 0600). A file rotates to `<file>.1` before it would grow past `maxBytes`. A file that can't
 * be written costs its own lines and never a request: its first failure becomes a warning entry
 * for the other outputs, and `tell` hears about it, and about the file working again.
 * @param {() => { files: Array<string | null | undefined>, maxBytes: number }} targets looked up for every line, so a
 *   reloaded config's logFile and logMaxBytes apply
 * @param {{ echo?: (entry: Record<string, unknown>, line: string) => void, tell?: (text: string) => void }} [outputs]
 * @returns {(entry: Record<string, unknown>) => void}
 */
function logger(targets, { echo, tell } = {}) {
  /** @type {Set<string>} files whose last write failed */
  const failing = new Set();
  /** @param {Record<string, unknown>} entry */
  const write = (entry) => {
    const line = `${JSON.stringify(entry)}\n`;
    echo?.(entry, line);
    const { files, maxBytes } = targets();
    /** @type {string[]} */
    const problems = [];
    for (const file of new Set(files)) {
      if (!file) continue;
      try {
        appendLogLine(file, line, maxBytes);
        if (failing.delete(file)) tell?.(`jev-router: the log file ${file} can be written again`);
      } catch (err) {
        if (failing.has(file)) continue;
        failing.add(file);
        problems.push(`cannot write the log file ${file}: ${writeProblem(err)}. Its lines are lost until it can be written.`);
      }
    }
    // A failing file is marked already, so these warnings can't fail into another round.
    for (const message of problems) {
      tell?.(`jev-router: ${message}`);
      write({ ts: new Date().toISOString(), event: 'warning', message });
    }
  };
  return write;
}

/**
 * Logs where the config routes, so `jev-router ui` can draw it. Called at start and after a reload.
 * @param {(entry: Record<string, unknown>) => void} log
 * @param {Config} cfg
 */
const logConfig = (log, cfg) => log({ ts: new Date().toISOString(), event: 'config', ...describeConfig(cfg) });

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<number>} the port the server got
 */
function listen(server, port, host) {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      const address = server.address();
      done(typeof address === 'object' && address ? address.port : port);
    });
  });
}

/**
 * `jev-router [serve]`: runs the router in the foreground and logs one JSON line per event to stdout.
 * SIGHUP reloads the config; SIGTERM and SIGINT let in-flight requests finish, then exit.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<undefined>}
 */
async function serve(args, env) {
  const { values, rest } = parseArgs(args, {
    '--config': 'value',
    '--env-file': 'value',
    '--host': 'value',
    '--log-file': 'value',
    '--port': 'value',
    '--ui': 'value',
  });
  if (rest.length) throw new Error(`serve takes no arguments, got "${rest.join(' ')}"`);
  loadEnvFile(values['env-file'], env);
  const { cfg: loaded, path, host, port, token } = settings(values, env);
  // A service passes its log file on the command line, often in a directory that doesn't exist yet.
  const logFile = namedLogFile(values['log-file'], env);
  if (logFile) makeDirectory(dirname(logFile));
  if (!isLoopback(host) && !token) throw new Error(`Refusing to listen on ${host} without a token: set JEV_ROUTER_TOKEN.`);
  const uiAddress = parseUiAddress(values.ui ?? envValue(env, 'JEV_ROUTER_UI'));
  let cfg = { ...loaded, host, port };
  let stdoutBroken = false;
  // A closed pipe must not crash the router: `serve 2>&1 | tee router.log` loses both when tee goes.
  process.stdout.on('error', () => {
    stdoutBroken = true;
  });
  process.stderr.on('error', () => undefined);
  const view = uiAddress ? createUiServer() : undefined;
  const log = logger(() => ({ files: [logFile ?? cfg.logFile], maxBytes: cfg.logMaxBytes }), {
    echo: (entry, line) => {
      if (!stdoutBroken) process.stdout.write(line);
      view?.publish(entry);
    },
    tell: (text) => console.error(text),
  });
  /** @param {string} text a message for people: stderr, and a notice in the live view */
  const say = (text) => {
    console.error(text);
    view?.publish({ ts: new Date().toISOString(), event: 'text', text });
  };
  const server = createRouter(cfg, { log });
  const bound = await listen(server, port, host).catch((err) => {
    throw new Error(`cannot listen on ${urlHost(host)}:${port}: ${errorMessage(err)}`);
  });
  console.error(`jev-router ${VERSION} listening on http://${urlHost(host)}:${bound}`);
  logConfig(log, cfg);
  if (view && uiAddress) await startView(view, uiAddress);
  process.on('SIGHUP', () => {
    try {
      cfg = { ...loadConfig(path), host, port };
      server.reload(cfg);
      logConfig(log, cfg);
      say('jev-router: config reloaded');
    } catch (err) {
      say(`jev-router: reload failed, keeping the old config\n${errorMessage(err)}`);
    }
  });
  const shutdown = () => {
    console.error(`jev-router: shutting down, waiting for ${server.active} request(s)`);
    void view?.close();
    server.close();
    const deadline = Date.now() + 30000;
    const wait = setInterval(() => {
      if (server.active === 0 || Date.now() > deadline) {
        clearInterval(wait);
        process.exit(0);
      }
    }, 100);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return undefined;
}

/**
 * The address for `serve --ui` and JEV_ROUTER_UI: a port, or host:port ([::]:4100 for IPv6).
 * @param {string | undefined} value
 * @returns {{ host: string, port: number } | undefined} undefined when no view is wanted
 */
function parseUiAddress(value) {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return { host: LOOPBACK, port: parsePort(value) };
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d+)$/.exec(value);
  if (!match) throw new Error(`--ui takes a port or host:port, got "${value}"`);
  return { host: match[1] ?? match[2], port: parsePort(match[3]) };
}

/**
 * Starts the live view of `serve --ui`. A view that can't listen is reported, and routing goes on
 * without it: the view must never take the router down.
 * @param {UiServer} view
 * @param {{ host: string, port: number }} address
 */
async function startView(view, { host, port }) {
  try {
    const url = await view.listen(port, host);
    console.error(`jev-router: live view on ${url}`);
    if (!isLoopback(host))
      console.error(
        `jev-router: the live view listens on ${urlHost(host)}, so anyone who can reach that address can watch routing decisions (models, tiers, costs; never prompts or keys).`,
      );
  } catch (err) {
    console.error(`jev-router: the live view can't listen on ${urlHost(host)}:${port}: ${errorMessage(err)}. Routing goes on without it.`);
  }
}

/** @type {Record<string, { bin: string, override: string, spec: Record<string, 'value' | 'flag'> }>} */
const AGENTS = {
  claude: { bin: 'claude', override: 'JEV_ROUTER_CLAUDE_BIN', spec: { '--config': 'value', '--env-file': 'value', '--port': 'value' } },
  codex: {
    bin: 'codex',
    override: 'JEV_ROUTER_CODEX_BIN',
    spec: { '--config': 'value', '--env-file': 'value', '--port': 'value', '--force': 'flag' },
  },
};

/**
 * `jev-router launch claude|codex`: runs the agent through a router and exits with the agent's exit code.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
async function launch(args, env) {
  const [name = '', ...rest] = args;
  const agent = Object.hasOwn(AGENTS, name) ? AGENTS[name] : undefined;
  if (!agent)
    throw new Error('Usage: jev-router launch claude|codex [--config <file>] [--env-file <file>] [--port <n>] [--] [agent args…]');
  const { values, flags, rest: agentArgs } = parseArgs(rest, agent.spec, { passthrough: true });
  const file = loadEnvFile(values['env-file'], env);
  const { cfg, host, port, token } = settings(values, env);
  const wanted = envValue(env, agent.override) ?? agent.bin;
  const bin = findProgram(wanted, env);
  if (!bin) {
    console.error(`jev-router: cannot find ${wanted}. Install it, or set ${agent.override} to its path.`);
    return 127;
  }
  const router = await routerFor(cfg, host, port, env);
  console.error(
    router.reused
      ? `jev-router: reusing the jev-router ${router.version} at ${router.url}`
      : `jev-router: routing ${name} through ${router.url} (log: ${router.logFile})`,
  );
  const forAgent = agentEnv(env, file);
  try {
    if (name === 'codex') {
      writeCodexProfile(env, router.url, token, flags.has('force'));
      return await runAgent(bin, ['--profile', 'jev', ...agentArgs], forAgent);
    }
    return await runAgent(bin, agentArgs, { ...forAgent, ...claudeVars(forAgent, router.url, token) });
  } finally {
    await router.stop();
  }
}

/**
 * Finds a program the way a shell does: a name with a slash is a path, anything else is looked up on PATH.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined} the executable's path
 */
function findProgram(name, env) {
  if (name.includes('/') || name.includes('\\')) return isExecutable(resolve(name)) ? resolve(name) : undefined;
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return dirs.flatMap((dir) => exts.map((ext) => join(dir, `${name}${ext}`))).find(isExecutable);
}

/** @param {string} file */
function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * @typedef {object} AgentRouter
 * @property {string} url where the agent sends requests
 * @property {boolean} reused whether it was already running
 * @property {string} [version] the running router's version
 * @property {string} [logFile] where a router started here logs
 * @property {() => Promise<void>} stop
 */
/**
 * The file that marks a router as belonging to a running `launch`.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} port
 */
const ownerFile = (env, port) => join(dirname(routerLogPath(env)), `launch-${port}.pid`);

/**
 * Whether the router on `port` belongs to another `launch`. That router stops when its own agent
 * exits, so a second session must not lean on it.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} port
 */
function ownedByLaunch(env, port) {
  try {
    process.kill(Number(readFileSync(ownerFile(env, port), 'utf8')), 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM'; // alive, just not ours to signal; no file or no such process means no owner
  }
}

/**
 * Finds the router the agent should use: one that already answers at host:port, or a new one in
 * this process on loopback. The new one logs to files only, because the agent's TUI owns the terminal.
 * @param {Config} cfg
 * @param {string} host
 * @param {number} port
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<AgentRouter>}
 */
async function routerFor(cfg, host, port, env) {
  const url = `http://${clientHost(host)}:${port}`;
  const found = port === 0 ? undefined : await probe(url); // port 0 asks for any free port, so there's nothing to find
  if (found?.health && !ownedByLaunch(env, port)) return { url, reused: true, version: found.health.version, stop: async () => undefined };
  const logFile = routerLogPath(env);
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const log = logger(() => ({ files: [logFile, cfg.logFile], maxBytes: cfg.logMaxBytes }));
  const server = createRouter({ ...cfg, host: LOOPBACK, port }, { log });
  let bound;
  try {
    bound = await listen(server, port, LOOPBACK);
  } catch (err) {
    // Something else holds the port: another program, or another session's router. Any free port
    // works, because the agent is handed the URL.
    if (!['EADDRINUSE', 'EACCES'].includes(errorCode(err) ?? '')) throw err;
    bound = await listen(server, 0, LOOPBACK);
  }
  logConfig(log, cfg);
  const owner = ownerFile(env, bound);
  writeFileSync(owner, String(process.pid), { mode: 0o600 });
  const stop = async () => {
    await stopRouter(server);
    rmSync(owner, { force: true });
  };
  return { url: `http://${LOOPBACK}:${bound}`, reused: false, logFile, stop };
}

/**
 * Stops a router this process started: no new connections, up to 5 s for requests in flight, then close.
 * @param {RouterServer} server
 */
async function stopRouter(server) {
  const closed = new Promise((done) => server.close(done));
  const deadline = Date.now() + 5000;
  while (server.active > 0 && Date.now() < deadline) await sleep(50);
  server.closeAllConnections();
  await closed;
}

/**
 * Runs the agent in the foreground. Resolves with its exit code, or 128 + the signal number that ended it.
 * @param {string} bin
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
function runAgent(bin, args, env) {
  return new Promise((done) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    const ignore = () => {
      // Ctrl-C reaches the whole foreground process group, and the agent handles it itself (Claude
      // Code interrupts the turn). Exiting here would pull the router out from under it.
    };
    /** @param {NodeJS.Signals} signal */
    const forward = (signal) => {
      child.kill(signal);
    };
    process.on('SIGINT', ignore);
    process.on('SIGTERM', forward);
    process.on('SIGHUP', forward);
    let settled = false;
    /** @param {number} code */
    const finish = (code) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', ignore);
      process.off('SIGTERM', forward);
      process.off('SIGHUP', forward);
      done(code);
    };
    child.on('error', (err) => {
      console.error(`jev-router: cannot run ${bin}: ${err.message}`);
      finish(errorCode(err) === 'ENOENT' ? 127 : 126);
    });
    child.on('exit', (code, signal) => finish(code ?? 128 + (signal ? osConstants.signals[signal] : 0)));
  });
}

/**
 * The variables Claude Code needs to use the router. Credentials stay the user's: the router
 * passes Claude Code's own login through to Anthropic, so ANTHROPIC_API_KEY is never set here.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} url
 * @param {string | undefined} token
 * @returns {Record<string, string>}
 */
function claudeVars(env, url, token) {
  /** @type {Record<string, string>} */
  const vars = { ANTHROPIC_BASE_URL: url, CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1' };
  if (!env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) vars.CLAUDE_CODE_AUTO_COMPACT_WINDOW = COMPACT_WINDOW;
  // Claude Code turns MCP tool search off for a base URL that isn't Anthropic's, and then sends every
  // MCP tool's definition with every request: with a few MCP servers that is more than the compaction
  // window, and Claude Code compacts on every turn. The router forwards tool_reference blocks as is.
  if (!env.ENABLE_TOOL_SEARCH) vars.ENABLE_TOOL_SEARCH = 'true';
  if (token) vars.ANTHROPIC_CUSTOM_HEADERS = withHeader(env.ANTHROPIC_CUSTOM_HEADERS, TOKEN_HEADER, token);
  return vars;
}

/**
 * ANTHROPIC_CUSTOM_HEADERS holds one `Name: value` per line. The user's lines stay; an old router
 * token goes, because a repeated header reaches the router as "a, b" and fails the token check.
 * @param {string | undefined} existing
 * @param {string} name lower case
 * @param {string} value
 */
function withHeader(existing, name, value) {
  const lines = (existing ?? '').split(/\r?\n/).filter((line) => line.trim() && line.split(':', 1)[0].trim().toLowerCase() !== name);
  return [...lines, `${name}: ${value}`].join('\n');
}

/**
 * A TOML basic string. JSON's escapes are valid TOML; DEL is the one character TOML also wants escaped.
 * @param {string} value
 */
const tomlString = (value) => JSON.stringify(value).replaceAll('\u007f', '\\u007f');

/**
 * The Codex profile for a router at `url`, from the packaged example with its placeholders filled in.
 * @param {string} url
 * @param {string | undefined} token
 */
function codexProfile(url, token) {
  const header = token ? `\nhttp_headers = { ${tomlString(TOKEN_HEADER)} = ${tomlString(token)} }` : '';
  const text = readFileSync(CODEX_TEMPLATE, 'utf8')
    .replace(/^model_catalog_json = .*$/m, () => `model_catalog_json = ${tomlString(CODEX_MODELS)}`)
    .replace(/^base_url = .*$/m, () => `base_url = ${tomlString(`${url}/v1`)}${header}`);
  return `# Written by \`jev-router launch codex\`, which leaves the file alone once you edit it (--force rewrites it).\n${text}`;
}

/**
 * Whether `text` is a profile this command wrote that nobody has edited since, whatever router URL
 * and token it names. Such a file follows the router when its port or token changes.
 * @param {string} text
 */
function isOwnProfile(text) {
  const url = /^base_url = (".*")$/m.exec(text)?.[1];
  const token = /^http_headers = \{ "x-jev-router-token" = (".*") \}$/m.exec(text)?.[1];
  try {
    return url !== undefined && text === codexProfile(JSON.parse(url).replace(/\/v1$/, ''), token && JSON.parse(token));
  } catch {
    return false; // not a TOML string we wrote
  }
}

/**
 * Writes $CODEX_HOME/jev.config.toml. An edited file stays as it is unless `force` is set.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} url
 * @param {string | undefined} token
 * @param {boolean} force
 */
function writeCodexProfile(env, url, token, force) {
  const path = codexProfilePath(env);
  const text = codexProfile(url, token);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (current === text) return;
  if (current !== undefined && !force && !isOwnProfile(current)) {
    console.error(`jev-router: kept ${path} because it was edited. Pass --force to replace it with the profile for ${url}/v1.`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600); // the profile may hold the router token
}

/**
 * Quotes a value for a POSIX shell when it needs it.
 * @param {string} value
 */
const shellQuote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);

/**
 * `jev-router env claude|codex`: prints what a shell needs to use the router, without starting one.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
async function printEnv(args, env) {
  const { values, rest } = parseArgs(args, { '--config': 'value', '--env-file': 'value', '--port': 'value' });
  const [agent, ...extra] = rest;
  if (!(agent === 'claude' || agent === 'codex') || extra.length)
    throw new Error('Usage: jev-router env claude|codex [--config <file>] [--env-file <file>] [--port <n>]');
  loadEnvFile(values['env-file'], env);
  const { host, port, token } = settings(values, env);
  if (port === 0) throw new Error('env needs the port the router listens on, not 0');
  const url = `http://${clientHost(host)}:${port}`;
  const lines =
    agent === 'claude'
      ? Object.entries(claudeVars(env, url, token)).map(([name, value]) => `export ${name}=${shellQuote(value)}`)
      : codexHelp(env, url);
  process.stdout.write(`${lines.join('\n')}\n`);
  if (!(await probe(url)).health) console.error(`jev-router: nothing answers at ${url} yet. Start a router with: jev-router serve`);
  return 0;
}

/**
 * Codex takes the router from a profile, not from the environment, so `env codex` explains that in comments a shell ignores.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} url
 */
function codexHelp(env, url) {
  const profile = codexProfilePath(env);
  return [
    '# Codex reads the router from a profile, not from environment variables.',
    `# Profile: ${profile} (${existsSync(profile) ? 'exists' : 'not written yet: `jev-router launch codex` writes it'})`,
    `# Router:  ${url}/v1`,
    '# Run:     codex --profile jev',
  ];
}

/**
 * @typedef {{ answered: boolean, health?: Health }} Probe
 */
/**
 * Asks whatever listens at `url` for jev-router's /healthz. It uses a plain agent because loopback
 * needs no proxy: with NODE_USE_ENV_PROXY=1 the default agent would send this to HTTP_PROXY.
 * @param {string} url
 * @returns {Promise<Probe>}
 */
function probe(url) {
  return new Promise((done) => {
    const req = http.get(`${url}/healthz`, { agent: false, timeout: 1000 }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', () => done({ answered: true }));
      res.on('end', () => done({ answered: true, health: parseHealth(res.statusCode, Buffer.concat(chunks).toString()) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => done({ answered: false }));
  });
}

/**
 * @param {number | undefined} status
 * @param {string} text
 * @returns {Health | undefined} the health report, if a jev-router sent it
 */
function parseHealth(status, text) {
  try {
    const body = JSON.parse(text);
    return status === 200 && body?.ok === true && typeof body.jev === 'object' ? body : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `jev-router doctor`: a checklist of what routing needs. It exits 1 when the config is invalid, no
 * Jev channel has a key, or a --live call fails. It names environment variables, never their values.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
async function doctor(args, env) {
  const { values, flags, rest } = parseArgs(args, { '--config': 'value', '--live': 'flag' });
  if (rest.length) throw new Error('Usage: jev-router doctor [--config <file>] [--live]');
  const list = checklist();
  const cfg = checkConfig(list, values.config, env);
  const major = Number(process.versions.node.split('.')[0]);
  list.add(major >= 22 ? 'ok' : 'warn', 'node', major >= 22 ? process.version : `${process.version}: jev-router needs Node 22 or newer`);
  if (cfg) {
    checkJevKeys(list, cfg, env);
    checkUpstreams(list, cfg, env);
  }
  checkProxy(list, env);
  await checkRouter(list, cfg, env);
  if (cfg && flags.has('live')) await checkLive(list, cfg, env);
  const verdict = list.failed ? 'Not ready: fix the FAIL lines above.' : 'Ready. Start a session with: jev-router launch claude';
  process.stdout.write(`jev-router ${VERSION} doctor\n${list.lines.join('\n')}\n\n${verdict}\n`);
  return list.failed ? 1 : 0;
}

/** @returns {Checklist} */
function checklist() {
  /** @type {string[]} */
  const lines = [];
  let failed = false;
  return {
    lines,
    get failed() {
      return failed;
    },
    add(status, topic, text) {
      failed ||= status === 'FAIL';
      lines.push(`  ${status.padEnd(5)}${topic.padEnd(10)}${text.replaceAll('\n', `\n${' '.repeat(17)}`)}`);
    },
  };
}

/**
 * @param {Checklist} list
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {Config | undefined}
 */
function checkConfig(list, flag, env) {
  const { path, source } = configFile(flag, env);
  try {
    const cfg = loadConfig(path);
    list.add('ok', 'config', `${path} (${source})`);
    return cfg;
  } catch (err) {
    list.add('FAIL', 'config', `${path} (${source})\n${errorMessage(err)}`);
    return undefined;
  }
}

/**
 * @param {Checklist} list
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 */
function checkJevKeys(list, cfg, env) {
  for (const { name, keyEnv } of cfg.jev.channels) {
    list.add(env[keyEnv] ? 'ok' : 'warn', 'jev', `${name}: ${keyEnv} is ${env[keyEnv] ? 'set' : 'not set'}`);
  }
  if (env.JEV_BASE_URL && env.JEV_API_KEY) list.add('ok', 'jev', 'env: JEV_BASE_URL and JEV_API_KEY are set, so this channel goes first');
  if (!new JevClient(cfg.jev, env).configured) {
    const keys = cfg.jev.channels.map((ch) => ch.keyEnv).join(' or ') || 'JEV_BASE_URL and JEV_API_KEY';
    list.add('FAIL', 'jev', `no Jev channel has a key, so every session would get the default tier "${cfg.defaultTier}". Set ${keys}.`);
  }
}

/**
 * Upstream keys, grouped by variable: many targets share one.
 * @param {Checklist} list
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 */
function checkUpstreams(list, cfg, env) {
  /** @type {Map<string, { targets: string[], stranded: string[] }>} */
  const byKey = new Map();
  for (const [surface, targets] of Object.entries(cfg.surfaces)) {
    for (const [tier, target] of Object.entries(targets)) {
      const group = byKey.get(target.keyEnv ?? '') ?? { targets: [], stranded: [] };
      group.targets.push(`${surface}.${tier}`);
      if (!target.clientAuth) group.stranded.push(`${surface}.${tier}`);
      byKey.set(target.keyEnv ?? '', group);
    }
  }
  for (const [key, { targets, stranded }] of byKey) {
    const unset = key ? `${key} is not set` : 'no key configured';
    if (key && env[key]) list.add('ok', 'upstream', `${key} is set: ${targets.join(', ')}`);
    else if (!stranded.length) list.add('ok', 'upstream', `${unset}: ${targets.join(', ')} pass the client's own login through`);
    else list.add('warn', 'upstream', `${unset}: ${stranded.join(', ')} will fail`);
  }
}

/**
 * @param {Checklist} list
 * @param {NodeJS.ProcessEnv} env
 */
function checkProxy(list, env) {
  if (!(env.HTTPS_PROXY || env.https_proxy)) return;
  if (env.NODE_USE_ENV_PROXY === '1')
    list.add('ok', 'proxy', 'HTTPS_PROXY is set and NODE_USE_ENV_PROXY=1, so Jev and upstream calls use it');
  else list.add('hint', 'proxy', 'HTTPS_PROXY is set, but Node ignores it without NODE_USE_ENV_PROXY=1');
}

/**
 * @param {Checklist} list
 * @param {Config | undefined} cfg
 * @param {NodeJS.ProcessEnv} env
 */
async function checkRouter(list, cfg, env) {
  let url;
  try {
    const host = envValue(env, 'JEV_ROUTER_HOST') ?? cfg?.host ?? LOOPBACK;
    url = `http://${clientHost(host)}:${parsePort(envValue(env, 'JEV_ROUTER_PORT') ?? cfg?.port ?? 4000)}`;
  } catch (err) {
    list.add('FAIL', 'router', errorMessage(err));
    return;
  }
  const { answered, health } = await probe(url);
  if (health) {
    const channels = Object.entries(health.jev.channels).map(
      ([name, s]) => `${name} ${s.open ? `failing (${s.lastError})` : 'ok'} (${s.calls} calls, ${s.errors} errors)`,
    );
    const jev = health.jev.configured ? channels.join(', ') : 'no channel has a key';
    list.add(
      'ok',
      'router',
      `jev-router ${health.version} answers at ${url} (up ${health.uptime_s} s, ${health.sessions} sessions); Jev: ${jev}`,
    );
  } else if (answered) list.add('warn', 'router', `something answers at ${url}, but it is not a jev-router`);
  else list.add('info', 'router', `nothing answers at ${url}; start one with: jev-router serve`);
}

/**
 * One real Jev call with a small state in the shape the router sends. It costs about $0.00003.
 * @param {Checklist} list
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 */
async function checkLive(list, cfg, env) {
  const client = new JevClient(cfg.jev, env);
  if (!client.configured) {
    list.add('info', 'live', 'skipped: no Jev channel has a key');
    return;
  }
  const answer = await client.decide({
    request: 'Rename the variable tmp to total in utils.py.',
    session: { harness: 'Claude Code', depth: 'new session' },
  });
  if (answer.ok) list.add('ok', 'live', `${answer.channel} answered in ${answer.ms} ms with ${answer.model} (choice: ${answer.choice})`);
  else list.add('FAIL', 'live', `no answer after ${answer.ms} ms: ${answer.error}`);
}

/**
 * `jev-router init`: copies a packaged config to the user config path.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function init(args, env) {
  const { flags, rest } = parseArgs(args, { '--anthropic-only': 'flag', '--force': 'flag' });
  if (rest.length) throw new Error('Usage: jev-router init [--anthropic-only] [--force]');
  const source = flags.has('anthropic-only') ? ANTHROPIC_ONLY_CONFIG : DEFAULT_CONFIG;
  const target = userConfigPath(env);
  if (existsSync(target) && !flags.has('force')) {
    console.error(`jev-router: ${target} already exists. Pass --force to overwrite it.`);
    return 1;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, readFileSync(source), { mode: 0o600 });
  chmodSync(target, 0o600); // an overwritten file keeps its old mode otherwise, and the config may hold a token
  process.stdout.write(`Wrote ${target} from the packaged ${basename(source)}.\nNext: set your Jev key, then run: jev-router doctor\n`);
  return 0;
}

/**
 * `jev-router report [log]`: requests, spend and savings from a router log. Without an argument it
 * reads the config's logFile, else the log that `launch` writes, with the lines its last rotation kept.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function printReport(args, env) {
  const { values, rest } = parseArgs(args, { '--config': 'value' });
  if (rest.length > 1) throw new Error('Usage: jev-router report [<log.jsonl>]');
  const [named] = rest;
  const launched = routerLogPath(env);
  const file =
    named ??
    namedLogFile(undefined, env) ??
    loadConfig(configFile(values.config, env).path).logFile ??
    (existsSync(launched) ? launched : undefined);
  if (!file) throw new Error('Usage: jev-router report <log.jsonl> (or set logFile in the config)');
  // The router's own log keeps the lines from before its last rotation in <file>.1.
  const files = named === undefined && existsSync(`${file}.1`) ? [`${file}.1`, file] : [file];
  const lines = files.flatMap((path) => readFileSync(path, 'utf8').split('\n'));
  process.stdout.write(`${JSON.stringify(report(lines), null, 2)}\n`);
  return 0;
}

/**
 * `jev-router ui [log]`: a live view of routing in the browser, on loopback. It follows the log
 * given, else the config's logFile, else the log that `launch` writes, and waits for a log that
 * doesn't exist yet.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<undefined>}
 */
async function ui(args, env) {
  const { values, rest } = parseArgs(args, { '--config': 'value', '--port': 'value' });
  if (rest.length > 1) throw new Error('Usage: jev-router ui [<log.jsonl>] [--port <n>]');
  const file = resolve(
    rest[0] ?? namedLogFile(undefined, env) ?? loadConfig(configFile(values.config, env).path).logFile ?? routerLogPath(env),
  );
  const port = values.port === undefined ? UI_PORT : parsePort(values.port);
  const view = createUiServer({ file });
  const url = await view.listen(port).catch((err) => {
    throw new Error(`cannot listen on ${LOOPBACK}:${port}: ${errorMessage(err)}`);
  });
  console.error(
    `jev-router ui: open ${url}\nFollowing ${file}${existsSync(file) ? '' : ' (not there yet: waiting for the router to write it)'}`,
  );
  const stop = () => {
    void view.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return undefined;
}

const printVersion = () => {
  process.stdout.write(`${VERSION}\n`);
  return 0;
};

const printHelp = () => {
  process.stdout.write(HELP);
  return 0;
};

/** @type {Record<string, (args: string[], env: NodeJS.ProcessEnv) => Promise<number | undefined> | number>} */
const COMMANDS = {
  serve,
  launch,
  env: printEnv,
  doctor,
  init,
  report: printReport,
  ui,
  version: printVersion,
  '--version': printVersion,
  help: printHelp,
  '--help': printHelp,
  '-h': printHelp,
};
