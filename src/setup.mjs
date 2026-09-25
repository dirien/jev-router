// `jev-router setup` gets a plain Mac or Linux machine routing. It asks which models Claude Code
// uses and for the keys they need, checks the Jev key with one call, and only then writes: the
// config, the env file, a launchd or systemd service, and, once the router answers, Claude Code's
// settings. It is safe to run again. `jev-router uninstall` undoes it from the manifest it keeps.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CLAUDE_SETTINGS,
  changeSettingsEnv,
  claudeVars,
  pointsAtRouter,
  readSettings,
  settingsBlock,
  withoutHeader,
  writeSettings,
} from './claude.mjs';
import { loadConfig } from './config.mjs';
import { envFilePath, loadEnvFile, looseFile, readEnvFile, saveEnvValues } from './envfile.mjs';
import {
  ANTHROPIC_ONLY_CONFIG,
  claudeSettingsPath,
  configFile,
  DEFAULT_CONFIG,
  envValue,
  errorMessage,
  namedLogFile,
  packaged,
  routerLogPath,
  setupManifestPath,
  shellQuote,
  userConfigPath,
  writeFileAtomic,
} from './files.mjs';
import {
  commandVersion,
  globalCommand,
  installedCommand,
  LEGACY_PACKAGE,
  legacyInstall,
  npmInstall,
  origin,
  PACKAGE,
  sameFile,
} from './install.mjs';
import { JevClient, SAMPLE_STATE } from './jev.mjs';
import { clientHost, isLoopback, parsePort, parseUiAddress, portProblem, probe, TOKEN_HEADER, UI_PORT } from './net.mjs';
import { PromptAbort, Prompter } from './prompt.mjs';
import { VERSION } from './router.mjs';
import {
  chooseManager,
  installedServices,
  launchdErrorLog,
  logHint,
  MANAGER_NAMES,
  renderService,
  serviceFile,
  startService,
  stopService,
} from './service.mjs';

/** @import { Config, JevChannel } from './types.js' */
/** @import { SettingsChange } from './claude.mjs' */
/** @import { Origin } from './install.mjs' */
/** @import { Manager } from './service.mjs' */

/**
 * @typedef {object} SetupOptions
 * @property {boolean} yes answer every question with its default, and take the keys from the environment
 * @property {'auto' | Manager | 'none'} service
 * @property {boolean} claudeSettings whether to point Claude Code's settings at the router
 * @property {'claude' | 'ollama'} [models] the config for a machine that has none yet
 */

/**
 * @typedef {object} Manifest what setup changed, for uninstall; it holds no secrets
 * @property {{ manager: Manager, file: string }} [service]
 * @property {{ config: string, env: string, log: string }} [files]
 * @property {{ file: string, created?: boolean, env: Record<string, { value: string, previous?: string }>, tokenHeader?: 'created' | 'added' }} [claude]
 *   `created`: setup made the settings file, so uninstall may remove it once it's empty again
 */

/** @type {Record<'claude' | 'ollama', { file: string, what: string }>} */
const MODELS = {
  claude: { file: ANTHROPIC_ONLY_CONFIG, what: 'Claude only: Haiku 4.5, Sonnet 5 and Opus 5.5' },
  ollama: { file: DEFAULT_CONFIG, what: "Ollama Cloud's glm-5.3-flash for quick work, and Claude for the rest" },
};
/** @type {Record<string, string>} */
const KEY_NAMES = { TYPESAFE_API_KEY: 'TypeSafe', OPENROUTER_API_KEY: 'OpenRouter', OLLAMA_API_KEY: 'Ollama', OPENAI_API_KEY: 'OpenAI' };
/** @type {Record<string, string>} */
const KEY_PLACES = { TYPESAFE_API_KEY: 'console.typesafe.ai', OPENROUTER_API_KEY: 'openrouter.ai', OLLAMA_API_KEY: 'ollama.com' };
/** How long setup waits for the service's router, in seconds; JEV_ROUTER_SETUP_WAIT changes it. */
const WAIT_SECONDS = 15;

/** @param {string} text */
const say = (text) => process.stderr.write(text);
/** @param {string} name */
const keyName = (name) => KEY_NAMES[name] ?? name;
/**
 * @param {string[]} items
 * @param {string} [last] the word before the last item
 */
