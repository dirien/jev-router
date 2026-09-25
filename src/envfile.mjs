// The env file: KEY=value lines that hold the router's keys and settings, loaded with Node's own
// loader before anything reads the environment.
import { statSync } from 'node:fs';
import { envValue, errorCode, errorMessage, expandHome, shellQuote } from './files.mjs';

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
 * @property {string[]} warnings what is wrong with it: a mode that lets other users at the keys, or settings it can't make
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
export function loadEnvFile(flag, env) {
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
  const warnings = [];
  const loose = looseFile(path, mode);
  if (loose) warnings.push(loose);
  const late = names.filter((name) => STARTUP_ONLY.has(name.toUpperCase()));
  if (late.length) {
    const [they, have] = late.length === 1 ? ['it', 'has'] : ['them', 'have'];
    warnings.push(
      `${late.join(', ')} in ${path} ${have} no effect: Node reads ${they} only when it starts. Set ${they} where jev-router is started instead.`,
    );
  }
  return { path, source, names, warnings };
}

/**
 * The warning for a file of keys that other users can read or change. Windows has no such mode bits.
 * @param {string} path
 * @param {number} mode the file's mode
 * @returns {string | undefined} undefined when only its owner can
 */
export function looseFile(path, mode) {
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
export function agentEnv(env, file) {
  if (!file?.names.length) return env;
  const added = new Set(file.names);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !added.has(name)));
}
