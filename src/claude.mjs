// Claude Code's side of the router: the variables it needs to use the router, and its settings
// file, where the always-on setup keeps them.
import { readFileSync } from 'node:fs';
import { envValue } from './files.mjs';
import { isLoopback, parsePort, TOKEN_HEADER } from './net.mjs';

/** @import { Config } from './types.js' */

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
function withoutHeader(existing, name) {
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
 * @param {Config} cfg
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