const inWords = (items, last = 'and') => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}`);
/** @param {string[]} items */
const orWords = (items) => inWords(items, 'or');

/**
 * @typedef {object} Plan everything setup asked and found, before it writes anything
 * @property {Config} cfg
 * @property {string} configPath
 * @property {string} [configFrom] the packaged config to copy, for a machine without one
 * @property {string} envFile
 * @property {Record<string, string>} saved the variables the env file sets now
 * @property {Record<string, string>} keys the keys to save
 * @property {string} host
 * @property {number} port
 * @property {string} url
 * @property {string} ui the live view's address, as `--ui` takes it
 * @property {string | undefined} token the router token the service will have
 * @property {string} logFile
 * @property {Origin} origin
 * @property {string} [installed] the global jev-router on PATH, outside npx's cache
 * @property {ServicePlan} service
 */
/**
 * @typedef {object} ServicePlan
 * @property {Manager} [manager] unset when there is no service
 * @property {string} why why there is none
 * @property {string} [file]
 * @property {{ problem: string, version?: string }} [busy] something else holds the router's port
 * @property {string} [install] the spec to install globally first
 * @property {string} [command] the global jev-router the service runs
 * @property {{ replaceForeign: boolean } | { skip: string }} [settings] `skip` says why they stay as they are
 */
/** @typedef {{ path: string, onPath: boolean }} Command a global jev-router, and whether it's on PATH */

/**
 * `jev-router setup`: asks, checks the Jev key, then writes. Returns the exit code.
 * @param {SetupOptions} options
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
export async function runSetup(options, env) {
  const prompter = options.yes ? undefined : new Prompter(process.stdin, process.stderr);
  const stop = new AbortController();
  const interrupt = () => {
    prompter?.interrupt();
    stop.abort();
  };
  process.on('SIGINT', interrupt);
  let plan;
  try {
    say(`jev-router ${VERSION} setup\n\n`);
    plan = await ask(options, env, prompter, stop.signal);
  } catch (err) {
    if (!(err instanceof PromptAbort)) throw err;
    say(
      err.exitCode === 130
        ? '\nStopped. Nothing was written.\n'
        : `\nSetup needs answers, but ${err.message}. Nothing was written. Run it in a terminal, or pass --yes with the keys in the environment.\n`,
    );
    return err.exitCode;
  } finally {
    process.off('SIGINT', interrupt);
    prompter?.close();
  }
  return plan ? carryOut(plan, env) : 1;
}

/**
 * Everything that needs an answer, in order: the models, the keys and their check, the service,
 * a global install, and a base URL Claude Code has already. Nothing is written here.
 * @param {SetupOptions} options
 * @param {NodeJS.ProcessEnv} env
 * @param {Prompter | undefined} prompter undefined with --yes
 * @param {AbortSignal} signal
 * @returns {Promise<Plan | undefined>} undefined when the Jev key didn't work under --yes
 */
async function ask(options, env, prompter, signal) {
  const envFile = envFilePath(env);
  if (existsSync(envFile)) for (const warning of loadEnvFile(undefined, env)?.warnings ?? []) say(`note: ${warning}\n`);
  const { values: saved } = readEnvFile(envFile);
  const manager = chooseManager(options.service, env);
  if (!manager.manager && options.service !== 'auto' && options.service !== 'none')
    throw new Error(`--service ${options.service}: ${manager.why}`);
  const { cfg, configPath, configFrom } = await chooseConfig(options, env, prompter);
  const plan = routerPlan(cfg, env, saved);
  const keys = await collectKeys({ cfg, env, saved, envFile, prompter, signal });
  if (!keys) return undefined;
  /** @type {Plan} */
  const full = { ...plan, cfg, configPath, configFrom, envFile, saved, keys, origin: origin(VERSION), service: manager };
  full.installed = installedCommand(env);
  if (manager.manager) full.service = await planService(full, manager.manager, options, env, prompter);
  return full;
}

/**
 * The config to use: an existing one as it is, else the packaged one for the models the person picks.
 * @param {SetupOptions} options
 * @param {NodeJS.ProcessEnv} env
 * @param {Prompter | undefined} prompter
 * @returns {Promise<{ cfg: Config, configPath: string, configFrom?: string }>}
 */
async function chooseConfig(options, env, prompter) {
  const found = configFile(undefined, env);
  if (found.source !== 'packaged default') {
    const note = options.models ? '; --models applies only to a machine without one' : '';
    say(`Config: ${found.path} (${found.source}), kept as it is${note}.\n\n`);
    return { cfg: loadConfig(found.path), configPath: found.path };
  }
  const models = options.models ?? (prompter ? await askModels(prompter) : 'claude');
  if (!prompter) say(`Models: ${MODELS[models].what}.\n\n`);
  return { cfg: loadConfig(MODELS[models].file), configPath: userConfigPath(env), configFrom: MODELS[models].file };
}

/**
 * @param {Prompter} prompter
 * @returns {Promise<'claude' | 'ollama'>}
 */
async function askModels(prompter) {
  prompter.say(
    'Which models should Claude Code use?\n' +
      `  1. ${MODELS.claude.what}. You need a Jev key.\n` +
      `  2. ${MODELS.ollama.what}. You need a Jev key and an Ollama key.\n`,
  );
  for (;;) {
    const answer = await prompter.ask('Choose 1 or 2 [1]: ');
    if (answer === '' || answer === '1') return 'claude';
    if (answer === '2') return 'ollama';
    prompter.say('Please answer 1 or 2.\n');
  }
}

/**
 * Where the service's router will listen, and what else it will see: the config, overridden by
 * JEV_ROUTER_HOST and JEV_ROUTER_PORT from here, which the service gets as flags; the router token
 * from the env file or the config, the only places a service reads it from.
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, string>} saved
 */
function routerPlan(cfg, env, saved) {
  const host = envValue(env, 'JEV_ROUTER_HOST') ?? cfg.host;
  const port = parsePort(envValue(env, 'JEV_ROUTER_PORT') ?? cfg.port);
  if (port === 0) throw new Error('setup needs the port the router listens on, not 0 (JEV_ROUTER_PORT)');
  const ui = envValue(env, 'JEV_ROUTER_UI') ?? String(UI_PORT);
  parseUiAddress(ui); // stops here on a bad value
  const token = (Object.hasOwn(saved, 'JEV_ROUTER_TOKEN') ? saved.JEV_ROUTER_TOKEN : cfg.token) || undefined;
  const logFile = namedLogFile(undefined, env) ?? routerLogPath(env);
  return { host, port, url: `http://${clientHost(host)}:${port}`, ui, token, logFile };
}

