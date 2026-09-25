// The background service that `jev-router setup` installs and `jev-router uninstall` removes: a
// launchd agent on macOS, a systemd user unit on Linux. Both are written from the templates in
// examples/service/, the manual route the docs describe, so the two stay the same service.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { findProgram, hasControlCharacter, packaged, shellQuote, writeFileAtomic, xdgDir } from './files.mjs';

/** @typedef {'launchd' | 'systemd'} Manager */

/** The launchd label, which follows the GitHub owner. */
export const LABEL = 'io.github.dirien.jev-router';
const UNIT = 'jev-router';
/** @type {Record<Manager, string>} */
const TEMPLATES = {
  launchd: packaged(`examples/service/launchd/${LABEL}.plist`),
  systemd: packaged('examples/service/systemd/jev-router.service'),
};
/** @type {Record<Manager, string>} */
export const MANAGER_NAMES = { launchd: 'launchd agent', systemd: 'systemd user unit' };
/** The arguments that name files: the templates quote them, as paths may hold spaces. */
const PATH_OPTIONS = new Set(['--config', '--env-file', '--log-file']);
const WRITTEN_BY = 'Written by `jev-router setup`, which rewrites it on every run; `jev-router uninstall` removes it.';

/**
 * Where a manager looks for the service's file. systemd's user manager looks under its own
 * XDG_CONFIG_HOME, which needn't be the shell's.
 * @param {Manager} manager
 * @param {string} [configHome] the user manager's XDG_CONFIG_HOME; ~/.config when it has none
 */
export function serviceFile(manager, configHome) {
  return manager === 'launchd'
    ? join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
    : join(configHome ?? join(homedir(), '.config'), 'systemd', 'user', `${UNIT}.service`);
}

/** Where launchd writes the router's messages for people. */
export const launchdErrorLog = () => join(homedir(), 'Library', 'Logs', 'jev-router', 'router.err.log');

/**
 * Where to look when the service doesn't start.
 * @param {Manager} manager
 */
export const logHint = (manager) => (manager === 'launchd' ? launchdErrorLog() : `journalctl --user -u ${UNIT}`);

/**
 * @typedef {object} ManagerChoice
 * @property {Manager} [manager] unset when there is none
 * @property {string} why why there is none
 * @property {string} [configHome] where systemd's user manager looks for units, when it says
 */

/**
 * The service manager setup can use.
 * @param {'auto' | Manager | 'none'} wanted `--service`
 * @param {NodeJS.ProcessEnv} env
 * @returns {ManagerChoice}
 */
export function chooseManager(wanted, env) {
  if (wanted === 'none') return { why: 'you passed --service none' };
  if (wanted === 'launchd' || (wanted === 'auto' && process.platform === 'darwin')) {
    const problem = launchdProblem(env);
    return problem ? { why: problem } : { manager: 'launchd', why: '' };
  }
  if (wanted === 'auto' && process.platform === 'win32') return { why: 'Windows has neither launchd nor systemd' };
  if (wanted === 'auto' && process.getuid?.() === 0) return { why: 'setup runs as root, and a service for root is not set up here' };
  const user = systemdUser(env);
  return 'why' in user ? user : { manager: 'systemd', why: '', configHome: user.configHome };
}

/**
 * Why launchd can't run an agent here, if it can't: no launchctl, or no GUI login session to run it
 * in, as over SSH.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function launchdProblem(env) {
  const launchctl = findProgram('launchctl', env);
  if (!launchctl) return "launchctl isn't on PATH";
  const check = spawnSync(launchctl, ['print', `gui/${process.getuid?.()}`], { env, stdio: 'ignore', timeout: 10000 });
  return check.status === 0 ? undefined : "there's no GUI login session here (for example over SSH), so launchd can't run an agent";
}

/**
 * The systemd user manager: why there's none to talk to (no systemctl, or no user session, as in
 * most containers), or the XDG_CONFIG_HOME it looks for units under.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ why: string } | { configHome?: string }}
 */
