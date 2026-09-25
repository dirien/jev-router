// Claude Code's side of the router: the variables it needs to use the router, and its settings
// file, where the always-on setup keeps them.
import { readFileSync, statSync } from 'node:fs';
import { envValue, errorCode, errorMessage, writeFileAtomic } from './files.mjs';
import { isLoopback, parsePort, TOKEN_HEADER } from './net.mjs';

/** @import { Config } from './types.js' */

/**
 * @typedef {object} SettingsChange
 * @property {string} name
 * @property {string | undefined} before
 * @property {string | undefined} after undefined when the variable was removed
 */
/**
 * @typedef {{ data: Record<string, unknown>, exists: boolean, mode: number }} Settings
 */

// Claude Code can't learn a routed model's context window through a gateway, so it compacts well
// before the smallest window among the tiers.
const COMPACT_WINDOW = '160000';

/**
 * The variables Claude Code needs to use the router. Credentials stay the user's: the router
 * passes Claude Code's own login through to Anthropic, so ANTHROPIC_API_KEY is never set here.
 * @param {NodeJS.ProcessEnv} env what is set already: the shell, or the `env` block of a settings file
 * @param {string} url
 * @param {string | undefined} token
 * @returns {Record<string, string>}
 */
export function claudeVars(env, url, token) {
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
  return [...withoutHeader(existing, name), `${name}: ${value}`].join('\n');
}

/**
 * The lines of a header list without the ones for `name`.
 * @param {string | undefined} existing
 * @param {string} name lower case
 * @returns {string[]}
 */
export function withoutHeader(existing, name) {
  return (existing ?? '').split(/\r?\n/).filter((line) => line.trim() && line.split(':', 1)[0].trim().toLowerCase() !== name);
}

/**
 * What Claude Code needs besides ANTHROPIC_BASE_URL to work well behind the router: the value
 * `launch` and `env` set, and why.
 * @type {Record<string, [value: string, why: string]>}
 */
export const CLAUDE_SETTINGS = {
  CLAUDE_CODE_GATEWAY_HINT_HEADERS: ['1', "the router can't tell background calls and subagents from your own messages"],
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: [COMPACT_WINDOW, "Claude Code can't learn a routed model's context window through a gateway"],
  ENABLE_TOOL_SEARCH: [
    'true',
    'behind a gateway Claude Code turns MCP tool search off and sends every MCP tool definition with every request',
  ],
};

/**
 * The `env` block of Claude Code's settings file, where the always-on setup puts its variables.
 * @param {string} file
 * @returns {Record<string, string>}
 */
export function settingsEnv(file) {
  try {
    const block = JSON.parse(readFileSync(file, 'utf8'))?.env;
    return block && typeof block === 'object'
      ? Object.fromEntries(Object.entries(block).filter(([, v]) => typeof v === 'string' && v))
      : {};
  } catch {
    return {}; // no settings file, or one this check can't read
  }
}

/**
 * Whether a base URL reaches the router that the config and JEV_ROUTER_* describe.
 * @param {string} base
 * @param {Pick<Config, 'host' | 'port'>} cfg
 * @param {NodeJS.ProcessEnv} env
 */
export function pointsAtRouter(base, cfg, env) {
  try {
    const url = new URL(base);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const router = envValue(env, 'JEV_ROUTER_HOST') ?? cfg.host;
    return port === parsePort(envValue(env, 'JEV_ROUTER_PORT') ?? cfg.port) && (isLoopback(host) || host === router);
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads Claude Code's settings file to change it. A file that doesn't exist is an empty one.
 * @param {string} file
 * @returns {Settings | { problem: string }} the parsed file, or why it can't be changed safely
 */
export function readSettings(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return errorCode(err) === 'ENOENT' ? { data: {}, exists: false, mode: 0o600 } : { problem: errorMessage(err) };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { problem: `it isn't valid JSON (${errorMessage(err)})` };
  }
  if (!isObject(data)) return { problem: "it isn't a JSON object" };
  if (data.env !== undefined && !isObject(data.env)) return { problem: 'its "env" isn\'t an object' };
  return { data, exists: true, mode: statSync(file).mode & 0o777 };
}

/**
 * The string variables in a settings file's `env` block.
 * @param {Record<string, unknown>} data
 * @returns {Record<string, string>}
 */
export function settingsBlock(data) {
  const block = isObject(data.env) ? data.env : {};
  return Object.fromEntries(Object.entries(block).flatMap(([name, value]) => (typeof value === 'string' ? [[name, value]] : [])));
}

/**
 * Sets and removes variables in a settings file's `env` block, in place. The keys keep their order;
 * a new key goes at the end, and so does a new block.
 * @param {Record<string, unknown>} data
 * @param {Record<string, string | undefined>} values undefined removes the variable
 * @returns {SettingsChange[]} what changed
 */
export function changeSettingsEnv(data, values) {
  const block = isObject(data.env) ? data.env : {};
  /** @type {SettingsChange[]} */
  const changes = [];
  for (const [name, after] of Object.entries(values)) {
    const current = block[name];
    const before = typeof current === 'string' ? current : undefined;
    if (after === current || (after === undefined && current === undefined)) continue;
    if (after === undefined) delete block[name];
    else block[name] = after;
    changes.push({ name, before, after });
  }
  if (changes.length && !isObject(data.env)) data.env = block;
  if (changes.length && !Object.keys(block).length) delete data.env; // emptied by removals
  return changes;
}

/**
 * Writes Claude Code's settings: 2-space JSON and a trailing newline, in one step, with the mode the
 * file had. An existing file is copied to `backup` first.
 * @param {string} file
 * @param {Settings} settings
 * @param {string} backup
 */
export function writeSettings(file, { data, exists, mode }, backup) {
  if (exists) writeFileAtomic(backup, readFileSync(file, 'utf8'), mode);
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, mode);
}