/**
 * @typedef {object} KeyContext
 * @property {Config} cfg
 * @property {NodeJS.ProcessEnv} env
 * @property {Record<string, string>} saved
 * @property {string} envFile
 * @property {Prompter | undefined} prompter
 * @property {AbortSignal} signal
 */

/**
 * The keys to save: a Jev key that works, and the keys Claude Code's other tiers need.
 * @param {KeyContext} context
 * @returns {Promise<Record<string, string> | undefined>} the variables whose value changes; undefined when the Jev key failed under --yes
 */
async function collectKeys(context) {
  const { cfg, env, saved } = context;
  if (!cfg.jev.channels.length) throw new Error('the config has no Jev channels (jev.channels), so setup has no key to ask for');
  const others = upstreamKeys(cfg, 'anthropic');
  if (!context.prompter) {
    const missing = [...others].filter(([name]) => !env[name]).map(([name, tiers]) => `${name} for Claude Code's ${inWords(tiers)} tier`);
    if (!cfg.jev.channels.some((ch) => env[ch.keyEnv])) missing.unshift(`${orWords(cfg.jev.channels.map((ch) => ch.keyEnv))} for Jev`);
    if (missing.length) throw new Error(`setup --yes takes the keys from the environment. Set ${inWords(missing)}.`);
  }
  const jev = await workingJevKey(context);
  if (!jev) return undefined;
  /** @type {Record<string, string>} */
  const keys = { [jev.channel.keyEnv]: jev.value };
  for (const [name, tiers] of others) keys[name] = await upstreamKey(context, name, tiers);
  return Object.fromEntries(Object.entries(keys).filter(([name, value]) => saved[name] !== value));
}

/**
 * The key variables of a surface's targets that don't pass the client's login through, each with the tiers that use it.
 * @param {Config} cfg
 * @param {'anthropic' | 'openai'} surface
 * @returns {Map<string, string[]>}
 */
function upstreamKeys(cfg, surface) {
  /** @type {Map<string, string[]>} */
  const keys = new Map();
  for (const [tier, target] of Object.entries(cfg.surfaces[surface] ?? {})) {
    if (target.clientAuth || !target.keyEnv || tier === 'side') continue;
    keys.set(target.keyEnv, [...(keys.get(target.keyEnv) ?? []), tier]);
  }
  return keys;
}

/**
 * A key's value now, and where it comes from: the env file, or this shell.
 * @param {KeyContext} context
 * @param {string} name
 * @returns {{ value: string, where: string } | undefined}
 */
function currentKey({ env, saved }, name) {
  const value = env[name];
  if (!value) return undefined;
  return { value, where: saved[name] === value ? 'saved' : 'set in this shell' };
}

/**
 * Asks for a Jev key, or takes it from the environment, and checks it with one Jev call until one works.
 * @param {KeyContext} context
 * @returns {Promise<{ channel: JevChannel, value: string } | undefined>}
 */
async function workingJevKey(context) {
  const { cfg, prompter, signal } = context;
  const places = cfg.jev.channels.map((ch) => `${keyName(ch.keyEnv)}${KEY_PLACES[ch.keyEnv] ? ` (${KEY_PLACES[ch.keyEnv]})` : ''}`);
  say(`Jev decides which model each message needs. It takes a key from ${orWords(places)}; one is enough.\n`);
  for (let retry = false; ; retry = true) {
    const jev = prompter ? await askJevKey(context, prompter, retry) : jevKeyFromEnv(context);
    say(`Checking the ${keyName(jev.channel.keyEnv)} key with one Jev call (about $0.00003)... `);
    const client = new JevClient(
      { ...cfg.jev, deadlineMs: 15000, channels: [{ ...jev.channel, timeoutMs: 10000 }] },
      { [jev.channel.keyEnv]: jev.value },
    );
    const answer = await client.decide(SAMPLE_STATE, { signal });
    if (signal.aborted) throw new PromptAbort('interrupted', 130);
    if (answer.ok) {
      say(`it works (${answer.channel} answered in ${answer.ms} ms).\n\n`);
      return jev;
    }
    say(`it didn't work: ${answer.error}\n`);
    if (!prompter) {
      say('Nothing was written. Check the key, then run setup again.\n');
      return undefined;
    }
    if (!(await prompter.confirm('Try another key?', true))) throw new PromptAbort('no Jev key worked', 1);
  }
}

/**
 * @param {KeyContext} context
 * @returns {{ channel: JevChannel, value: string }}
 */
function jevKeyFromEnv({ cfg, env }) {
  const channel = /** @type {JevChannel} */ (cfg.jev.channels.find((ch) => env[ch.keyEnv]));
  return { channel, value: /** @type {string} */ (env[channel.keyEnv]) };
}