function systemdUser(env) {
  const systemctl = findProgram('systemctl', env);
  if (!systemctl) return { why: "there's no systemd here (systemctl isn't on PATH)" };
  const shown = spawnSync(systemctl, ['--user', 'show-environment'], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10000,
  });
  if (shown.status !== 0) return { why: "there's no systemd user session here (systemctl --user doesn't answer)" };
  const configHome = /^XDG_CONFIG_HOME=(.+)$/m.exec(shown.stdout)?.[1];
  return configHome && isAbsolute(configHome) ? { configHome } : {};
}

/**
 * The service files found where the managers look, where the shell's XDG_CONFIG_HOME would put
 * the unit, and where a manifest recorded one.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ manager: Manager, file: string }} [recorded]
 * @returns {Array<{ manager: Manager, file: string }>}
 */
export function installedServices(env, recorded) {
  const user = findProgram('systemctl', env) ? systemdUser(env) : {};
  /** @type {Array<{ manager: Manager, file: string }>} */
  const places = [
    ...(recorded ? [recorded] : []),
    { manager: 'launchd', file: serviceFile('launchd') },
    { manager: 'systemd', file: serviceFile('systemd', 'configHome' in user ? user.configHome : undefined) },
    { manager: 'systemd', file: serviceFile('systemd', xdgDir(env, 'XDG_CONFIG_HOME', '.config')) },
  ];
  const files = new Set();
  return places.filter((place) => !files.has(place.file) && files.add(place.file) && existsSync(place.file));
}

/**
 * The service file for `serve` with `args`, from the packaged template: the arguments replace the
 * template's, and PATH and the home directory are filled in.
 * @param {Manager} manager
 * @param {{ args: string[], path: string }} service `args` start with /usr/bin/env jev-router serve
 * @returns {string}
 */
export function renderService(manager, { args, path }) {
  const odd = [...args, path].find(hasControlCharacter);
  if (odd !== undefined) throw new Error(`a service file can't hold ${JSON.stringify(odd)}: it has a control character`);
  const template = readFileSync(TEMPLATES[manager], 'utf8');
  const text = manager === 'launchd' ? renderPlist(template, args, path) : renderUnit(template, args, path);
  const left = /@[A-Z]+@/.exec(text);
  if (left) throw new Error(`the ${manager} template still has ${left[0]} after filling it in`);
  return text;
}

/**
 * @param {string} template
 * @param {string[]} args
 * @param {string} path
 */
function renderPlist(template, args, path) {
  const strings = args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  return replaceOnce(
    replaceOnce(template, /<!--[\s\S]*?-->\n/, `<!-- ${WRITTEN_BY} -->\n`),
    /(<key>ProgramArguments<\/key>\n\s*<array>\n)[\s\S]*?\n(\s*<\/array>)/,
    (_all, open, close) => `${open}${strings}\n${close}`,
  )
    .replaceAll('@PATH@', () => xml(path)) // a function: $& or $' in a path isn't a pattern
    .replaceAll('@HOME@', () => xml(homedir()));
}

/**
 * @param {string} template
 * @param {string[]} args
 * @param {string} path
 */
