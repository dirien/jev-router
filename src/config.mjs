// Loads the router config and checks it before the first request, so a typo stops the router at
// startup instead of quietly turning off a guard or rerouting traffic. Every problem is reported at once.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const AUTH = new Set(['x-api-key', 'bearer']);
const MODES = new Set(['ratchet', 'sticky']);

export function loadConfig(path) {
  let cfg;
  try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch (err) { throw new Error(`Cannot read config ${path}: ${err.message}`); }
  return validateConfig(cfg);
}

// Returns the config with defaults filled in, or throws with the full list of problems.
export function validateConfig(input) {
  const cfg = structuredClone(input);
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  const isProbability = (v) => typeof v === 'number' && v >= 0 && v <= 1;

  cfg.host ??= '127.0.0.1';
  cfg.port ??= 4000;
  cfg.allowedHosts ??= [];
  cfg.maxBodyBytes ??= 32 * 1024 * 1024;
  cfg.maxSessions ??= 10000;
  cfg.sideCallModel ??= 'haiku';
  cfg.pinOnModelChange ??= true;
  if (cfg.stateFile === undefined) cfg.stateFile = `${homedir()}/.local/state/jev-router/sessions.jsonl`;
  if (typeof cfg.stateFile === 'string') cfg.stateFile = cfg.stateFile.replace(/^~(?=\/)/, homedir());
  if (typeof cfg.logFile === 'string') cfg.logFile = cfg.logFile.replace(/^~(?=\/)/, homedir());
  need(Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536, 'port must be an integer between 1 and 65535');
  need(Array.isArray(cfg.allowedHosts), 'allowedHosts must be an array of host[:port] strings');

  need(Array.isArray(cfg.tiers) && cfg.tiers.length > 0 && cfg.tiers.every((t) => typeof t === 'string'), 'tiers must list tier names, cheapest first');
  const tiers = new Set(cfg.tiers ?? []);
  need(tiers.has(cfg.defaultTier), `defaultTier "${cfg.defaultTier}" is not one of tiers`);

  cfg.policy = { mode: 'ratchet', sensitiveOverride: 0.7, claimGuard: 0.5, maxProvisional: 3, idleResetMinutes: 10, failClosed: false, ...cfg.policy };
  const policy = cfg.policy;
  need(MODES.has(policy.mode), 'policy.mode must be "ratchet" or "sticky"');
  policy.accept = { ...Object.fromEntries([...tiers].map((t) => [t, 0.6])), ...policy.accept };
  for (const [tier, p] of Object.entries(policy.accept)) {
    need(tiers.has(tier), `policy.accept names unknown tier "${tier}"`);
    need(isProbability(p), `policy.accept.${tier} must be a probability`);
  }
  for (const key of ['sensitiveOverride', 'claimGuard']) need(isProbability(policy[key]), `policy.${key} must be a probability`);

  const jev = cfg.jev = { deadlineMs: 2500, requestChars: 4000, stripCode: true, guards: true, channels: [], ...cfg.jev };
  need(Array.isArray(jev.channels), 'jev.channels must be an array');
  for (const [i, ch] of (jev.channels ?? []).entries()) {
    ch.timeoutMs ??= 1200;
    need(typeof ch.name === 'string' && ch.name, `jev.channels[${i}].name is required`);
    need(isUrl(ch.baseUrl), `jev.channels[${i}].baseUrl must be an http(s) URL`);
    need(typeof ch.model === 'string' && ch.model, `jev.channels[${i}].model is required`);
    need(typeof ch.keyEnv === 'string' && ch.keyEnv, `jev.channels[${i}].keyEnv is required`);
  }
  need(typeof jev.question === 'string' && jev.question.length > 0, 'jev.question is required');
  need(jev.options && typeof jev.options === 'object' && Object.keys(jev.options).length >= 2, 'jev.options needs at least two options');
  for (const [name, option] of Object.entries(jev.options ?? {})) {
    need(tiers.has(option?.tier), `jev.options.${name}.tier must be one of tiers`);
  }

  need(cfg.surfaces && typeof cfg.surfaces === 'object', 'surfaces is required');
  for (const [surface, targets] of Object.entries(cfg.surfaces ?? {})) {
    for (const tier of tiers) need(targets[tier], `surfaces.${surface} has no target for tier "${tier}"`);
    const untrusted = [...tiers].some((t) => targets[t] && !targets[t].trusted);
    need(!untrusted || targets.trusted?.trusted, `surfaces.${surface} routes some tiers to untrusted upstreams, so it needs a trusted target marked "trusted": true`);
    for (const [name, target] of Object.entries(targets)) {
      const where = `surfaces.${surface}.${name}`;
      need(isUrl(target.url), `${where}.url must be an http(s) URL`);
      need(typeof target.model === 'string' && target.model, `${where}.model is required`);
      need(AUTH.has(target.auth), `${where}.auth must be "x-api-key" or "bearer"`);
      need(target.keyEnv || target.clientAuth, `${where} needs keyEnv or clientAuth`);
      need(target.omit === undefined || (Array.isArray(target.omit) && target.omit.every((f) => typeof f === 'string')), `${where}.omit must be a list of field paths`);
    }
  }
  cfg.modelPins ??= {};
  for (const [family, tier] of Object.entries(cfg.modelPins)) need(tiers.has(tier), `modelPins.${family} must be one of tiers`);
  cfg.prices ??= {};

  if (problems.length) throw new Error(`Invalid router config:\n  - ${problems.join('\n  - ')}`);
  return cfg;
}

function isUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