/**
 * Asks for a Jev key: Enter keeps one that is saved or set, else moves on to the next channel.
 * After a key failed, keeping it isn't offered.
 * @param {KeyContext} context
 * @param {Prompter} prompter
 * @param {boolean} retry
 * @returns {Promise<{ channel: JevChannel, value: string }>}
 */
async function askJevKey(context, prompter, retry) {
  const channels = context.cfg.jev.channels;
  const existing = retry ? undefined : channels.find((ch) => currentKey(context, ch.keyEnv));
  if (existing) {
    const current = /** @type {{ value: string, where: string }} */ (currentKey(context, existing.keyEnv));
    const value = await prompter.secret(`${keyName(existing.keyEnv)} API key [${current.where}; press Enter to keep it]: `);
    return { channel: existing, value: value || current.value };
  }
  for (let i = 0; ; i = (i + 1) % channels.length) {
    const next = channels[(i + 1) % channels.length];
    const instead =
      channels.length > 1
        ? ` (press Enter to use a${/^[AEIOU]/.test(keyName(next.keyEnv)) ? 'n' : ''} ${keyName(next.keyEnv)} key instead)`
        : '';
    const value = await prompter.secret(`${keyName(channels[i].keyEnv)} API key${instead}: `);
    if (value) return { channel: channels[i], value };
    if (channels.length === 1) prompter.say('Jev needs a key to pick the models.\n');
  }
}

/**
 * Asks for the key of one of Claude Code's tiers (Ollama's for the fast tier, say), or takes it from the environment.
 * @param {KeyContext} context
 * @param {string} name
 * @param {string[]} tiers
 * @returns {Promise<string>}
 */
async function upstreamKey(context, name, tiers) {
  const current = currentKey(context, name);
  const { prompter } = context;
  if (!prompter) return /** @type {string} */ (context.env[name]);
  const what = `${keyName(name)} API key${KEY_PLACES[name] ? ` (${KEY_PLACES[name]})` : ''} for Claude Code's ${inWords(tiers)} tier${tiers.length > 1 ? 's' : ''}`;
  for (;;) {
    const value = await prompter.secret(current ? `${what} [${current.where}; press Enter to keep it]: ` : `${what}: `);
    if (value || current) return value || /** @type {{ value: string }} */ (current).value;
    prompter.say(`That tier needs ${name}.\n`);
  }
}

/**
 * The service part of the plan: whether to have one, whether the port is free for it, which
 * jev-router it runs (installing one for good when this copy runs from npx), and whether Claude
 * Code's settings may point at it.
 * @param {Plan} plan
 * @param {Manager} manager
 * @param {SetupOptions} options
 * @param {NodeJS.ProcessEnv} env
 * @param {Prompter | undefined} prompter
 * @returns {Promise<ServicePlan>}
 */
async function planService(plan, manager, options, env, prompter) {
  const question = options.claudeSettings
    ? 'Start jev-router in the background when you log in, and send every Claude Code session through it?'
    : 'Start jev-router in the background when you log in?';
  if (prompter && !(await prompter.confirm(question, true))) return { why: 'you chose to start it yourself' };
  const file = serviceFile(manager, env);
  const busy = existsSync(file) ? undefined : await portProblem(plan.host, plan.port);
  if (busy) return { manager, why: '', file, busy: { problem: busy, version: (await probe(plan.url)).health?.version } };
  const runs = await chooseCommand(plan, env, prompter);
  if ('none' in runs) return { why: runs.none };
  return {
    manager,
    why: '',
    file,
    ...runs,
    settings: options.claudeSettings
      ? await planSettings(plan, env, prompter)
      : { skip: "Claude Code's settings are unchanged (--no-claude-settings)." },
  };
}

/**
 * The jev-router the service runs: the global one, or one npm installs first when none is on PATH,
 * or when this copy runs from npx's cache (which npm can delete at any time) and the global one, if
 * any, is another version.
 * @param {Plan} plan
 * @param {NodeJS.ProcessEnv} env
 * @param {Prompter | undefined} prompter
 * @returns {Promise<{ install: string } | { command: string } | { none: string }>}
 */
async function chooseCommand(plan, env, prompter) {
  const { installed } = plan;
  if (installed && (!plan.origin.npx || commandVersion(installed, env) === VERSION)) {
    if (!sameFile(installed, packaged('bin/jev-router.mjs')))
      say(`note: the service runs the jev-router on your PATH, ${installed}, not the copy that runs setup.\n`);
    return { command: installed };
  }
  say(
    plan.origin.npx
      ? 'The background service needs a copy of jev-router that stays put, and npm can delete its npx cache at any time.\n'
      : "The background service needs jev-router installed, and there's none on your PATH.\n",
  );
  const install = `npm install -g ${shellQuote(plan.origin.spec)}`;
  if (!prompter || (await prompter.confirm(`Install it now with: ${install}?`, true))) return { install: plan.origin.spec };
  if (installed) return { command: installed };
  return { none: `the service needs an installed jev-router, and you chose not to install one (${install})` };
}

/**
 * Whether setup may point Claude Code's settings at the router. A base URL that goes somewhere
 * else, such as a company gateway, is replaced only on a yes; --yes keeps it.
 * @param {Plan} plan
 * @param {NodeJS.ProcessEnv} env
 * @param {Prompter | undefined} prompter
 * @returns {Promise<{ replaceForeign: boolean } | { skip: string }>}
 */
