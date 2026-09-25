// The background service that `jev-router setup` installs and `jev-router uninstall` removes: a
// launchd agent on macOS, a systemd user unit on Linux. Both are written from the templates in
// examples/service/, the manual route the docs describe, so the two stay the same service.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { findProgram, packaged, writeFileAtomic, xdgDir } from './files.mjs';

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
 * Where a manager looks for the service's file.
 * @param {Manager} manager
 * @param {NodeJS.ProcessEnv} env
 */
export function serviceFile(manager, env) {
  return manager === 'launchd'
    ? join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
    : join(xdgDir(env, 'XDG_CONFIG_HOME', '.config'), 'systemd', 'user', `${UNIT}.service`);
}

/** Where launchd writes the router's messages for people. */
export const launchdErrorLog = () => join(homedir(), 'Library', 'Logs', 'jev-router', 'router.err.log');

/**
 * Where to look when the service doesn't start.
 * @param {Manager} manager
 */
export const logHint = (manager) => (manager === 'launchd' ? launchdErrorLog() : `journalctl --user -u ${UNIT}`);

/**
 * The service manager setup can use.
 * @param {'auto' | Manager | 'none'} wanted `--service`
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ manager?: Manager, why: string }} `why` says why there is none
 */
export function chooseManager(wanted, env) {
  if (wanted === 'none') return { why: 'you passed --service none' };
  if (wanted === 'launchd' || (wanted === 'auto' && process.platform === 'darwin')) {
    return findProgram('launchctl', env) ? { manager: 'launchd', why: '' } : { why: "launchctl isn't on PATH" };
  }
  if (wanted === 'auto' && process.platform === 'win32') return { why: 'Windows has neither launchd nor systemd' };
  if (wanted === 'auto' && process.getuid?.() === 0) return { why: 'setup runs as root, and a service for root is not set up here' };
  const problem = systemdProblem(env);
  return problem ? { why: problem } : { manager: 'systemd', why: '' };
}

/**
 * Why systemd can't run a user service here, if it can't: no systemctl, or no user manager to
 * talk to, as in most containers.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function systemdProblem(env) {
  const systemctl = findProgram('systemctl', env);
  if (!systemctl) return "there's no systemd here (systemctl isn't on PATH)";
  const check = spawnSync(systemctl, ['--user', 'show-environment'], { env, stdio: 'ignore', timeout: 10000 });
  return check.status === 0 ? undefined : "there's no systemd user session here (systemctl --user doesn't answer)";
}

/**
 * The service files found in the managers' places, and one a manifest recorded elsewhere.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ manager: Manager, file: string }} [recorded]
 * @returns {Array<{ manager: Manager, file: string }>}
 */
export function installedServices(env, recorded) {
  /** @type {Array<{ manager: Manager, file: string }>} */
  const places = [
    { manager: 'launchd', file: serviceFile('launchd', env) },
    { manager: 'systemd', file: serviceFile('systemd', env) },
  ];
  if (recorded && !places.some((place) => place.file === recorded.file)) places.push(recorded);
  return places.filter((place) => existsSync(place.file));
}

/**
 * The service file for `serve` with `args`, from the packaged template: the arguments replace the
 * template's, and PATH and the home directory are filled in.
 * @param {Manager} manager
 * @param {{ args: string[], path: string }} service `args` start with /usr/bin/env jev-router serve
 * @returns {string}
 */
export function renderService(manager, { args, path }) {
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
    .replaceAll('@PATH@', xml(path))
    .replaceAll('@HOME@', xml(homedir()));
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
 */
export async function startService(manager, file, text, env) {
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
  // launchd can still be tearing down the old instance, and refuses to load it again until it's gone.
  for (let attempt = 1; ; attempt += 1) {
    const ran = runManager(program, ['bootstrap', domain, file], env);
    if (ran.ok) return;
    if (attempt === 10) throw new Error(`launchctl bootstrap ${domain} ${file} failed${ran.output ? `: ${ran.output}` : ''}`);
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
