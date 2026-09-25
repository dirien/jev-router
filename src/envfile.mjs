// The env file: KEY=value lines that hold the router's keys and settings, loaded with Node's own
// loader before anything reads the environment.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { envValue, errorCode, errorMessage, expandHome, NO_ENV_FILE, shellQuote, standardEnvFile, writeFileAtomic } from './files.mjs';

/**
 * Variables Node reads only when it starts: an env file loaded later can set them, but they change
 * nothing. (NODE_OPTIONS isn't listed: Node itself applies it from a file named by --env-file.)
 * @type {ReadonlySet<string>}
 */
const STARTUP_ONLY = new Set(['NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);

/**
 * @typedef {object} EnvFile
 * @property {string} path
 * @property {string} source what named it: `--env-file`, `JEV_ROUTER_ENV_FILE`, or `default location` for the
 *   standard file that is loaded when neither names one
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

/** What names the standard env file in messages, when it's loaded because nothing else was named. */
export const DEFAULT_SOURCE = 'default location';

/**
 * The env file a command loads: the one --env-file or JEV_ROUTER_ENV_FILE names, else the standard
 * file, `$XDG_CONFIG_HOME/jev-router/env`, when it exists. Naming /dev/null turns it off.
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ path: string, source: string } | undefined} undefined when there's no env file to load
 */
export function envFileFor(flag, env) {
  const given = flag ?? envValue(env, 'JEV_ROUTER_ENV_FILE');
  if (given !== undefined && expandHome(given) === NO_ENV_FILE) return undefined;
  if (given !== undefined) return { path: expandHome(given), source: flag === undefined ? 'JEV_ROUTER_ENV_FILE' : '--env-file' };
  const standard = standardEnvFile(env);
  return existsSync(standard) ? { path: standard, source: DEFAULT_SOURCE } : undefined;
}

/**
 * Loads the env file (see `envFileFor`) into the environment, with Node's own loader: its
 * KEY=VALUE lines are there before anything reads a key or a setting, and a variable that is set
 * already wins. The file holds API keys, so a mode that lets other users read or change it gets a
 * warning, as do variables that Node reads only when it starts. A file that is named or found but
 * can't be read stops the command.
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {EnvFile | undefined} undefined when there is no env file to load
 */
export function loadEnvFile(flag, env) {
  const found = envFileFor(flag, env);
  if (!found) return undefined;
  const { path, source } = found;
  const before = new Set(Object.keys(process.env));
  let mode = 0;
  try {
    const info = statSync(path);
    if (!info.isFile()) throw new Error('not a file');
    mode = info.mode;
    accessSync(path, constants.R_OK); // process.loadEnvFile reports a file it may not read as missing
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

/**
 * The env file `setup` saves keys in: the one JEV_ROUTER_ENV_FILE names, else the standard file.
 * @param {NodeJS.ProcessEnv} env
 */
export function envFilePath(env) {
  const named = envValue(env, 'JEV_ROUTER_ENV_FILE');
  return named === undefined ? standardEnvFile(env) : expandHome(named);
}

/**
 * The variables an env file sets, read the way Node's loader reads them; none for a file that doesn't exist yet.
 * @param {string} path
 * @returns {{ text: string, values: Record<string, string> }}
 */
export function readEnvFile(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw new Error(`Cannot read env file ${path}: ${fileProblem(err)}`);
  }
  return { text, values: /** @type {Record<string, string>} */ (parseEnv(text)) };
}

/** What a new env file starts with. */
const NEW_FILE = `# jev-router's keys and settings, one KEY=value per line. jev-router loads this file when it
# starts. Keep it private (chmod 600). jev-router setup changes only the lines of the keys it asks for.
`;

/**
 * Sets variables in an env file and writes it in one step with mode 0600: the first definition of a
 * variable is replaced in place, later ones are dropped, and a new variable goes at the end. Every
 * other line, comments included, stays as it is.
 * @param {string} path
 * @param {Record<string, string>} values
 */
export function saveEnvValues(path, values) {
  const { text } = readEnvFile(path);
  writeFileAtomic(path, setEnvValues(text || NEW_FILE, values), 0o600);
}

/**
 * An env file's text with `values` set in it (see `saveEnvValues`).
 * @param {string} text
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function setEnvValues(text, values) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop(); // the text ended with a line break
  const defined = definitions(lines);
  /** @type {Map<number, string | null>} line number to its new text; null drops the line */
  const edits = new Map();
  /** @type {string[]} */
  const added = [];
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${quoteEnvValue(value)}`;
    const found = defined.filter((entry) => entry.key === key);
    if (!found.length) added.push(line);
    for (const [n, { start, end, prefix }] of found.entries())
      for (let i = start; i < end; i += 1)
        edits.set(i, n === 0 && i === start ? `${prefix}${line}${lines[i].endsWith('\r') ? '\r' : ''}` : null);
  }
  const kept = lines.flatMap((line, i) => {
    const edit = edits.get(i);
    return edit === undefined ? [line] : edit === null ? [] : [edit];
  });
  return [...kept, ...added].map((line) => `${line}\n`).join('');
}

/**
 * Where each variable of an env file is defined, lines `start` up to `end`, the way Node's loader
 * reads it: a value in quotes runs to the next of the same quote, over several lines if need be.
 * @param {string[]} lines
 * @returns {Array<{ key: string, start: number, end: number, prefix: string }>}
 */
function definitions(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*(export\s+)?([^=#\s][^=]*?)\s*=\s*(.*)$/.exec(lines[i].replace(/\r$/, ''));
    if (!match) continue; // a comment, a blank line, or a line Node skips
    const last = closingLine(lines, i, match[3]);
    found.push({ key: match[2], start: i, end: last + 1, prefix: match[1] ? 'export ' : '' });
    i = last;
  }
  return found;
}

/**
 * The line a value that starts on line `start` ends on.
 * @param {string[]} lines
 * @param {number} start
 * @param {string} value the rest of the line after `=`
 */
function closingLine(lines, start, value) {
  const quote = value[0];
  if (!(quote === "'" || quote === '"' || quote === '`') || value.indexOf(quote, 1) > 0) return start;
  const close = lines.findIndex((line, i) => i > start && line.includes(quote));
  return close < 0 ? start : close; // an unclosed quote is part of a one-line value
}

/**
 * A value as it goes after `KEY=`: bare when Node's loader reads it back unchanged, else in the
 * first kind of quotes that can hold it. Node cuts a bare value at `#` and trims it, reads `\n` as a
 * line break inside double quotes, and knows no escapes.
 * @param {string} value
 * @returns {string}
 */
export function quoteEnvValue(value) {
  if (value.includes('\r')) throw new Error("an env file can't hold a value with a carriage return");
  if (!/[#\n]/.test(value) && value === value.trim() && !/^['"`]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\n')) return `"${value}"`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new Error("an env file can't hold a value with all three kinds of quotes");
}