async function planSettings(plan, env, prompter) {
  const file = claudeSettingsPath(env);
  const read = readSettings(file);
  const base = 'problem' in read ? undefined : settingsBlock(read.data).ANTHROPIC_BASE_URL;
  if (!base || base === plan.url || pointsAtRouter(base, plan, {})) return { replaceForeign: false };
  say(`Claude Code's settings (${file}) send it to ${base}.\n`);
  if (!prompter) say('--yes keeps that. To send Claude Code through the router instead, run setup without --yes and answer yes.\n');
  if (prompter && (await prompter.confirm('Replace that with the router?', false))) return { replaceForeign: true };
  return { skip: `Claude Code's settings are unchanged: they keep sending it to ${base}.` };
}

/**
 * Writes what the plan says, starts the service, and points Claude Code at it once it answers.
 * @param {Plan} plan
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
async function carryOut(plan, env) {
  say('\n');
  writeFiles(plan);
  const { service } = plan;
  if (!service.manager) return finishWithoutService(plan, env);
  if (service.busy) return portBusy(plan, service.busy);
  if (!isLoopback(plan.host) && !plan.token) {
    say(
      `jev-router: the router won't listen on ${plan.host} without a token. Put JEV_ROUTER_TOKEN=<a secret> in ${plan.envFile}, then run setup again.\n`,
    );
    return 1;
  }
  const command = await serviceCommand(plan, env);
  if (!command) return 1;
  if (envValue(env, 'JEV_ROUTER_TOKEN') && env.JEV_ROUTER_TOKEN !== plan.token)
    say(`note: JEV_ROUTER_TOKEN is set in this shell, but the service can't see it. Put it in ${plan.envFile} to use it.\n`);
  const file = /** @type {string} */ (service.file);
  if (!(await runService(plan, service.manager, file, command.path, env))) return 1;
  /** @type {Manifest} */
  const manifest = {
    service: { manager: service.manager, file },
    files: { config: plan.configPath, env: plan.envFile, log: plan.logFile },
    claude: readManifest(env)?.claude,
  };
  const settings =
    service.settings && 'skip' in service.settings ? { text: service.settings.skip, pointed: false } : pointClaude(plan, manifest, env);
  writeManifest(env, manifest);
  finishWithService(plan, command, settings);
  return 0;
}

/**
 * Writes the config for a machine that has none, and the keys that changed.
 * @param {Plan} plan
 */
function writeFiles(plan) {
  if (plan.configFrom) {
    writeFileAtomic(plan.configPath, readFileSync(plan.configFrom, 'utf8'), 0o600);
    say(`Wrote ${plan.configPath} (${plan.configFrom === ANTHROPIC_ONLY_CONFIG ? MODELS.claude.what : MODELS.ollama.what}).\n`);
  } else say(`Kept ${plan.configPath}.\n`);
  const names = Object.keys(plan.keys);
  const loose = existsSync(plan.envFile) && looseFile(plan.envFile, statSync(plan.envFile).mode);
  if (names.length || loose) saveEnvValues(plan.envFile, plan.keys); // the rewrite leaves it at mode 0600
  if (names.length) say(`Saved ${inWords(names)} in ${plan.envFile}, readable only by you.\n`);
  else say(`Kept the keys in ${plan.envFile}${loose ? ', and made it readable only by you' : ''}.\n`);
}

/**
 * Stops before the service, when something else holds the router's port.
 * @param {Plan} plan
 * @param {{ problem: string, version?: string }} busy
 */
function portBusy(plan, { problem, version }) {
  const what = version
    ? `A jev-router ${version} already answers at ${plan.url}, probably one you started yourself with jev-router serve or launch`
    : `Something else holds ${plan.url} (${problem})`;
  say(
    `\n${what}. The service would fail to start next to it.\n` +
      'Stop it, then run setup again. Your config and keys are saved, and Enter keeps them.\n' +
      `To use another port instead, run setup with JEV_ROUTER_PORT set, for example JEV_ROUTER_PORT=${plan.port + 1}.\n`,
  );
  return 1;
}

/**
 * The global jev-router the service runs, installing it first when the plan says so.
 * @param {Plan} plan
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Command | undefined>} undefined when there is none, after saying why
 */
async function serviceCommand(plan, env) {
  const { install, command } = plan.service;
  if (command) return { path: command, onPath: true };
  say(`\nInstalling jev-router for good: npm install -g ${shellQuote(/** @type {string} */ (install))}\n`);
  const result = await npmInstall(/** @type {string} */ (install), env);
  const found = result.ok ? globalCommand(env) : undefined;
  if (found) {
    if (!found.onPath)
      say(`note: npm put jev-router in ${dirname(found.path)}, which isn't on your PATH. Add it to PATH to run jev-router yourself.\n`);
    return found;
  }
  say(
    `\n${result.ok ? "npm installed jev-router, but setup can't find it: check npm prefix -g" : `The install failed: ${result.why}`}. The service isn't installed, and Claude Code's settings are unchanged.\n`,
  );
  if (!result.ok && legacyInstall(env))
    say(
      `jev-router 1.4.0 and older were called ${LEGACY_PACKAGE}, and npm won't replace their command. Remove it first:\n  npm uninstall -g ${LEGACY_PACKAGE}\n`,
    );
  else
    say(
      'If npm may not write to its global directory, use Node from a version manager (nvm, fnm, or Homebrew on a Mac), ' +
        'or give npm a directory of your own with npm config set prefix ~/.local and put ~/.local/bin on PATH, ' +
        `or install it with sudo: sudo npm install -g ${shellQuote(/** @type {string} */ (install))}\n`,
    );
  say(`Your keys and config are saved: run setup again (${commandForm(plan)} setup) and it picks up from here.\n`);
  return undefined;
}