function renderUnit(template, args, path) {
  const words = args.map((arg, i) => systemdWord(arg, PATH_OPTIONS.has(args[i - 1] ?? '')));
  const unit = replaceOnce(template, /^(?:#.*\n)+\n?/, `# ${WRITTEN_BY}\n\n`);
  return replaceOnce(
    replaceOnce(unit, /^ExecStart=.*$/m, `ExecStart=${words.join(' ')}`),
    '"PATH=@PATH@"',
    `"PATH=${systemdEscape(path)}"`,
  );
}

/**
 * Replaces the one match of `pattern`, which must be there.
 * @param {string} text
 * @param {string | RegExp} pattern
 * @param {string | ((match: string, ...groups: string[]) => string)} replacement
 */
function replaceOnce(text, pattern, replacement) {
  const found = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
  if (!found) throw new Error(`the service template has changed: ${pattern} isn't in it`);
  // A function replacement keeps `$` in paths from being read as a group reference.
  return typeof replacement === 'string' ? text.replace(pattern, () => replacement) : text.replace(pattern, replacement);
}

/** @param {string} text */
const xml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/**
 * A value inside systemd's double quotes: C escapes for \ and ", and %% for a % that isn't a specifier.
 * @param {string} text
 */
const systemdEscape = (text) => text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
/**
 * One word of ExecStart: quoted when it's a path or needs it, and with $ doubled, as systemd would expand it.
 * @param {string} word
 * @param {boolean} quote
 */
function systemdWord(word, quote) {
  if (!quote && /^[\w@+=:,./-]+$/.test(word)) return word;
  return `"${systemdEscape(word).replaceAll('$', '$$$$')}"`;
}

/**
 * @typedef {{ ok: boolean, output: string }} Ran
 */
/**
 * Runs a service manager's command and keeps what it said.
 * @param {string} program
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Ran}
 */
function runManager(program, args, env) {
  const result = spawnSync(program, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim() || (result.error?.message ?? '');
  return { ok: result.status === 0, output };
}

/**
 * Writes the service file and (re)starts the service: launchd unloads the agent and loads it again,
 * systemd reloads its units, enables this one and restarts it, so new keys take effect.
 * @param {Manager} manager
 * @param {string} file
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 * @param {{ launchdWaitMs?: number }} [options] how long launchd may take to unload the old agent: the
 *   router drains for up to 30 s, and the agent's ExitTimeOut is 35 s
 */
export async function startService(manager, file, text, env, { launchdWaitMs = 45000 } = {}) {
  const program = findProgram(manager === 'launchd' ? 'launchctl' : 'systemctl', env);
  if (!program) throw new Error(`${manager === 'launchd' ? 'launchctl' : 'systemctl'} isn't on PATH`);
  writeFileAtomic(file, text, 0o644);
  if (manager === 'systemd') {
    for (const args of [
      ['--user', 'daemon-reload'],
      ['--user', 'enable', UNIT],
      ['--user', 'restart', UNIT],
    ]) {
      const ran = runManager(program, args, env);
      if (!ran.ok) throw new Error(`systemctl ${args.join(' ')} failed${ran.output ? `: ${ran.output}` : ''}`);
    }
    return;
  }
  const domain = `gui/${process.getuid?.()}`;
  runManager(program, ['bootout', `${domain}/${LABEL}`], env); // fails when it isn't loaded, which is fine
  // launchd refuses to load the agent again while the old router still drains its requests.
  const deadline = Date.now() + launchdWaitMs;
  for (;;) {
    const ran = runManager(program, ['bootstrap', domain, file], env);
    if (ran.ok) return;
    if (Date.now() >= deadline)
      throw new Error(
        `launchd didn't load the agent again within ${Math.round(launchdWaitMs / 1000)} s${ran.output ? ` (${ran.output})` : ''}. ` +
          `It is unloaded now, so jev-router doesn't run. Load it with:\n  launchctl bootstrap ${domain} ${shellQuote(file)}`,
      );
    await sleep(1000);
  }
}

/**
 * Stops the service, keeps it from starting again, and removes its file.
 * @param {Manager} manager
 * @param {string} file
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} what went wrong, for the person to finish by hand
 */
export function stopService(manager, file, env) {
  const program = findProgram(manager === 'launchd' ? 'launchctl' : 'systemctl', env);
  /** @type {string[]} */
  const problems = [];
  if (manager === 'launchd' && program) runManager(program, ['bootout', `gui/${process.getuid?.()}/${LABEL}`], env);
  if (manager === 'systemd' && program) {
    const ran = runManager(program, ['--user', 'disable', '--now', UNIT], env);
    if (!ran.ok) problems.push(`systemctl --user disable --now ${UNIT} failed${ran.output ? `: ${ran.output}` : ''}`);
  }
  rmSync(file, { force: true });
  if (manager === 'systemd' && program) runManager(program, ['--user', 'daemon-reload'], env);
  return problems;
}
