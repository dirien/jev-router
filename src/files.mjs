// Where jev-router's files live, how programs are found on PATH, and how a file is replaced safely.
// The commands share these rules, so a service, a shell and `doctor` agree on every path.
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @import { Models } from './types.js' */

/**
 * A path inside the installed package.
 * @param {string} path relative to the package root
 */
export const packaged = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
/** The packaged config that sends Claude Code's fast tier to Ollama Cloud: the router's config when there is no other. */
export const DEFAULT_CONFIG = packaged('config/default.json');
/** The packaged config that keeps Claude Code on Claude models. */
export const ANTHROPIC_ONLY_CONFIG = packaged('config/anthropic-only.json');
/** The packaged config that keeps Claude Code on Claude models, with Fable 5.1 as a fourth tier, `max`, for deep work. */
export const ANTHROPIC_FABLE_CONFIG = packaged('config/anthropic-fable.json');
/** The packaged configs by the name `setup --models` and `init --models` give them, in the order setup offers them. */
export const PACKAGED_CONFIGS = Object.freeze({ claude: ANTHROPIC_ONLY_CONFIG, fable: ANTHROPIC_FABLE_CONFIG, ollama: DEFAULT_CONFIG });
/** @type {ReadonlyArray<Models>} */
export const MODEL_CHOICES = ['claude', 'fable', 'ollama'];

/**
 * The packaged config a file is an exact copy of: one that setup or init wrote and nobody has changed since.
 * @param {string} path
 * @returns {Models | undefined} undefined for any other file, or one that can't be read
 */
export function packagedModels(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  return MODEL_CHOICES.find((name) => readFileSync(PACKAGED_CONFIGS[name], 'utf8') === text);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string | undefined} the variable, with an empty one counted as unset
 */
export const envValue = (env, name) => env[name] || undefined;

/** @param {unknown} err */
export const errorMessage = (err) => (err instanceof Error ? err.message : String(err));
/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
export const errorCode = (err) => (err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined);

/**
 * An XDG base directory: the variable when it holds an absolute path (as the spec requires), else the default under $HOME.
 * @param {NodeJS.ProcessEnv} env
 * @param {'XDG_CONFIG_HOME' | 'XDG_STATE_HOME'} name
 * @param {string} fallback relative to $HOME
 */
export function xdgDir(env, name, fallback) {
  const dir = envValue(env, name);
  return dir && isAbsolute(dir) ? dir : join(homedir(), fallback);
}

/** @param {NodeJS.ProcessEnv} env */
const configDir = (env) => join(xdgDir(env, 'XDG_CONFIG_HOME', '.config'), 'jev-router');
/**
 * The user config, `$XDG_CONFIG_HOME/jev-router/config.json`, that `init` and `setup` write.
 * @param {NodeJS.ProcessEnv} env
 */
export const userConfigPath = (env) => join(configDir(env), 'config.json');
/**
 * The env file every command loads when no other is named: `$XDG_CONFIG_HOME/jev-router/env`.
 * @param {NodeJS.ProcessEnv} env
 */
export const standardEnvFile = (env) => join(configDir(env), 'env');
/**
 * What `setup` changed, for `uninstall`: `$XDG_CONFIG_HOME/jev-router/setup.json`. It holds no secrets.
 * @param {NodeJS.ProcessEnv} env
 */
export const setupManifestPath = (env) => join(configDir(env), 'setup.json');
/**
 * The router log that `launch` and the services write, and `report` and `ui` read by default.
 * @param {NodeJS.ProcessEnv} env
 */
export const routerLogPath = (env) => join(xdgDir(env, 'XDG_STATE_HOME', join('.local', 'state')), 'jev-router', 'router.log');
/**
 * Claude Code's user settings: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`.
 * @param {NodeJS.ProcessEnv} env
 */
export const claudeSettingsPath = (env) => join(envValue(env, 'CLAUDE_CONFIG_DIR') ?? join(homedir(), '.claude'), 'settings.json');

/**
 * A path as given, with a leading ~ for the home directory: launchd and systemd pass arguments
 * without a shell to expand it.
 * @param {string} path
 */
export const expandHome = (path) => resolve(path.replace(/^~(?=$|[/\\])/, () => homedir()));

/**
 * The log file named by `serve --log-file`, else by JEV_ROUTER_LOG_FILE. It wins over the config's logFile.
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
export function namedLogFile(flag, env) {
  const given = flag ?? envValue(env, 'JEV_ROUTER_LOG_FILE');
  return given === undefined ? undefined : expandHome(given);
}

/**
 * Picks the config file: --config, then JEV_ROUTER_CONFIG, then the user config if it exists, then the packaged default.
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ path: string, source: string }}
 */
export function configFile(flag, env) {
  const fromEnv = envValue(env, 'JEV_ROUTER_CONFIG');
  if (flag) return { path: resolve(flag), source: '--config' };
  if (fromEnv) return { path: resolve(fromEnv), source: 'JEV_ROUTER_CONFIG' };
  const user = userConfigPath(env);
  if (existsSync(user)) return { path: user, source: 'user config' };
  return { path: DEFAULT_CONFIG, source: 'packaged default' };
}

/**
 * Creates a directory (mode 0700) with its parents. One that can't be made is reported by what
 * then fails to write into it.
 * @param {string} dir
 */
export function makeDirectory(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // the write that follows names the problem
  }
}

/**
 * Replaces a file in one step: the text goes to a temporary file next to it, which is renamed over
 * it, so a reader sees the old file or the new one and never half of one. A symbolic link stays a
 * link: the file it points to is the one replaced, as in a dotfiles repository. A missing directory
 * is created with mode 0700.
 * @param {string} path
 * @param {string} text
 * @param {number} mode the new file's permissions
 */
export function writeFileAtomic(path, text, mode) {
  const target = linkTarget(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode });
    chmodSync(temporary, mode); // the umask may have taken bits away
    renameSync(temporary, target);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

/**
 * The file a path stands for: the path itself, or the file a symbolic link there points to, even
 * one that doesn't exist yet.
 * @param {string} path
 */
function linkTarget(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return path;
  } catch {
    return path; // nothing there yet
  }
  try {
    return realpathSync(path);
  } catch {
    return resolve(dirname(path), readlinkSync(path)); // a link to a file that isn't there yet
  }
}

/**
 * Whether text holds a control character, such as a line break or a NUL: no path, host or key has
 * one, and a service file or an HTTP header can't carry it.
 * @param {string} text
 */
export const hasControlCharacter = (text) => [...text].some((char) => char < ' ' || char === '\u007f');

/**
 * The file that turns the env file off: named by --env-file or JEV_ROUTER_ENV_FILE, no file is loaded.
 */
export const NO_ENV_FILE = '/dev/null';

/**
 * Finds a program the way a shell does: a name with a slash is a path, anything else is looked up on PATH.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined} the executable's path
 */
export function findProgram(name, env) {
  return programCandidates(name, env)[0];
}

/**
 * Every executable a name could mean, in the order a shell would try them.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function programCandidates(name, env) {
  if (name.includes('/') || name.includes('\\')) return isExecutable(resolve(name)) ? [resolve(name)] : [];
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return dirs.flatMap((dir) => exts.map((ext) => join(dir, `${name}${ext}`))).filter(isExecutable);
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
 * Quotes a value for a POSIX shell when it needs it.
 * @param {string} value
 */
export const shellQuote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);