/**
 * Writes the service file, (re)starts the service, and waits until its router answers.
 * @param {Plan} plan
 * @param {Manager} manager
 * @param {string} file
 * @param {string} command the global jev-router
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<boolean>}
 */
async function runService(plan, manager, file, command, env) {
  const path = [...new Set([dirname(command), dirname(process.execPath), '/usr/bin', '/bin'])].join(':');
  const args = [
    '/usr/bin/env',
    'jev-router',
    'serve',
    '--ui',
    plan.ui,
    '--config',
    plan.configPath,
    '--env-file',
    plan.envFile,
    '--log-file',
    plan.logFile,
  ];
  if (envValue(env, 'JEV_ROUTER_HOST')) args.push('--host', plan.host);
  if (envValue(env, 'JEV_ROUTER_PORT')) args.push('--port', String(plan.port));
  if (manager === 'launchd') mkdirSync(dirname(launchdErrorLog()), { recursive: true, mode: 0o700 });
  const since = Date.now();
  try {
    await startService(manager, file, renderService(manager, { args, path }), env);
  } catch (err) {
    say(`\njev-router: ${errorMessage(err)}\nClaude Code's settings are unchanged.\n`);
    return false;
  }
  say(`Started the ${MANAGER_NAMES[manager]} ${file}.\nWaiting for the router at ${plan.url}... `);
  const waitSeconds = Number(envValue(env, 'JEV_ROUTER_SETUP_WAIT') ?? WAIT_SECONDS);
  if (await answers(plan.url, since, waitSeconds * 1000)) {
    say('it answers.\n');
    return true;
  }
  say(`it didn't answer within ${waitSeconds} s.\nSee what went wrong in: ${logHint(manager)}\nClaude Code's settings are unchanged.\n`);
  return false;
}

/**
 * Waits for a router that started after `since` to answer at `url`. One that has run longer, such
 * as a router started by hand, isn't the service's.
 * @param {string} url
 * @param {number} since
 * @param {number} ms
 */
async function answers(url, since, ms) {
  const deadline = Date.now() + ms;
  do {
    const { health } = await probe(url);
    if (health && health.uptime_s <= (Date.now() - since) / 1000 + 1) return true;
    await sleep(200);
  } while (Date.now() < deadline);
  return false;
}

/**
 * Points Claude Code's settings at the router: the variables `claudeVars` gives, in the `env` block,
 * with a backup of the file first. What changed goes into the manifest.
 * @param {Plan} plan
 * @param {Manifest} manifest changed in place
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ text: string, pointed: boolean }} what happened, and whether Claude Code now uses the router
 */
function pointClaude(plan, manifest, env) {
  const file = claudeSettingsPath(env);
  const read = readSettings(file);
  if ('problem' in read) {
    const vars = claudeVars({}, plan.url, plan.token && '<your JEV_ROUTER_TOKEN>');
    return {
      text: `Setup didn't change ${file}: ${read.problem}. Add this to its "env" block yourself:\n${JSON.stringify(vars, null, 2)}`,
      pointed: false,
    };
  }
  const block = settingsBlock(read.data);
  const changes = changeSettingsEnv(read.data, claudeVars(block, plan.url, plan.token));
  const earlier = manifest.claude?.file === file ? manifest.claude : undefined;
  const created = earlier?.created ?? (!read.exists && changes.length > 0);
  manifest.claude = { file, ...(created ? { created } : {}), ...recordChanges(earlier, changes, settingsBlock(read.data)) };
  if (!changes.length) return { text: `Claude Code's settings (${file}) point at the router already.`, pointed: true };
  writeSettings(file, read, `${file}.jev-router.bak`);
  const backup = read.exists ? ` The old file is ${file}.jev-router.bak.` : '';
  const names = inWords(changes.map((change) => change.name));
  return { text: `Claude Code's settings (${file}) now send it through the router: set ${names}.${backup}`, pointed: true };
}

/**
 * The manifest's record of Claude Code's settings after a run: earlier records whose variable still
 * holds what setup wrote, and this run's changes, with the value each replaced. The router token
 * isn't recorded, only that setup added its header line.
 * @param {Manifest['claude']} earlier
 * @param {SettingsChange[]} changes
 * @param {Record<string, string>} block the settings after this run
 * @returns {{ env: Record<string, { value: string, previous?: string }>, tokenHeader?: 'created' | 'added' }}
 */
function recordChanges(earlier, changes, block) {
  /** @type {Record<string, { value: string, previous?: string }>} */
  const records = Object.fromEntries(Object.entries(earlier?.env ?? {}).filter(([name, record]) => block[name] === record.value));
  let tokenHeader = earlier?.tokenHeader && hasTokenLine(block.ANTHROPIC_CUSTOM_HEADERS) ? earlier.tokenHeader : undefined;
  for (const { name, before, after } of changes) {
    if (after === undefined) continue;
    if (name === 'ANTHROPIC_CUSTOM_HEADERS') tokenHeader = tokenHeader === 'created' || before === undefined ? 'created' : 'added';
    else
      records[name] = records[name]
        ? { ...records[name], value: after }
        : { value: after, ...(before === undefined ? {} : { previous: before }) };
  }
  return tokenHeader ? { env: records, tokenHeader } : { env: records };
}

/**
 * Whether a header list carries a router token line.
 * @param {string | undefined} headers
 */
const hasTokenLine = (headers) =>
  (headers ?? '').split(/\r?\n/).some((line) => line.split(':', 1)[0].trim().toLowerCase() === TOKEN_HEADER);

/**
 * The command that works for this person: `jev-router` when it's installed on PATH, its path when
 * it's installed elsewhere, npx when this copy runs from npx, else this copy's own path.
 * @param {Plan} plan
 * @param {Command} [global] the global jev-router the service runs
 */
function commandForm(plan, global) {
  if (global) return global.onPath ? 'jev-router' : shellQuote(global.path);
  if (plan.installed) return 'jev-router';
  return plan.origin.npxCommand ?? shellQuote(packaged('bin/jev-router.mjs'));
}

/**
 * The summary for a machine without the service: setup is done, and launch is how to start.
 * @param {Plan} plan
 * @param {NodeJS.ProcessEnv} env
 */
function finishWithoutService(plan, env) {
  const run = commandForm(plan);
  const leftover = installedServices(env, readManifest(env)?.service)[0];
  say(
    `\nDone. There's no background service: ${plan.service.why}.\n` +
      `Start Claude Code through the router with: ${run} launch claude\n` +
      `Watch it live at http://127.0.0.1:${UI_PORT} with: ${run} launch claude --ui ${UI_PORT}\n` +
      `Check it: ${run} doctor\n`,
  );
  if (leftover)
    say(
      `The ${MANAGER_NAMES[leftover.manager]} from an earlier setup is still installed (${leftover.file}); ${run} uninstall removes it.\n`,
    );
  codexHint(plan, run, false);
  return 0;
}

/**
 * The summary once the service runs.
 * @param {Plan} plan
 * @param {Command} command the global jev-router the service runs
 * @param {{ text: string, pointed: boolean }} settings what happened to Claude Code's settings
 */
function finishWithService(plan, command, { text, pointed }) {
  const run = commandForm(plan, command);
  const ui = /** @type {{ host: string, port: number }} */ (parseUiAddress(plan.ui));
  say(`${text}\n`);
  if (pointed) say("Restart any Claude Code session that's already running, so it picks up the settings.\n");
  say(
    '\nDone. jev-router runs in the background and starts when you log in.\n' +
      `  Router     ${plan.url}\n` +
      `  Live view  http://${clientHost(ui.host)}:${ui.port}\n` +
      `  Keys       ${plan.envFile}\n` +
      `  Log        ${plan.logFile}\n\n` +
      (pointed ? 'Start Claude Code as usual: claude\n' : `Start Claude Code through the router with: ${run} launch claude\n`) +
      `Check it: ${run} doctor\n` +
      `Undo it: ${run} uninstall\n`,
  );
  if (plan.service.manager === 'systemd') say('To keep it running while you are logged out, run: loginctl enable-linger\n');
  codexHint(plan, run, true);
}

/**
 * Where Codex's keys go: setup asks only for Claude Code's.
 * @param {Plan} plan
 * @param {string} run
 * @param {boolean} service
 */
function codexHint(plan, run, service) {
  const saved = { ...plan.saved, ...plan.keys };
  const missing = [...upstreamKeys(plan.cfg, 'openai').keys()].filter((name) => !saved[name]);
  if (!missing.length) {
    say(`Codex: ${run} launch codex\n`);
    return;
  }
  const restart = service ? `, run ${run} setup again to restart the router with ${missing.length > 1 ? 'them' : 'it'},` : '';
  say(`Codex: put ${inWords(missing)} in ${plan.envFile}${restart} then run: ${run} launch codex\n`);
}

/**
 * The manifest setup wrote, if any.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Manifest | undefined}
 */
export function readManifest(env) {
  try {
    const manifest = JSON.parse(readFileSync(setupManifestPath(env), 'utf8'));
    return typeof manifest === 'object' && manifest !== null ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Manifest} manifest
 */
function writeManifest(env, manifest) {
  const note = 'Written by jev-router setup: what it changed, for jev-router uninstall. It holds no keys.';
  writeFileAtomic(setupManifestPath(env), `${JSON.stringify({ note, ...manifest }, null, 2)}\n`, 0o600);
}

/**
 * `jev-router uninstall`: stops and removes the service, takes back what setup put into Claude
 * Code's settings, and keeps the config, the keys and the logs. Running it twice is fine.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
export async function runUninstall(env) {
  try {
    loadEnvFile(undefined, env); // JEV_ROUTER_HOST and JEV_ROUTER_PORT, to tell the router's base URL
  } catch {
    // an env file that can't be read changes nothing here
  }
  const manifest = readManifest(env);
  let failed = !undoSettings(manifest, env);
  const services = installedServices(env, manifest?.service);
  for (const { manager, file } of services) {
    const problems = stopService(manager, file, env);
    say(`Stopped and removed the ${MANAGER_NAMES[manager]} ${file}.\n`);
    for (const problem of problems) say(`  ${problem}\n`);
    failed ||= problems.length > 0;
  }
  if (!services.length) say('No background service is installed.\n');
  rmSync(setupManifestPath(env), { force: true });
  keptFiles(manifest, env);
  return failed ? 1 : 0;
}

/**
 * Takes setup's variables back out of Claude Code's settings: what the manifest recorded, where the
 * value is still the one setup wrote; without a manifest, only a base URL that points at the router
 * and gateway settings that hold exactly setup's values.
 * @param {Manifest | undefined} manifest
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} false when the settings file couldn't be changed
 */
function undoSettings(manifest, env) {
  const file = manifest?.claude?.file ?? claudeSettingsPath(env);
  const read = readSettings(file);
  if ('problem' in read) {
    say(
      `Couldn't change ${file}: ${read.problem}. If it points Claude Code at the router, remove ANTHROPIC_BASE_URL from its "env" block yourself.\n`,
    );
    return false;
  }
  const block = settingsBlock(read.data);
  const values = manifest?.claude ? recordedValues(manifest.claude, block) : guessedValues(block, env);
  const changes = changeSettingsEnv(read.data, values);
  if (!changes.length) {
    say(`Claude Code's settings (${file}) have nothing from setup.\n`);
    return true;
  }
  if (manifest?.claude?.created && !Object.keys(read.data).length) {
    rmSync(file, { force: true });
    say(`Removed ${file}, which setup had created. Restart any Claude Code session that's running.\n`);
    return true;
  }
  writeSettings(file, read, `${file}.jev-router.bak`);
  const restored = changes.filter((c) => c.after !== undefined).map((c) => c.name);
  const removed = changes.filter((c) => c.after === undefined).map((c) => c.name);
  say(
    `Claude Code's settings (${file}): ${[removed.length ? `removed ${inWords(removed)}` : '', restored.length ? `restored ${inWords(restored)}` : ''].filter(Boolean).join('; ')}. ` +
      `The old file is ${file}.jev-router.bak. Restart any Claude Code session that's running.\n`,
  );
  return true;
}

/**
 * The settings to set or remove to undo what the manifest recorded.
 * @param {NonNullable<Manifest['claude']>} record
 * @param {Record<string, string>} block
 * @returns {Record<string, string | undefined>}
 */
function recordedValues(record, block) {
  /** @type {Record<string, string | undefined>} */
  const values = {};
  for (const [name, { value, previous }] of Object.entries(record.env ?? {})) if (block[name] === value) values[name] = previous;
  if (record.tokenHeader && hasTokenLine(block.ANTHROPIC_CUSTOM_HEADERS))
    values.ANTHROPIC_CUSTOM_HEADERS = withoutHeader(block.ANTHROPIC_CUSTOM_HEADERS, TOKEN_HEADER).join('\n') || undefined;
  return values;
}

/**
 * Without a manifest: a base URL that points at the router goes, and so do the gateway settings
 * when they hold exactly setup's values and no other gateway is set.
 * @param {Record<string, string>} block
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string | undefined>}
 */
function guessedValues(block, env) {
  let cfg = { host: '127.0.0.1', port: 4000 };
  try {
    cfg = loadConfig(configFile(undefined, env).path);
  } catch {
    // the default address is the best guess left
  }
  const base = block.ANTHROPIC_BASE_URL;
  const ours = base !== undefined && pointsAtRouter(base, cfg, env);
  if (base !== undefined && !ours) return {};
  /** @type {Record<string, string | undefined>} */
  const values = ours ? { ANTHROPIC_BASE_URL: undefined } : {};
  for (const [name, [wanted]] of Object.entries(CLAUDE_SETTINGS)) if (block[name] === wanted) values[name] = undefined;
  if (hasTokenLine(block.ANTHROPIC_CUSTOM_HEADERS))
    values.ANTHROPIC_CUSTOM_HEADERS = withoutHeader(block.ANTHROPIC_CUSTOM_HEADERS, TOKEN_HEADER).join('\n') || undefined;
  return values;
}

/**
 * Says what uninstall kept, and how to remove it and the command.
 * @param {Manifest | undefined} manifest
 * @param {NodeJS.ProcessEnv} env
 */
function keptFiles(manifest, env) {
  const configDir = dirname(userConfigPath(env));
  const stateDir = dirname(routerLogPath(env));
  const files = [manifest?.files?.config, manifest?.files?.env ?? envFilePath(env), manifest?.files?.log].filter(
    /** @returns {file is string} */ (file) => typeof file === 'string',
  );
  const outside = files.filter((file) => !file.startsWith(`${configDir}/`) && !file.startsWith(`${stateDir}/`));
  const all = [configDir, stateDir, ...new Set(outside)].filter((path) => existsSync(path));
  if (all.length)
    say(
      `\nKept your config, keys and logs:\n${all.map((path) => `  ${path}\n`).join('')}` +
        `To delete them too: rm -rf ${all.map(shellQuote).join(' ')}\n`,
    );
  say(`Last step, to remove the jev-router command: npm uninstall -g ${PACKAGE}\n`);
}
